import { CalculationResourceSchema, type CalculationResource } from '../schema/calculator';
import { describeUnit, type CanonicalUnit } from '../lambdas/shared/unit-contract';

/**
 * The units enum is declared twice, and this file is the reason that is allowed.
 *
 * `CanonicalUnit` in `lambdas/shared/unit-contract.ts` is the definition — it is what
 * `reconcile` keys its accept lists on, and a quantity in a unit that is not on that list
 * cannot be multiplied by an AWS rate at all. `CalculationResourceSchema.quantities[].unit`
 * is the same list in wire form, redeclared because `schema/` deliberately depends on zod
 * and its own siblings and nothing else, so that a payload can be validated without
 * dragging a pricing module in behind it.
 *
 * Two copies of a list is a drift hazard, and the drift would be quiet in the worst
 * possible way: a unit added to the schema but not to the accept list would validate on the
 * way in, reach the pricing branch, be refused there, and surface as a line item that says
 * it could not be priced — with no indication that the cause was a missing table entry
 * rather than a genuinely unmatchable quantity. A unit added to the accept list but not the
 * schema fails earlier and louder, but still only at runtime on a real upload.
 *
 * So the guard is compile-time first and runtime second.
 */

/**
 * The compile-time half, and the one that actually holds the line: this runs under
 * `tsc --noEmit`, which is the build, so a divergent list breaks the build rather than
 * waiting for someone to run the suite.
 *
 * Assigned in BOTH directions on purpose. One direction only proves the schema's list is a
 * subset of the canonical one, which would let a canonical unit go missing from the wire
 * shape unnoticed — and that is the likelier mistake, since a new unit gets added where the
 * pricing work is happening.
 */
type SchemaUnit = NonNullable<CalculationResource['quantities']>[number]['unit'];
const _schemaUnitIsCanonical: CanonicalUnit = 'GB-seconds/month' as SchemaUnit;
const _canonicalUnitIsInSchema: SchemaUnit = 'GB-seconds/month' as CanonicalUnit;
void _schemaUnitIsCanonical;
void _canonicalUnitIsInSchema;

/** The enum's own options, dug out of the schema rather than retyped into a third copy. */
const schemaUnits = (() => {
  const quantities = CalculationResourceSchema.shape.quantities.unwrap();
  const row = quantities.element;
  return row.shape.unit.options as readonly string[];
})();

describe('The canonical unit list is declared twice and the two must agree', () => {
  test('every unit the schema accepts is one the unit contract can describe', () => {
    // `describeUnit` reads a Record keyed on CanonicalUnit with no default case, so a unit
    // that is not a member comes back undefined. That makes it a runtime membership test
    // for free, without exporting a list purely so a test can iterate it — an export whose
    // only caller is a test is an invitation to add an eleventh member to it and nowhere else.
    for (const unit of schemaUnits) {
      const described = describeUnit(unit as CanonicalUnit);
      expect(typeof described).toBe('string');
      expect(described.length).toBeGreaterThan(0);
    }
  });

  test('the schema lists every canonical unit, not merely a subset of them', () => {
    // Spelled out rather than derived, because deriving it from either declaration would
    // make this assertion agree with whichever one it derived from. Ten is the count the
    // accept lists in unit-contract.ts are written against; an eleventh unit has to be
    // added in three places, and this is where the third one is noticed.
    expect([...schemaUnits].sort()).toEqual([
      'GB-hours/month',
      'GB-seconds/month',
      'GB-transfer/month',
      'GB/month',
      'IOPS/month',
      'hours/month',
      'invocations/month',
      'requests/month',
      'units/month',
      'vCPU-hours/month',
    ]);
  });

  test('a unit that is not on the list is rejected rather than coerced', () => {
    // The failure this prevents is a plausible near-miss spelling — "hours/mo", "GB",
    // "requests" — arriving from a normaliser and being accepted as though it named a
    // dimension. The pricing layer would then have a quantity it could not reconcile and
    // no way to say which unit was meant.
    const parsed = CalculationResourceSchema.safeParse({
      name: 'web-01',
      quantities: [{ unit: 'hours/mo', amount: 730, basis: 'stated', conversions: [] }],
    });
    expect(parsed.success).toBe(false);
  });
});
