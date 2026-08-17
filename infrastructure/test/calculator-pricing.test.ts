import { monthlyFromGbMonth, monthlyFromHourly, HOURS_PER_MONTH } from '../lambdas/calculator-orchestrator/aws-pricing';

/**
 * Cost arithmetic.
 *
 * This is the whole feature reduced to one multiplication, so it is worth pinning
 * exactly. The saved calculator.aws estimate carries no money — verified against a
 * real estimate, whose export came back with an empty groupSubtotal — so these
 * figures come from AWS published rates times the hours a resource actually runs.
 * If the multiplication is wrong, every number in the client's PDF is wrong.
 */

describe('Monthly cost from an hourly rate', () => {
  test('a t3.large at 24h/day is the published rate times a 730-hour month', () => {
    // $0.0896/hr is the real ap-south-1 Linux on-demand rate at the time of writing.
    const { monthly, monthlyHours } = monthlyFromHourly({ ratePerHour: 0.0896, hoursPerDay: 24 });

    // Exactly 730, matching AWS's own billing month — NOT 24 x 30.44 (730.56),
    // which would put every always-on figure above what the estimate link shows.
    expect(monthlyHours).toBe(HOURS_PER_MONTH);
    expect(monthly).toBeCloseTo(0.0896 * 730, 6);
    expect(monthly).toBeCloseTo(65.41, 2);
  });

  test('8h/day costs a third of 24h/day — the point of the whole feature', () => {
    const allDay = monthlyFromHourly({ ratePerHour: 0.0896, hoursPerDay: 24 }).monthly;
    const workingHours = monthlyFromHourly({ ratePerHour: 0.0896, hoursPerDay: 8 }).monthly;

    expect(workingHours).toBeCloseTo(allDay / 3, 6);
  });

  test('12h/day is half, so a saving is exactly recoverable from the figure', () => {
    const allDay = monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 24 }).monthly;
    const halfDay = monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 12 }).monthly;

    expect(halfDay).toBeCloseTo(allDay / 2, 6);
    // The report reverses this to show what scheduling saves; the two must agree.
    expect(halfDay * (24 / 12 - 1)).toBeCloseTo(allDay - halfDay, 6);
  });

  test('quantity multiplies the total', () => {
    const one = monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 12, quantity: 1 }).monthly;
    const three = monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 12, quantity: 3 }).monthly;

    expect(three).toBeCloseTo(one * 3, 6);
  });

  test('the workings state the rate, the hours and the quantity', () => {
    // Printed verbatim in the PDF so a client can check the figure rather than
    // trust it — a bare number in a cost document is an assertion.
    const { workings } = monthlyFromHourly({ ratePerHour: 0.0896, hoursPerDay: 8, quantity: 2 });

    expect(workings).toContain('$0.0896/hr');
    expect(workings).toContain('8h/day');
    expect(workings).toContain(String(HOURS_PER_MONTH));
    expect(workings).toContain('x 2');
  });

  test('an always-on resource is described in hours, not as a fraction of a day', () => {
    expect(monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 24 }).workings)
      .toContain(`${HOURS_PER_MONTH} hrs/month`);
  });

  test('a single instance is not labelled "x 1"', () => {
    expect(monthlyFromHourly({ ratePerHour: 0.05, hoursPerDay: 24, quantity: 1 }).workings).not.toContain('x 1 ');
  });

  test('hours are clamped to a real day', () => {
    // 48h/day is a mistake in someone's sheet; charging for it would silently
    // double the estimate.
    const absurd = monthlyFromHourly({ ratePerHour: 0.1, hoursPerDay: 48 }).monthly;
    const full = monthlyFromHourly({ ratePerHour: 0.1, hoursPerDay: 24 }).monthly;

    expect(absurd).toBeCloseTo(full, 6);
  });

  test('a fractional quantity is rounded rather than producing a fractional server', () => {
    expect(monthlyFromHourly({ ratePerHour: 0.1, hoursPerDay: 24, quantity: 2.4 }).monthly)
      .toBeCloseTo(monthlyFromHourly({ ratePerHour: 0.1, hoursPerDay: 24, quantity: 2 }).monthly, 6);
  });
});

describe('Monthly cost from a GB-month rate', () => {
  test('storage is rate times size, with no hours involved', () => {
    const { monthly, workings } = monthlyFromGbMonth({ ratePerGbMonth: 0.025, gigabytes: 200 });

    expect(monthly).toBeCloseTo(5, 6);
    expect(workings).toContain('200 GB');
    // Hours must not appear: storage costs the same whether the environment runs
    // or not, and implying otherwise is what would fabricate a saving.
    expect(workings).not.toContain('h/day');
  });

  test('zero gigabytes is free, not negative', () => {
    expect(monthlyFromGbMonth({ ratePerGbMonth: 0.025, gigabytes: -5 }).monthly).toBe(0);
  });
});
