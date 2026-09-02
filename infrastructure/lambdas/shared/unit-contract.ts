/**
 * The unit contract: what a quantity counts, what AWS charges for, and whether the two
 * can be multiplied together.
 *
 * Why this exists. Until now the pricing layer decided how to use a rate with a two-way
 * branch: if the AWS Price List called the unit "GB-Mo" it treated the quantity as
 * gigabytes, and OTHERWISE it assumed the rate was hourly and multiplied it by 730. There
 * was no third case. So a per-request rate, a per-invocation rate, a GB-second rate or a
 * Fargate vCPU-hour rate all silently became "price x 730 hours", and the report printed a
 * confident number with a workings line that read `$0.04/Requests x 730 hrs/month`. Nobody
 * was warned, because nothing compared the two units.
 *
 * That is not a hypothetical. It is the same failure a user hit building an estimate by
 * hand: ten Fargate tasks priced per month instead of per day, and a runtime given as 1440
 * minutes where the calculator wanted 730 hours. Both are a quantity meeting a rate that
 * measures something else.
 *
 * The contract here replaces the assumption with a lookup, and — this is the whole point —
 * **refuses by default**. If a canonical unit cannot be reconciled with the unit AWS
 * actually published, `reconcile` returns a refusal carrying a sentence fit to print,
 * instead of a multiplier. An unpriced line that says why is recoverable: someone reads it
 * and fixes the mapping. A line priced 730x too high is not, because it looks finished.
 *
 * Two deliberate non-goals:
 *
 *  - This module is not a units library. It knows the handful of dimensions AWS bills on
 *    and nothing else. Generality here would mean guessing, and guessing is the defect.
 *  - It never reads a rate or a price. It answers "may these two be multiplied, and by
 *    what factor", so it stays pure and exhaustively testable without a network call.
 *
 * Everything is normalised to a MONTH before it arrives. A reader that finds a per-year
 * figure divides by twelve and says so; this module assumes monthly quantities and only
 * bridges the remaining mismatch of dimension and scale.
 */

/**
 * What a canonical resource row is billed on.
 *
 * The discriminator the old code lacked. A row that declares itself `instance` is priced by
 * runtime hours; a `usage` row is priced per unit consumed. Previously both looked
 * identical to the pricer, which is why it had to guess from the rate's unit — inferring
 * the question from the answer.
 */
export type BillingKind = 'instance' | 'usage' | 'storage' | 'excluded';

/**
 * The canonical monthly dimensions. One entry per thing AWS actually meters.
 *
 * `units/month` is the escape hatch for a countable with no richer meaning — billable
 * monthly active users, provisioned capacity units — and it is deliberately the strictest
 * of the lot: it only reconciles against an AWS unit that is itself a bare count, so it
 * cannot quietly stand in for hours.
 */
export type CanonicalUnit =
  | 'hours/month'
  | 'GB/month'
  | 'GB-transfer/month'
  | 'requests/month'
  | 'invocations/month'
  | 'GB-seconds/month'
  | 'vCPU-hours/month'
  | 'GB-hours/month'
  | 'IOPS/month'
  | 'units/month';

/** Hours in a billing month. AWS bills 730 on a 24x7 resource; the year is 8760. */
export const HOURS_PER_MONTH = 730;

/** Months in a year, for the per-year figures a capacity model states. */
export const MONTHS_PER_YEAR = 12;

/**
 * A reconciliation that succeeded.
 *
 * `multiplier` converts the canonical quantity into the number of AWS units billed in a
 * month, so `monthly = ratePerUnit * multiplier * quantity`. It is 1 whenever the two
 * units already agree, which is the common case; it is not 1 when AWS prices in blocks
 * (per 1,000 requests, per 1M invocations) or when an hourly rate has to be spread across
 * the month.
 */
export interface UnitMatch {
  ok: true;
  multiplier: number;
  /** How the factor was arrived at, for the report's workings line. */
  explanation: string;
}

/** A reconciliation that failed, carrying prose a client may read. */
export interface UnitRefusal {
  ok: false;
  reason: string;
}

export type Reconciliation = UnitMatch | UnitRefusal;

/**
 * Collapses an AWS unit string to a comparable token.
 *
 * The Price List is not consistent: the same dimension appears as "Hrs", "Hours", "hours"
 * and "Hrs." across services, and compound units arrive as "GB-Mo", "GB-month" and
 * "GB-Mo.". Lowercasing and dropping everything that is not a letter or a digit makes
 * those one token each without a per-service table.
 */
function token(unit: string): string {
  return String(unit || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The block size baked into an AWS unit string, if there is one.
 *
 * AWS prices some dimensions per block rather than per item — "1M Requests",
 * "10K Requests", "1,000 IOPs". Multiplying a per-block rate by an item count overstates
 * the bill by the block size, which for 1M Requests is six orders of magnitude, so this is
 * not a rounding concern. Returns 1 when the unit names no block, which is the usual case.
 */
export function blockSize(unit: string): number {
  const text = String(unit || '').toLowerCase().replace(/,/g, '');
  const scaled = /(\d+(?:\.\d+)?)\s*(k|m|b)\b/.exec(text);
  if (scaled) {
    const base = Number(scaled[1]);
    const factor = scaled[2] === 'k' ? 1e3 : scaled[2] === 'm' ? 1e6 : 1e9;
    return base * factor;
  }
  const plain = /\b(\d{3,})\b/.exec(text);
  if (plain) return Number(plain[1]);
  return 1;
}

/**
 * Which AWS unit tokens each canonical dimension will accept.
 *
 * Membership is the entire safety property, so every entry is here because a real Price
 * List response used that spelling — not because it seemed plausible. Adding a spelling is
 * cheap and safe; the failure mode of a missing one is an unpriced line with a reason,
 * which someone notices.
 */
const ACCEPTED: Record<CanonicalUnit, string[]> = {
  // An hourly rate is the one case where the quantity and the rate measure different
  // things on purpose: the quantity is hours already, so the factor is 1 and the month
  // length lives in whoever computed those hours.
  'hours/month': ['hrs', 'hours', 'hour', 'hr', 'instancehours', 'instancehour'],
  'GB/month': ['gbmo', 'gbmonth', 'gbmos', 'gigabytemonth', 'gbmonths'],
  // Data transfer is billed per GB moved, NOT per GB held, and the two are different
  // rates on the same service. Keeping them apart stops a transfer figure being priced as
  // storage, which reads plausible and is wrong every month.
  'GB-transfer/month': ['gb', 'gbs', 'gigabytes', 'gbout', 'gbdatatransfer'],
  'requests/month': ['requests', 'request', 'req', 'apicalls', 'apicall', 'apirequests', 'calls'],
  'invocations/month': ['requests', 'request', 'invocations', 'invocation'],
  'GB-seconds/month': ['lambdagbsecond', 'gbseconds', 'gbsecond', 'gbsec'],
  'vCPU-hours/month': ['vcpuhours', 'vcpuhour', 'cpuhours', 'cpuhour', 'vcpuhrs'],
  'GB-hours/month': ['gbhours', 'gbhour', 'gbhrs'],
  'IOPS/month': ['iopsmo', 'iopsmonth', 'iops'],
  // Bare counts only. Notably absent: every hour spelling, so a countable can never be
  // multiplied by a runtime.
  'units/month': ['quantity', 'count', 'units', 'unit', 'mau', 'users', 'user', 'each'],
};

/** Human wording for each canonical unit, for refusal prose and workings lines. */
const DESCRIPTION: Record<CanonicalUnit, string> = {
  'hours/month': 'runtime hours per month',
  'GB/month': 'gigabytes stored per month',
  'GB-transfer/month': 'gigabytes transferred per month',
  'requests/month': 'requests per month',
  'invocations/month': 'invocations per month',
  'GB-seconds/month': 'GB-seconds per month',
  'vCPU-hours/month': 'vCPU-hours per month',
  'GB-hours/month': 'GB-hours per month',
  'IOPS/month': 'provisioned IOPS per month',
  'units/month': 'billable units per month',
};

export function describeUnit(unit: CanonicalUnit): string {
  return DESCRIPTION[unit];
}

/**
 * May a quantity measured in `canonical` be multiplied by a rate AWS publishes per
 * `awsUnit`, and by what factor?
 *
 * The only way to get a multiplier is to be on the accept list for that dimension. There
 * is no default case and no fallback to hours: an unrecognised pairing is a refusal. That
 * asymmetry is deliberate — the cost of a refusal is a line item that says it could not be
 * priced, and the cost of a wrong assumption is a number that is confidently wrong by
 * whatever factor separates the two dimensions.
 */
export function reconcile(canonical: CanonicalUnit, awsUnit: string): Reconciliation {
  const seen = token(awsUnit);
  if (!seen) {
    return {
      ok: false,
      reason: 'AWS published no unit for this rate, so the quantity could not be matched to it. '
        + 'The line is left unpriced rather than assumed.',
    };
  }

  const accepted = ACCEPTED[canonical];
  const block = blockSize(awsUnit);
  // A block-priced unit such as "1M Requests" carries digits the accept list does not, so
  // the block has to come off before the comparison. Stripping is conditional on a block
  // having actually been found, and that condition is load-bearing: stripping digits
  // unconditionally would make the accept lists fuzzy in the one direction they must not
  // be, quietly letting a unit like "100 GB" pass as plain "GB". The lists are the entire
  // safety property, so nothing may widen them as a side effect.
  const comparable = block > 1 ? seen.replace(/\d+(k|m|b)?/g, '') : seen;
  if (!accepted.includes(comparable)) {
    return {
      ok: false,
      reason: `This line counts ${DESCRIPTION[canonical]}, but AWS prices it per "${awsUnit}". `
        + 'Those measure different things, so the two were not multiplied together and the '
        + 'line is left unpriced. Pricing it anyway would produce a number that looks '
        + 'complete and is wrong.',
    };
  }

  if (block > 1) {
    return {
      ok: true,
      multiplier: 1 / block,
      explanation: `AWS prices this per ${block.toLocaleString('en-US')} ${DESCRIPTION[canonical]
        .replace(/ per month$/, '')}, so the monthly quantity is divided by ${block.toLocaleString('en-US')}`,
    };
  }

  return { ok: true, multiplier: 1, explanation: `quantity and AWS rate are both in ${awsUnit}` };
}

/**
 * The canonical unit an `instance` row is always billed on.
 *
 * Split out because it is the one dimension the pricer may assume: a row that declares
 * itself an instance has said, in the canonical format, that it is billed by runtime. The
 * assumption is then the row's, made explicitly, rather than the pricer's, made silently.
 */
export const INSTANCE_UNIT: CanonicalUnit = 'hours/month';

/**
 * Runtime hours a month for a resource that runs `hoursPerDay` a day.
 *
 * Clamped rather than trusted. A sheet that says 25 hours a day has a data-entry error, and
 * honouring it would inflate every downstream figure. Zero returns zero rather than being
 * nudged up to some minimum: a row that runs no hours is a quantity question, not a rate
 * question, and it belongs on the exclusion list where a reader will see it — quietly
 * pricing it as if it ran would hide the thing worth noticing. Negatives, NaN and
 * non-numeric text all land on that same zero, which is the safe direction to fail, since a
 * negative here would produce a negative line item and reduce the total.
 */
export function hoursFromPerDay(hoursPerDay: number): number {
  const clamped = Math.min(24, Math.max(0, Number(hoursPerDay) || 0));
  return Math.round(HOURS_PER_MONTH * (clamped / 24) * 100) / 100;
}

/**
 * Converts a per-year figure to a per-month one, reporting the conversion.
 *
 * Returned alongside the number rather than applied quietly, because a silent divide by
 * twelve is indistinguishable from a reader that never noticed the "/yr" in the label —
 * and those two have opposite fixes.
 */
export function perYearToPerMonth(amount: number): { amount: number; conversion: string } {
  return {
    amount: amount / MONTHS_PER_YEAR,
    conversion: 'per-year figure divided by 12 to a monthly basis',
  };
}
