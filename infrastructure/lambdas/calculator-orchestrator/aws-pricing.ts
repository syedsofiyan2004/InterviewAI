import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

import { HOURS_PER_MONTH } from '../shared/unit-contract';
import { termLabelOf as sharedTermLabelOf } from '../shared/pricing-models';

/**
 * AWS Price List lookups for the Cost Calculator.
 *
 * Why this exists: the pricing-calculator MCP server saves an estimate to
 * calculator.aws and returns a shareable link, but the stored estimate holds no
 * money — `import_estimate` reads back configuration with an empty
 * `groupSubtotal`, because calculator.aws computes pricing in the browser when a
 * human opens the link. Verified directly against a real saved estimate. So the
 * link is authoritative for a person, and useless for a document.
 *
 * The Price List Query API is the supported, documented source of published AWS
 * rates. Asking it for a rate and multiplying by the hours a resource actually runs
 * is arithmetic we can show our working for — which is what makes a cost figure
 * defensible in front of a client, and what lets the runtime-hours feature mean
 * anything at all.
 *
 * The API is global and only answers in us-east-1 regardless of which region is
 * being priced.
 */

/**
 * Adaptive retry, and a lot of attempts.
 *
 * The Price List API throttles hard. A live run of the 110-machine workbook issued 105
 * lookups and one came back "Rate exceeded", which dropped a machine out of the estimate
 * entirely — the total silently understated the bill by one server. Since the estimate's
 * whole value is that its arithmetic is complete and checkable, a transient throttle has
 * to cost a few hundred milliseconds, never a line item.
 *
 * Adaptive mode also client-side rate-limits itself once it sees a throttle, which is
 * what stops a burst of parallel lookups from throttling each other repeatedly.
 */
const pricing = new PricingClient({
  region: 'us-east-1',
  maxAttempts: 8,
  retryMode: 'adaptive',
});

/** Throttling, as the Pricing API spells it — the message matters, not just the name. */
function isThrottle(error: unknown): boolean {
  const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const text = `${failure?.name || ''} ${failure?.message || ''}`.toLowerCase();
  return failure?.$metadata?.httpStatusCode === 429
    || /throttl|rate exceeded|too many requests|limit exceeded|slow down/.test(text);
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Sends a Price List query, retrying past a throttle the SDK's own attempts did not clear.
 *
 * A second line of defence on top of `maxAttempts` above, with full jitter so parallel
 * lookups that were throttled together do not come back in lockstep and throttle again.
 */
async function sendWithRetry(command: GetProductsCommand): Promise<any> {
  const attempts = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await pricing.send(command);
    } catch (error) {
      lastError = error;
      if (!isThrottle(error)) throw error;
      // Full jitter, so lookups throttled together do not come back in lockstep and
      // throttle again. No wait after the final attempt — there is nothing left to wait for.
      if (attempt < attempts - 1) await sleep(Math.random() * Math.min(1_600, 200 * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Hours in a billing month, as AWS defines it.
 *
 * Not 24 x 30.44 (= 730.56). AWS and the Pricing Calculator both treat a month as
 * exactly 730 hours, and partial-day usage as a percentage of that. Using days
 * would put our always-on figures 0.56 hours above the AWS link's — small, but it
 * compounds across an estimate, and a client comparing the PDF to the calculator
 * should not find a discrepancy to ask about.
 *
 * Partial days scale proportionally: 8h/day is 730 x 8/24 = 243.33 hours.
 *
 * Re-exported from the unit contract rather than declared twice. Two independent 730s in
 * one codebase is a number waiting to drift, and if they ever did, the estimate and the
 * shareable link it is compared against would disagree by an amount too small to notice
 * and too systematic to dismiss — which is the exact discrepancy the paragraph above
 * exists to prevent. The reasoning stays here because this is where a reader looks for it.
 */
export { HOURS_PER_MONTH } from '../shared/unit-contract';

/**
 * A commitment to price against, instead of on-demand.
 *
 * Load-bearing for accuracy, not a refinement. A real migration model commits most of
 * its steady-state fleet: on the worked example the majority of rows are "3-Yr No
 * Upfront", and m6a.xlarge/Linux in eu-central-1 is $0.2064/hr on-demand against
 * $0.0939/hr on a 3-year standard RI. Quoting on-demand for those rows overstates the
 * bill by more than double — which is not a rounding difference, it is the wrong answer.
 */
export interface PriceTerm {
  /** Commitment length. The Price List publishes only 1yr and 3yr. */
  years: 1 | 3;
  /** How much is paid up front. Partial and All carry a separate upfront dimension. */
  purchase: 'No Upfront' | 'Partial Upfront' | 'All Upfront';
  /**
   * Standard is cheaper; convertible buys the right to change instance family later.
   * Defaults to standard, because that is what a "3-Yr No Upfront" cell means unless
   * the sheet says otherwise.
   */
  offeringClass?: 'standard' | 'convertible';
}

export interface PriceQuery {
  /** Price List service code, e.g. AmazonEC2, AmazonRDS, AmazonS3. */
  serviceCode: string;
  /** Region being priced, e.g. ap-south-1. */
  region: string;
  /** TERM_MATCH attribute filters, e.g. { instanceType: 't3.large' }. */
  filters?: Record<string, string>;
  /**
   * Price against a commitment rather than on-demand.
   *
   * Falls back to on-demand when the product publishes no matching reserved offer,
   * and says so in `termLabel`, because a silent fallback would present an on-demand
   * figure as a committed one.
   */
  term?: PriceTerm;
}

export interface PriceResult {
  found: boolean;
  /** Rate in USD per unit, as published. */
  ratePerUnit?: number;
  /** The unit the rate is per: Hrs, GB-Mo, Requests, and so on. */
  unit?: string;
  /** AWS's own description of the dimension, quoted verbatim in the report. */
  description?: string;
  sku?: string;
  message?: string;
  /**
   * Which term the rate came from: "on-demand", or e.g. "3yr No Upfront standard RI".
   *
   * Always populated on a found rate so the report can state the basis of every figure.
   * A cost document that does not say whether a number is committed or on-demand cannot
   * be checked, and the difference is most of the saving.
   */
  termLabel?: string;
  /** True when a commitment was asked for and the product had no such offer. */
  termFellBack?: boolean;
}

/** Attributes every EC2 compute lookup needs, or the API returns dozens of SKUs. */
const EC2_DEFAULTS: Record<string, string> = {
  operatingSystem: 'Linux',
  tenancy: 'Shared',
  preInstalledSw: 'NA',
  // Without capacitystatus the reserved-capacity SKUs come back too.
  capacitystatus: 'Used',
  licenseModel: 'No License required',
};

const RDS_DEFAULTS: Record<string, string> = {
  deploymentOption: 'Single-AZ',
  databaseEdition: 'NA',
  licenseModel: 'No license required',
};

function withDefaults(query: PriceQuery): Record<string, string> {
  let base: Record<string, string> = {};
  if (query.serviceCode === 'AmazonEC2' && query.filters?.instanceType) {
    base = EC2_DEFAULTS;
  } else if (query.serviceCode === 'AmazonRDS' && query.filters?.instanceType) {
    base = /^aurora\b/i.test(query.filters.databaseEngine || '')
      ? { deploymentOption: 'Single-AZ', licenseModel: 'No license required' }
      : RDS_DEFAULTS;
  }
  // Caller wins: an explicit Multi-AZ or Windows must override the default.
  return { ...base, ...(query.filters || {}), regionCode: query.region };
}

/**
 * Picks the on-demand dimension out of a Price List product.
 *
 * A product carries OnDemand and Reserved terms, each keyed by opaque offer codes.
 * We take on-demand: it is the only term whose cost can be stated without also
 * committing to a term length, and a commitment is a decision for the client to
 * make rather than an assumption to bury in an estimate.
 *
 * Dimensions priced at 0 are skipped — several SKUs carry a $0 placeholder
 * alongside the real rate, and returning that would read as free.
 */
function readOnDemandRate(product: any): { rate: number; unit: string; description: string } | undefined {
  const terms = product?.terms?.OnDemand;
  if (!terms) return undefined;
  for (const offer of Object.values<any>(terms)) {
    for (const dimension of Object.values<any>(offer?.priceDimensions || {})) {
      const rate = Number(dimension?.pricePerUnit?.USD);
      if (Number.isFinite(rate) && rate > 0) {
        return {
          rate,
          unit: String(dimension.unit || ''),
          description: String(dimension.description || ''),
        };
      }
    }
  }
  return undefined;
}

/**
 * Picks a committed (reserved) dimension out of a Price List product.
 *
 * Reserved terms are keyed by opaque offer codes and identified only by
 * `termAttributes`: LeaseContractLength ("1yr"/"3yr"), PurchaseOption ("No Upfront",
 * "Partial Upfront", "All Upfront") and OfferingClass ("standard"/"convertible").
 * Verified against a live response for m6a.xlarge in eu-central-1, which publishes
 * twelve offers.
 *
 * Partial and All Upfront carry TWO dimensions: an hourly rate (often $0) and a
 * one-off `Quantity` fee. Reporting only the hourly would price an All Upfront RI at
 * zero, so the fee is amortised across the commitment and folded into the hourly rate.
 * That makes every returned rate directly comparable, which is what lets one line of
 * arithmetic serve both terms.
 */
function readReservedRate(
  product: any,
  term: PriceTerm,
): { rate: number; unit: string; description: string } | undefined {
  const offers = product?.terms?.Reserved;
  if (!offers) return undefined;

  const wantLease = term.years === 1 ? '1yr' : '3yr';
  const wantClass = term.offeringClass || 'standard';

  for (const offer of Object.values<any>(offers)) {
    const attributes = offer?.termAttributes || {};
    if (attributes.LeaseContractLength !== wantLease) continue;
    if (attributes.PurchaseOption !== term.purchase) continue;
    // OfferingClass is absent on services that do not offer the distinction (RDS), so
    // an absent value matches rather than disqualifying the offer.
    if (attributes.OfferingClass && attributes.OfferingClass !== wantClass) continue;

    let hourly = 0;
    let upfront = 0;
    let description = '';
    for (const dimension of Object.values<any>(offer?.priceDimensions || {})) {
      const rate = Number(dimension?.pricePerUnit?.USD);
      if (!Number.isFinite(rate)) continue;
      if (String(dimension.unit || '').toLowerCase() === 'quantity') {
        upfront += rate;
      } else {
        hourly += rate;
        description = String(dimension.description || '');
      }
    }

    // 8760, not HOURS_PER_MONTH x 12: a commitment is priced over calendar years, and
    // the upfront fee buys the whole term whether or not the instance is running.
    const amortised = hourly + upfront / (term.years * 8760);
    if (amortised > 0) {
      return {
        rate: amortised,
        unit: 'Hrs',
        description: description
          || `${wantLease} ${term.purchase} ${wantClass} reserved instance`,
      };
    }
  }
  return undefined;
}

/**
 * How a term reads in a report. The basis of a figure is part of the figure.
 *
 * Delegates to the shared spelling in pricing-models so the same term cannot read two
 * ways inside one document -- "3yr ... standard reserved" beside a summary line saying
 * "3-year ... reserved" looked like two different commitments.
 */
function termLabelOf(term?: PriceTerm): string {
  if (!term) return 'on-demand';
  return sharedTermLabelOf(term);
}

/**
 * Identical lookups answered once per invocation.
 *
 * Published rates do not move during a run, and a real workbook asks the same question
 * many times over: every group with a disk issues the same gp3 lookup for its region, and
 * a fleet standardised on one instance type asks for that rate once per environment. The
 * live 110-machine run made 105 calls for 43 line items. Collapsing the repeats is a
 * straight reduction in both wall clock and throttle pressure, and it cannot change a
 * figure, because the answer being reused is the same answer.
 *
 * Keyed on the whole query including the term, since a committed rate and an on-demand
 * rate for the same product are different answers. Promises are cached rather than
 * results, so concurrent duplicates share one in-flight request instead of racing.
 */
const inFlight = new Map<string, Promise<PriceResult>>();

/**
 * One published rate, or a clear reason there isn't one.
 *
 * Never throws and never guesses: an unpriced line has to stay visibly unpriced,
 * because a plausible invented number in a cost document is worse than a gap.
 */
export async function lookupPrice(query: PriceQuery): Promise<PriceResult> {
  if (!query.serviceCode || !query.region) {
    return { found: false, message: 'serviceCode and region are both required.' };
  }

  const key = JSON.stringify([
    query.serviceCode,
    query.region,
    Object.entries(query.filters || {}).sort(),
    query.term ?? null,
  ]);
  const cached = inFlight.get(key);
  if (cached) return cached;

  const pending = fetchPrice(query).then((result) => {
    // A failure is not cached: a throttle or a transient fault must not be reused as
    // the answer for every duplicate of that query in the run.
    if (!result.found) inFlight.delete(key);
    return result;
  });
  inFlight.set(key, pending);
  return pending;
}

/**
 * Clears the memo. Called once per estimate.
 *
 * A Lambda container outlives an invocation, sometimes by hours, and a rate cached across
 * that span would be quietly stale. Scoping the cache to one run keeps the guarantee the
 * report makes — that every figure was read from the Price List today — literally true.
 */
export function resetPriceCache(): void {
  inFlight.clear();
}

/** The uncached lookup. Kept separate so the memo above has exactly one entry point. */
async function fetchPrice(query: PriceQuery): Promise<PriceResult> {
  const attributes = withDefaults(query);
  const suffixFilters = Object.entries(attributes)
    .filter(([, value]) => value.startsWith('*'))
    .map(([field, value]) => [field, value.slice(1)] as const);
  const exactAttributes = Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => !value.startsWith('*')),
  );
  try {
    const products: any[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    do {
      const response = await sendWithRetry(new GetProductsCommand({
        ServiceCode: query.serviceCode,
        MaxResults: suffixFilters.length ? 100 : 20,
        ...(nextToken ? { NextToken: nextToken } : {}),
        Filters: Object.entries(exactAttributes).map(([Field, Value]) => ({
          Type: 'TERM_MATCH' as const,
          Field,
          Value,
        })),
      }));

      const page = (response.PriceList || [])
        .map((entry: unknown) => JSON.parse(String(entry)))
        .filter((product: any) => suffixFilters.every(([field, suffix]) => (
          String(product?.product?.attributes?.[field] || '').endsWith(suffix)
        )));
      products.push(...page);
      nextToken = response.NextToken;
      pages += 1;
    } while (suffixFilters.length && nextToken && !products.length && pages < 50);

    if (!products.length) {
      return {
        found: false,
        message: `No ${query.serviceCode} price found in ${query.region} for ${JSON.stringify(query.filters || {})}. Check the attribute names and values against the Price List API.`,
      };
    }

    type Rate = { rate: number; unit: string; description: string };
    const collect = (read: (product: any) => Rate | undefined): Rate[] => products
      .map(read)
      .filter((entry: Rate | undefined): entry is Rate => !!entry)
      // Several SKUs can match a loose filter; the cheapest dimension is the plain
      // usage rate rather than a surcharge variant.
      .sort((left: Rate, right: Rate) => left.rate - right.rate);

    // A commitment is asked for first and on-demand is the fallback, never the
    // silent substitute: termFellBack tells the caller which it got.
    const committed = query.term ? collect((product) => readReservedRate(product, query.term!)) : [];
    const onDemand = committed.length ? [] : collect(readOnDemandRate);
    const rates = committed.length ? committed : onDemand;

    if (!rates.length) {
      return {
        found: false,
        message: query.term
          ? `Matching products published neither a ${termLabelOf(query.term)} offer nor an on-demand price dimension.`
          : 'Matching products carried no on-demand price dimension.',
      };
    }

    return {
      found: true,
      ratePerUnit: rates[0].rate,
      unit: rates[0].unit,
      description: rates[0].description,
      sku: products[0]?.product?.sku,
      termLabel: committed.length ? termLabelOf(query.term) : 'on-demand',
      ...(query.term && !committed.length ? { termFellBack: true } : {}),
    };
  } catch (error) {
    // A permissions or throttling failure must not fail the estimate — the line
    // stays unpriced and says why.
    return { found: false, message: `Price lookup failed: ${(error as Error).message}` };
  }
}

/**
 * Monthly cost of a resource that is billed by the hour.
 *
 * This is where the runtime hours finally do their job: a box at 8h/day costs a
 * third of the same box at 24h. Returns the derivation as well as the total so the
 * report can show its working instead of asserting a number.
 */
export function monthlyFromHourly(input: {
  ratePerHour: number;
  hoursPerDay: number;
  quantity?: number;
}): { monthly: number; monthlyHours: number; workings: string } {
  const quantity = Math.max(1, Math.round(input.quantity || 1));
  const hours = Math.min(24, Math.max(0, input.hoursPerDay));
  // Proportion of the billing month this resource is up: exactly 730 at 24h/day.
  const monthlyHours = HOURS_PER_MONTH * (hours / 24);
  const monthly = input.ratePerHour * monthlyHours * quantity;
  const scale = quantity > 1 ? ` x ${quantity}` : '';
  const utilisation = hours >= 24
    ? `${HOURS_PER_MONTH} hrs/month`
    : `${hours}h/day (${monthlyHours.toFixed(1)} of ${HOURS_PER_MONTH} hrs/month)`;
  return {
    monthly,
    monthlyHours,
    workings: `$${input.ratePerHour.toFixed(4)}/hr x ${utilisation}${scale} = $${monthly.toFixed(2)}/mo`,
  };
}

/** Monthly cost of something billed per GB-month, where hours do not apply. */
export function monthlyFromGbMonth(input: {
  ratePerGbMonth: number;
  gigabytes: number;
}): { monthly: number; workings: string } {
  const monthly = input.ratePerGbMonth * Math.max(0, input.gigabytes);
  return {
    monthly,
    workings: `$${input.ratePerGbMonth.toFixed(4)}/GB-month x ${input.gigabytes} GB = $${monthly.toFixed(2)}/mo`,
  };
}
