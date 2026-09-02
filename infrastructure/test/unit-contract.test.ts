import {
  HOURS_PER_MONTH,
  MONTHS_PER_YEAR,
  INSTANCE_UNIT,
  blockSize,
  describeUnit,
  hoursFromPerDay,
  perYearToPerMonth,
  reconcile,
} from '../lambdas/shared/unit-contract';
import type { CanonicalUnit } from '../lambdas/shared/unit-contract';

/**
 * The unit contract.
 *
 * This module exists because of one defect, and the defect had no symptom. The old pricer
 * branched two ways on the AWS Price List unit: "GB-Mo" meant gigabytes, and everything
 * else was assumed hourly and multiplied by 730. So a per-request rate, a per-invocation
 * rate, a GB-second rate and a Fargate vCPU-hour rate all became "rate x 730", and the
 * report printed a confident total with a workings line reading `$0.04/Requests x 730
 * hrs/month`. A bill overstated ~730x looks finished, so nobody re-checks it.
 *
 * The tests below are therefore weighted deliberately: the refusals come first and are the
 * larger half of the file, because an accept that should have been a refusal is the failure
 * that reaches a client, while a refusal that should have been an accept is an unpriced
 * line carrying a sentence explaining itself — visible, and fixed by adding one spelling.
 *
 * The whole module is pure, so every case here is a direct call. There is nothing to mock
 * and no reason for a fixture beyond a unit string.
 */

/**
 * Every member of `CanonicalUnit`, listed as literals on purpose.
 *
 * The list is deliberately exhaustive, and the mutual-assignability guard below makes a
 * newly added `CanonicalUnit` a compile error here until it is added and covered. That is
 * the feature: a new dimension nobody wrote a reconciliation test for is exactly how the
 * 730x assumption got in, so adding one must not be silent.
 */
const CANONICAL_UNITS = [
  'hours/month',
  'GB/month',
  'GB-transfer/month',
  'requests/month',
  'invocations/month',
  'GB-seconds/month',
  'vCPU-hours/month',
  'GB-hours/month',
  'IOPS/month',
  'units/month',
] as const;

type Listed = typeof CANONICAL_UNITS[number];
// Fails to compile in one direction if a unit is added to the type and not to the array,
// and in the other if the array carries a unit the type no longer has.
const _everyCanonicalUnitIsListed: Listed extends CanonicalUnit
  ? (CanonicalUnit extends Listed ? true : never)
  : never = true;

/**
 * Real Price List spellings, one row per canonical dimension.
 *
 * A `Record` rather than a lookup helper so the type checker demands a row for every
 * dimension. Every string here is a spelling AWS actually publishes (or the same spelling
 * with the punctuation and casing the Price List varies at random: "Hrs", "Hrs.", "Hours"),
 * because a made-up spelling would test the normaliser against itself and prove nothing.
 */
const ACCEPTED_SPELLINGS: Record<CanonicalUnit, string[]> = {
  'hours/month': ['Hrs', 'hrs', 'HRS.', 'Hours', 'Hour', 'Instance-Hours'],
  'GB/month': ['GB-Mo', 'GB-Mo.', 'GB-month', 'GB-Months'],
  'GB-transfer/month': ['GB', 'GBs', 'GigaBytes', 'GB-Out'],
  'requests/month': ['Requests', 'Request', 'API Calls', 'API Requests', 'Calls'],
  // Lambda publishes its invocation rate under "Requests", which is why this row overlaps
  // with the one above -- the only overlap anywhere in the table.
  'invocations/month': ['Invocations', 'Requests'],
  'GB-seconds/month': ['Lambda-GB-Second', 'GB-Seconds', 'GB-Sec'],
  'vCPU-hours/month': ['vCPU-Hours', 'vCPU-Hrs', 'CPU-Hours'],
  'GB-hours/month': ['GB-Hours', 'GB-Hrs'],
  'IOPS/month': ['IOPS-Mo', 'IOPS', 'IOPS-month'],
  'units/month': ['Quantity', 'Count', 'Units', 'MAU', 'Each'],
};

describe('Refusing to multiply a quantity by a rate that measures something else', () => {
  /**
   * Pairings that must never produce a multiplier, each with the bill it would misstate.
   *
   * The third column is not decoration: it is the reason the row is worth a test, and the
   * factor named in it is what a reader of a failing assertion needs in order to judge how
   * urgent the regression is.
   */
  const WRONG_PAIRINGS: Array<[CanonicalUnit, string, string]> = [
    // The original defect, in both of the spellings the Price List uses for an hour.
    ['requests/month', 'Hrs', 'a request count priced at an hourly rate is ~730x the bill'],
    ['requests/month', 'Hours', 'same defect, the other hour spelling'],
    // Called out in the module comment: `units/month` is the escape hatch for a countable,
    // and the one thing an escape hatch must never do is quietly become runtime.
    ['units/month', 'Hrs', 'a countable is never priced by runtime'],
    // Storage held and data moved are different rates on the same service, so substituting
    // one for the other reads entirely plausible and is wrong every month.
    ['GB/month', 'GB', 'gigabytes stored are not gigabytes transferred'],
    ['GB-transfer/month', 'GB-Mo', 'gigabytes transferred are not gigabytes stored'],
    // Hours against three non-hour dimensions: a runtime figure priced per GB, per request
    // or per bare unit is the same class of mistake pointing the other way.
    ['hours/month', 'GB-Mo', 'runtime hours are not gigabyte-months'],
    ['hours/month', 'Requests', 'runtime hours are not requests'],
    ['hours/month', 'Quantity', 'runtime hours are not a bare count'],
    // Lambda duration. The GB-second rate is the one the old branch inflated hardest,
    // because a GB-second figure is already large before it is multiplied by 730.
    ['GB-seconds/month', 'Hrs', 'GB-seconds are not hours'],
    // Fargate. Named in the module comment as a real estimate that went wrong by hand.
    ['vCPU-hours/month', 'Requests', 'vCPU-hours are not requests'],
    ['vCPU-hours/month', 'GB-Mo', 'vCPU-hours are not gigabyte-months'],
    ['vCPU-hours/month', 'Hrs', 'a vCPU-hour is not an instance-hour, and the rates differ'],
    // A handful more, so that no dimension is left without at least one refusal of its own.
    ['invocations/month', 'Hrs', 'an invocation count is not a runtime'],
    ['IOPS/month', 'Hrs', 'provisioned IOPS are not runtime hours'],
    ['GB-hours/month', 'GB-Mo', 'a GB-hour is not a GB-month, and they differ by 730'],
    ['GB-hours/month', 'GB', 'a GB-hour is not a gigabyte transferred'],
    ['GB/month', 'Hrs', 'gigabytes stored are not hours'],
    ['GB-transfer/month', 'Hrs', 'gigabytes transferred are not hours'],
    ['requests/month', 'GB-Mo', 'requests are not gigabyte-months'],
    ['units/month', 'Requests', 'a bare count is not a request count'],
    ['GB-seconds/month', 'GB-Mo', 'GB-seconds are not gigabyte-months'],
  ];

  test.each(WRONG_PAIRINGS)('%s is not priced per "%s", because %s', (canonical, awsUnit) => {
    const outcome = reconcile(canonical, awsUnit);

    expect(outcome.ok).toBe(false);
    // No multiplier at all, rather than a multiplier of 1 that a caller might still apply.
    expect('multiplier' in outcome).toBe(false);
  });

  test('every refusal carries a sentence a client can be shown', () => {
    // The refusal prose IS the recovery path: an unpriced line that says why gets read and
    // fixed, and one that says nothing gets treated as a rendering glitch.
    for (const [canonical, awsUnit] of WRONG_PAIRINGS) {
      const outcome = reconcile(canonical, awsUnit);
      if (outcome.ok) throw new Error(`${canonical} unexpectedly accepted "${awsUnit}"`);

      expect(outcome.reason.length).toBeGreaterThan(40);
      // Prose, not a token: several words, and it names both halves of the mismatch so the
      // reader does not have to go and find the rate to understand the sentence.
      expect(outcome.reason.split(/\s+/).length).toBeGreaterThan(8);
      expect(outcome.reason).toContain(describeUnit(canonical));
      expect(outcome.reason).toContain(awsUnit);
    }
  });

  test('the historical failure is refused in the terms it went wrong in', () => {
    // The exact call the old pricer made without noticing. Asserted on its own as well as
    // in the table above, because it is the one regression that has already shipped.
    const outcome = reconcile('requests/month', 'Requests');
    expect(outcome.ok).toBe(true);

    const inflated = reconcile('requests/month', 'Hrs');
    expect(inflated.ok).toBe(false);
    if (inflated.ok) throw new Error('a request count was reconciled against an hourly rate');
    expect(inflated.reason).toMatch(/measure different things/);
    // And it does not offer the reader the 730 it used to apply.
    expect(inflated.reason).not.toContain('730');
  });

  test('no dimension accepts another dimension spellings, except Requests for invocations', () => {
    // The safety property stated once over the whole table rather than pairing by hand: take
    // every spelling AWS publishes for one dimension and offer it to every other dimension.
    // The single legitimate overlap is Lambda's, which bills invocations under "Requests" --
    // everything else crossing over would be a new 730x-shaped hole, whichever spelling
    // someone widened an accept list with.
    const legitimate = new Set(['requests/month->invocations/month', 'invocations/month->requests/month']);
    const leaks: string[] = [];

    for (const [owner, spellings] of Object.entries(ACCEPTED_SPELLINGS) as Array<[CanonicalUnit, string[]]>) {
      for (const other of CANONICAL_UNITS) {
        if (other === owner) continue;
        if (legitimate.has(`${owner}->${other}`)) continue;
        for (const spelling of spellings) {
          if (reconcile(other, spelling).ok) leaks.push(`${other} accepted "${spelling}" (${owner})`);
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  test('a rate AWS published with no unit is left unpriced rather than guessed', () => {
    const outcome = reconcile('hours/month', '');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/no unit/);
    expect(outcome.reason).toMatch(/unpriced/);
  });

  test('a missing unit refuses instead of throwing', () => {
    // The Price List genuinely omits `unit` on some terms, so this arrives as undefined at
    // runtime however the signature is typed. A throw here would take down the whole
    // pricing pass over one field, turning a single unpriced line into an unpriced estimate.
    const missing = undefined as unknown as string;

    expect(() => reconcile('requests/month', missing)).not.toThrow();
    expect(reconcile('requests/month', missing).ok).toBe(false);
    // Whitespace-only is the same case: it tokenises to nothing.
    expect(reconcile('requests/month', '   ').ok).toBe(false);
  });

  test('an unrecognised unit is a refusal, never a fall-through to hourly', () => {
    // There is no default case by design. A unit nobody has seen before must land in the
    // refusal, which is the difference between this module and the branch it replaced.
    expect(reconcile('hours/month', 'ACU-Hr').ok).toBe(false);
    expect(reconcile('units/month', 'Fargate-vCPU-Hours-perhour').ok).toBe(false);
    expect(reconcile('requests/month', 'Tag-Mo').ok).toBe(false);
  });
});

describe('Accepting a pairing where the quantity and the rate agree', () => {
  test.each(Object.entries(ACCEPTED_SPELLINGS) as Array<[CanonicalUnit, string[]]>)(
    '%s reconciles against the spellings AWS publishes for it',
    (canonical, spellings) => {
      for (const spelling of spellings) {
        const outcome = reconcile(canonical, spelling);
        if (!outcome.ok) throw new Error(`${canonical} refused "${spelling}", which AWS publishes for it`);

        // 1 is the common case and the safe one: the quantity is already in the unit AWS
        // bills, so nothing is scaled and there is no factor to get wrong.
        expect(outcome.multiplier).toBe(1);
        expect(outcome.explanation).toContain(spelling);
      }
    },
  );

  test('casing and punctuation the Price List varies at random resolve to one unit', () => {
    // The same dimension appears as "Hrs", "hrs", "Hours" and "Hrs." across services, and
    // "GB-Mo", "GB-Mo." and "GB-month" for storage. Any of these being read as unknown
    // would leave a line unpriced for a reason that is not about the estimate at all.
    for (const hour of ['Hrs', 'hrs', 'HRS.', 'Hours', 'hours', 'Hour', 'hr']) {
      expect(reconcile('hours/month', hour)).toEqual(
        expect.objectContaining({ ok: true, multiplier: 1 }),
      );
    }
    for (const stored of ['GB-Mo', 'GB-Mo.', 'GB-month', 'gb-mo', 'GB-Mos']) {
      expect(reconcile('GB/month', stored)).toEqual(
        expect.objectContaining({ ok: true, multiplier: 1 }),
      );
    }
  });

  test('Lambda invocations priced under Requests are reconciled, because that is what AWS publishes', () => {
    // The one cross-dimension accept in the module, and it is here because the Price List
    // really does bill an invocation as a request. Removing it would leave every Lambda
    // line unpriced.
    const outcome = reconcile('invocations/month', 'Requests');

    expect(outcome).toEqual(expect.objectContaining({ ok: true, multiplier: 1 }));
  });

  test('the explanation names the unit both sides agreed on, for the workings line', () => {
    const outcome = reconcile('vCPU-hours/month', 'vCPU-Hours');
    if (!outcome.ok) throw new Error('vCPU-hours refused the unit Fargate is billed in');

    expect(outcome.explanation).toBe('quantity and AWS rate are both in vCPU-Hours');
  });
});

describe('Block pricing, where AWS charges per thousand or per million', () => {
  test('a block size is read off the unit string', () => {
    // Six orders of magnitude for 1M Requests, so this is not a rounding concern: it is the
    // same size of error as the hourly assumption, arriving through a different door.
    expect(blockSize('1M Requests')).toBe(1_000_000);
    expect(blockSize('10K Requests')).toBe(10_000);
    // Thousands separators are how the Price List writes IOPS blocks.
    expect(blockSize('1,000 IOPs')).toBe(1000);
  });

  test('a unit that names no block prices per item', () => {
    // 1, not 0 and not NaN: the multiplier divides by this, so any other answer would
    // corrupt every non-block line in the estimate.
    expect(blockSize('Requests')).toBe(1);
    expect(blockSize('Hrs')).toBe(1);
    expect(blockSize('GB-Mo')).toBe(1);
    expect(blockSize('')).toBe(1);
    expect(blockSize(undefined as unknown as string)).toBe(1);
  });

  test('a per-million rate divides the monthly quantity rather than multiplying it', () => {
    const outcome = reconcile('requests/month', '1M Requests');
    if (!outcome.ok) throw new Error('a block-priced request unit was refused');

    expect(outcome.multiplier).toBeCloseTo(1 / 1_000_000, 12);
    // The block size is stated in words, because the workings line is where a reviewer
    // notices a factor of a million either way.
    expect(outcome.explanation).toContain('1,000,000');
    expect(outcome.explanation).toMatch(/divided by/);
  });

  test('a per-thousand rate is read the same way', () => {
    const outcome = reconcile('requests/month', '10K Requests');
    if (!outcome.ok) throw new Error('a per-10K request unit was refused');

    expect(outcome.multiplier).toBeCloseTo(1 / 10_000, 12);
    expect(outcome.explanation).toContain('10,000');
  });

  test('the block arithmetic gives the bill a person would work out by hand', () => {
    // 10 million requests at $4.00 per million is $40.00 a month. The old code, having
    // decided anything that was not GB-Mo was hourly, would have reported $29,200,000.
    const outcome = reconcile('requests/month', '1M Requests');
    if (!outcome.ok) throw new Error('a block-priced request unit was refused');

    const monthly = 4.0 * outcome.multiplier * 10_000_000;
    expect(monthly).toBeCloseTo(40, 6);
    expect(monthly).not.toBeCloseTo(4.0 * HOURS_PER_MONTH * 10_000_000, 6);
  });

  test('a block-priced unit of the WRONG dimension is still refused', () => {
    // Block handling runs after the dimension check, and must not become a second way in.
    // A runtime figure divided by a million is a small wrong number instead of a large one.
    expect(reconcile('hours/month', '1M Requests').ok).toBe(false);
    expect(reconcile('GB/month', '10K Requests').ok).toBe(false);
    expect(reconcile('units/month', '1M Requests').ok).toBe(false);
  });

  test('a block-priced IOPS unit reconciles against provisioned IOPS', () => {
    // The digits carried by "1,000 IOPs" are not in any accept list, so the dimension has
    // to be recognised from the unit with the block stripped -- otherwise every block-priced
    // rate would be refused for a reason that has nothing to do with its dimension.
    const outcome = reconcile('IOPS/month', '1,000 IOPs');
    if (!outcome.ok) throw new Error('a block-priced IOPS unit was refused');

    expect(outcome.multiplier).toBeCloseTo(1 / 1000, 12);
  });
});

describe('Runtime hours for a resource that is not on all day', () => {
  test('a 24-hour day is the AWS billing month', () => {
    expect(hoursFromPerDay(24)).toBe(HOURS_PER_MONTH);
    expect(HOURS_PER_MONTH).toBe(730);
  });

  test('half and third days scale the month, rounded to the cent-relevant place', () => {
    // 12h is exactly half a month. 8h is 243.333..., and the rounding is to two places
    // because the figure is printed beside a rate in a client document.
    expect(hoursFromPerDay(12)).toBe(365);
    expect(hoursFromPerDay(8)).toBe(243.33);
  });

  test('a day longer than a day is clamped, not honoured', () => {
    // A sheet that says 25 hours a day has a data-entry error, and honouring it would
    // inflate every downstream figure derived from it.
    expect(hoursFromPerDay(25)).toBe(HOURS_PER_MONTH);
    expect(hoursFromPerDay(100)).toBe(HOURS_PER_MONTH);
    expect(hoursFromPerDay(Infinity)).toBe(HOURS_PER_MONTH);
  });

  test('a negative or unreadable day floors at zero hours rather than going negative', () => {
    // Documents the behaviour as it stands. Note that the function's own docstring says it
    // "floors at a single hour" -- it does not; 0 in gives 0 out, and a negative or garbage
    // value coerces to 0 too. A negative here would produce a negative line item, which is
    // the outcome the clamp exists to prevent, so the floor at zero is the safe half.
    expect(hoursFromPerDay(0)).toBe(0);
    expect(hoursFromPerDay(-1)).toBe(0);
    expect(hoursFromPerDay(-1000)).toBe(0);
    expect(hoursFromPerDay(NaN)).toBe(0);
    expect(hoursFromPerDay('business hours' as unknown as number)).toBe(0);
    expect(hoursFromPerDay(undefined as unknown as number)).toBe(0);
    expect(hoursFromPerDay(null as unknown as number)).toBe(0);
  });

  test('a numeric string from a spreadsheet cell is read as the number it is', () => {
    // Every hours figure reaching this function came out of a cell as text.
    expect(hoursFromPerDay('24' as unknown as number)).toBe(HOURS_PER_MONTH);
    expect(hoursFromPerDay('8' as unknown as number)).toBe(243.33);
  });

  test('hours never exceed the billing month, whatever the input', () => {
    for (const input of [-5, 0, 0.5, 1, 6, 8, 12, 23.9, 24, 24.1, 48, 1440]) {
      const hours = hoursFromPerDay(input);
      expect(hours).toBeGreaterThanOrEqual(0);
      expect(hours).toBeLessThanOrEqual(HOURS_PER_MONTH);
    }
  });
});

describe('Reading a per-year figure onto a monthly basis', () => {
  test('24 million invocations a year is 2 million a month', () => {
    // The figure from the customer sheet (docs/Digital_Assets.xlsx): "Lambda
    // invocations/yr | 24000000". Priced as a monthly number it overstates by twelve.
    const { amount, conversion } = perYearToPerMonth(24_000_000);

    expect(amount).toBe(2_000_000);
    expect(conversion).toMatch(/divided by 12/);
  });

  test('the conversion is returned as words, not applied silently', () => {
    // A silent divide by twelve is indistinguishable from a reader that never noticed the
    // "/yr" in the label, and those two have opposite fixes -- so the sentence is the point.
    const { conversion } = perYearToPerMonth(12);

    expect(conversion.length).toBeGreaterThan(20);
    expect(conversion).toMatch(/per-year/);
    expect(conversion).toMatch(/monthly/);
  });

  test('a year of months is a year', () => {
    expect(MONTHS_PER_YEAR).toBe(12);
    expect(perYearToPerMonth(MONTHS_PER_YEAR).amount).toBe(1);
    expect(perYearToPerMonth(0).amount).toBe(0);
  });
});

describe('The dimension an instance row is billed on', () => {
  test('an instance is billed by runtime, stated once rather than assumed per caller', () => {
    // The one assumption the pricer may make, and it is the row's assumption: a row that
    // declares itself an instance has said in the canonical format that it is time-billed.
    expect(INSTANCE_UNIT).toBe('hours/month');
    expect(reconcile(INSTANCE_UNIT, 'Hrs')).toEqual(
      expect.objectContaining({ ok: true, multiplier: 1 }),
    );
  });
});

describe('Wording each dimension for a report', () => {
  test.each(CANONICAL_UNITS)('%s is described in words a client can read', (unit) => {
    const description = describeUnit(unit);

    expect(typeof description).toBe('string');
    expect(description.trim().length).toBeGreaterThan(0);
    // Prose, not the identifier echoed back: the description is what a refusal sentence
    // reads as, and "this line counts GB-seconds/month" is not a sentence.
    expect(description).not.toBe(unit);
    expect(description).toMatch(/[a-z]/);
  });

  test('no two dimensions are described the same way', () => {
    // Two identical descriptions would make a refusal ambiguous exactly where it matters:
    // "this line counts gigabytes per month, but AWS prices it per GB-Mo" tells the reader
    // nothing about which of stored or transferred it meant.
    const descriptions = CANONICAL_UNITS.map((unit) => describeUnit(unit));

    expect(new Set(descriptions).size).toBe(CANONICAL_UNITS.length);
  });
});
