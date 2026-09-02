import {
  LINK_TEXT,
  NOT_PRICED,
  NO_LINK_TEXT,
  estimateTables,
  generateCalculatorDocxReport,
  pricingModelStatement,
} from '../lambdas/shared/calculator-docx';
import { CalculationRecordSchema, type CalculationRecord, type CalculationScenario } from '../schema/calculator';

/**
 * The Word deliverable for an estimate that spans many AWS Pricing Calculator links.
 *
 * The reference deliverable this reproduces carries eighteen of them: five fiscal years times
 * three pricing models for production, plus three pricing models for the combined lower
 * environments. Three properties are worth more than the rest here, because each of them is a
 * way for a document that LOOKS finished to be wrong:
 *
 *  - The links have to be real hyperlink relationships. Blue underlined text that goes nowhere
 *    passes a visual review and fails the only job this document has, so the assertions below go
 *    into `word/_rels/document.xml.rels` and match the targets, never the visible wording alone.
 *  - The mixed-pricing statement has to be present whenever a row is priced at a committed rate.
 *    Without it a reader budgets a discount that most of the bill never receives, and the
 *    document gives them no way to notice.
 *  - Missing data has to read as missing. A blank cell is indistinguishable from a zero-cost
 *    service and a derived ARR is indistinguishable from a recorded one, unless the document says.
 */

/**
 * jszip is not a direct dependency: it arrives with docx (and exceljs, and mammoth), which is
 * exactly why it is safe to read the package back with it here - if docx can write a .docx,
 * jszip is installed. Same helper as `mom-docx.test.ts`.
 */
async function unzip(buffer: Buffer) {
  const JSZip = (await import('jszip')).default;
  return await JSZip.loadAsync(buffer);
}

async function entry(buffer: Buffer, path: string): Promise<string> {
  const zip = await unzip(buffer);
  const file = zip.file(path);
  if (!file) throw new Error(`${path} missing from the package`);
  return await file.async('string');
}

/** Visible text only, with tags removed - what a reader actually sees in Word. */
const textOf = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Every external relationship target in the package, in relationship order. */
const externalTargets = (rels: string): string[] => (rels.match(/<Relationship [^>]*>/g) || [])
  .filter((tag) => tag.includes('TargetMode="External"'))
  .map((tag) => /Target="([^"]*)"/.exec(tag)?.[1] || '')
  // OOXML escapes the query separator, so unescape before comparing with the URL we passed in.
  .map((target) => target.replace(/&amp;/g, '&'));

const MODELS = ['On-Demand', '1-Year Reserved Instances', '3-Year Reserved Instances'];
const YEARS = ['FY26-27', 'FY27-28', 'FY28-29', 'FY29-30', 'FY30-31'];

/**
 * The eighteen-link shape, built the way a pipeline would have to build it today: the scope and
 * the pricing model concatenated into the label, because `CalculationScenario` has no field for
 * either. `kind` is the only thing separating the production years from the lower environments.
 */
function eighteenScenarios(): CalculationScenario[] {
  const scenarios: CalculationScenario[] = [];
  YEARS.forEach((year, yearIndex) => {
    MODELS.forEach((model, modelIndex) => {
      scenarios.push({
        key: `${year}-${modelIndex}`,
        label: `${year} | ${model}`,
        kind: 'period',
        monthly: 19688.31 + yearIndex * 30000 - modelIndex * 450,
        url: `https://calculator.aws/#/estimate?id=prod${yearIndex}${modelIndex}`,
        detail: `Fiscal ${year} usage column at ${model}`,
      });
    });
  });
  MODELS.forEach((model, modelIndex) => {
    scenarios.push({
      key: `lower-${modelIndex}`,
      label: `Dev + QA + UAT | ${model}`,
      kind: 'environment',
      monthly: 26248.92 - modelIndex * 250,
      url: `https://calculator.aws/#/estimate?id=lower${modelIndex}`,
      detail: `Combined lower environments at ${model}`,
    });
  });
  return scenarios;
}

function record(overrides: Record<string, unknown> = {}, resultOverrides: Record<string, unknown> = {}): CalculationRecord {
  return CalculationRecordSchema.parse({
    calculation_id: 'calc-1',
    owner_user_id: 'user-1',
    name: 'Digital Assets - AWS Pricing Calculator Estimates',
    prompt: 'Price the five-year capacity model at three pricing models.',
    region: 'eu-central-1',
    status: 'COMPLETED',
    environment_hours: [],
    resources: [],
    input_warnings: [],
    created_at: Date.UTC(2026, 7, 16),
    updated_at: Date.UTC(2026, 7, 16),
    result: {
      url: 'https://calculator.aws/#/estimate?id=primary',
      currency: 'USD',
      monthlyTotal: 19688.31,
      lineItems: [],
      environments: [],
      scenarios: eighteenScenarios(),
      assumptions: [
        'ECS Fargate: tasks PER DAY; average duration = 730 HOURS',
        'Aurora MySQL-Compatible: 2 DB instances across AZs (Multi-AZ HA)',
      ],
      warnings: [],
      ...resultOverrides,
    },
    ...overrides,
  });
}

const OPTIONS = {
  mixedPricingStatement: 'RI scope: Aurora + ElastiCache + OpenSearch; non-RI services remain On-Demand.',
  pricingModelNotes: [
    '1-Year RI: No Upfront for RI-eligible Aurora, ElastiCache and OpenSearch instance capacity.',
    '3-Year RI: Aurora uses Partial Upfront because Aurora No Upfront is only available for a 1-year reservation.',
    'ECS Fargate has no Reserved Instance purchase model, so Fargate remains On-Demand in the RI estimates.',
  ],
};

describe('An eighteen-link estimate becomes two tables, split the way the record says', () => {
  const tables = estimateTables(record(), OPTIONS);

  test('the fiscal-year band and the environment band each get their own table', () => {
    expect(tables.map((table) => table.kind)).toEqual(['period', 'environment']);
    expect(tables.map((table) => table.rows.length)).toEqual([15, 3]);
  });

  test('a row is one scope priced at one pricing model, recovered from the label', () => {
    expect(tables[0].rows.slice(0, 3).map((row) => [row.scope, row.pricingModel])).toEqual([
      ['FY26-27', 'On-Demand'],
      ['FY26-27', '1-Year Reserved Instances'],
      ['FY26-27', '3-Year Reserved Instances'],
    ]);
    expect(tables[1].rows.map((row) => row.scope)).toEqual(['Dev + QA + UAT', 'Dev + QA + UAT', 'Dev + QA + UAT']);
    expect(tables[1].rows.map((row) => row.pricingModel)).toEqual(MODELS);
  });

  test('the fiscal-year table is named as production only because a lower-environment table exists to contrast with it', () => {
    // Nothing in the record says a year band is production. The claim is only made when the
    // record also carries an environment band, which is what makes the contrast the reading.
    expect(tables[0].title).toBe('Production Estimates');
    expect(tables[1].title).toBe('Lower Environments');

    const yearsAlone = estimateTables(record({}, { scenarios: eighteenScenarios().filter((s) => s.kind === 'period') }), OPTIONS);
    expect(yearsAlone[0].title).toBe('Estimates by Fiscal Year');
  });

  test('each table says which of its two axes may be added up', () => {
    // Fifteen monthly figures in one table invite a sum that is wrong twice over: across years
    // because they are consecutive, and across pricing models because they are alternatives.
    expect(tables[0].prose).toContain('run one after another');
    expect(tables[0].prose).toContain('does not give a monthly bill');
    expect(tables[0].prose).toContain('alternative ways of buying the same capacity');

    expect(tables[1].prose).toContain('at the same time');
    expect(tables[1].prose).toContain('do add up');
    // And not the years' sentence, which would tell a reader to stop adding figures that add up.
    expect(tables[1].prose).not.toContain('does not give a monthly bill');
  });

  test('a label that is prose rather than a grid is left as the scope, with no pricing model invented', () => {
    // Five distinct scopes and five distinct trailing segments is not a grid; it is five
    // descriptions that happen to contain a dash. Reading "as the sheet specifies" as a pricing
    // model would put a sentence in the Pricing Model column.
    const [table] = estimateTables(record({}, {
      scenarios: [
        { key: 'baseline', label: 'Lift and shift - as the sheet specifies', kind: 'sizing', monthly: 1000, url: null },
        { key: 'rightsized', label: 'Right-sized - one family down', kind: 'sizing', monthly: 800, url: null },
      ],
    }), OPTIONS);

    expect(table.rows.map((row) => row.scope)).toEqual([
      'Lift and shift - as the sheet specifies',
      'Right-sized - one family down',
    ]);
    expect(table.rows.map((row) => row.pricingModel)).toEqual([null, null]);
  });

  test('scenarios that share one kind stay in a single table rather than being split on a guess', () => {
    const single = estimateTables(record({}, {
      scenarios: eighteenScenarios().map((scenario) => ({ ...scenario, kind: 'period' as const })),
    }), OPTIONS);

    expect(single).toHaveLength(1);
    expect(single[0].rows).toHaveLength(18);
  });
});

describe('Rendering the document', () => {
  let buffer: Buffer;
  let xml: string;
  let text: string;
  let rels: string;

  beforeAll(async () => {
    buffer = await generateCalculatorDocxReport(record(), OPTIONS);
    xml = await entry(buffer, 'word/document.xml');
    text = textOf(xml);
    rels = await entry(buffer, 'word/_rels/document.xml.rels');
  });

  test('it is a real OOXML package rather than a renamed file', async () => {
    const names = Object.keys((await unzip(buffer)).files);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/styles.xml');
    expect(names).toContain('word/_rels/document.xml.rels');
  });

  test('every one of the eighteen links is a hyperlink relationship targeting the real URL', () => {
    // The assertion the whole module exists for. Text styled to look like a link is not a link,
    // so this reads the relationship part and matches targets - and counts them, because
    // seventeen working links and one dead one is the failure nobody would notice.
    const targets = externalTargets(rels);
    const expected = eighteenScenarios().map((scenario) => scenario.url);

    expect(targets).toHaveLength(18);
    expect(new Set(targets).size).toBe(18);
    expected.forEach((url) => expect(targets).toContain(url));
    // And each one is referenced from the body, not merely declared in the relationships.
    expect((xml.match(/<w:hyperlink [^>]*r:id="/g) || []).length).toBe(18);
  });

  test('the link cells read as prose, and no raw URL is printed in a table cell', () => {
    // A 60-character calculator.aws URL in a five-column table leaves the other four columns
    // unreadable, which is the reason a PDF cannot carry this document's shape.
    expect((text.match(new RegExp(LINK_TEXT, 'g')) || []).length).toBe(18);
    expect(text).not.toContain('https://calculator.aws');
  });

  test('both tables render with their header row repeated across a page break', () => {
    expect((xml.match(/<w:tbl>/g) || []).length).toBe(2);
    expect(xml).toContain('<w:tblHeader');
    expect(text).toContain('Production Estimates');
    expect(text).toContain('Lower Environments');
  });

  test('MRR and ARR are both stated per row and both defined in the document', () => {
    expect(text).toContain('MRR (USD)');
    expect(text).toContain('ARR (USD)');
    // FY26-27 On-Demand: $19,688.31 a month, so $236,259.72 over twelve months.
    expect(text).toContain('$19,688.31');
    expect(text).toContain('$236,259.72');
    // A figure whose basis is unstated gets misread, so the basis is in the document.
    expect(text).toContain('MRR is the monthly recurring cost');
    expect(text).toContain('Monthly cost');
    expect(text).toContain('ARR is the annual recurring cost');
    expect(text).toContain('Total 12 months');
  });

  test('a derived ARR says it was derived, and warns where an upfront charge makes it understate the year', () => {
    // The reference deliverable's 3-year RI rows cost MORE over twelve months than twelve
    // monthly bills, because of the Aurora partial upfront. Printing MRR x 12 there without
    // saying so understates the first year by exactly the upfront amount.
    expect(text).toContain('ARR was calculated here as MRR x 12');
    expect(text).toContain('understates the first year by that upfront amount');
  });

  test('a recorded twelve-month total is used instead of the derivation when the caller has one', async () => {
    const withRecorded = await generateCalculatorDocxReport(record(), {
      ...OPTIONS,
      // The reference figure for FY26-27 3-Year RI: not 18,782.38 x 12 = 225,388.56, because
      // the twelve-month total carries the Aurora partial upfront.
      annualByScenarioKey: { 'FY26-27-2': 231772.56 },
    });
    const recordedText = textOf(await entry(withRecorded, 'word/document.xml'));

    expect(recordedText).toContain('$231,772.56');
    expect(recordedText).not.toContain('$225,388.56');
    expect(recordedText).toContain('17 of the 18 rows');
  });

  test('the caller\'s mixed-pricing statement and per-service notes are carried verbatim', () => {
    expect(text).toContain('RI scope: Aurora + ElastiCache + OpenSearch; non-RI services remain On-Demand.');
    expect(text).toContain('Aurora No Upfront is only available for a 1-year reservation');
    expect(text).toContain('ECS Fargate has no Reserved Instance purchase model');
    expect(text).toContain('does not change the underlying workload configuration');
  });

  test('the global assumptions and the pricing models covered are stated before any figure', () => {
    expect(text).toContain('tasks PER DAY; average duration = 730 HOURS');
    expect(text).toContain('Multi-AZ HA');
    // The ampersand arrives escaped: this is raw OOXML, not rendered text.
    expect(text).toContain('On-Demand | 1-Year Reserved Instances | 3-Year Reserved Instances | MRR &amp; ARR');
  });

  test('dates are dd-MM-yyyy, the standing convention across the hub', async () => {
    // 16 August 2026, never 2026-08-16 and never 08-16-2026.
    expect(text).toContain('Estimate created 16-08-2026');
    expect(text).toMatch(/Document generated \d{2}-\d{2}-\d{4}/);
    expect(text).not.toContain('2026-08-16');
    expect(textOf(await entry(buffer, 'word/footer1.xml'))).toContain('16-08-2026');
  });
});

describe('The mixed-pricing-model statement is mandatory rather than optional', () => {
  const committed = () => estimateTables(record(), OPTIONS);

  test('the caller\'s statement is used when one is supplied', () => {
    expect(pricingModelStatement(committed(), OPTIONS.mixedPricingStatement))
      .toBe(OPTIONS.mixedPricingStatement);
  });

  test('a committed-rate row with no statement supplied gets the gap stated instead of silence', () => {
    // The failure this prevents: a reader concludes the whole estimate is committed and
    // under-budgets everything the reservation does not cover.
    const statement = pricingModelStatement(committed());

    expect(statement).toContain('Committed-rate scope was not recorded');
    expect(statement).toContain('remains On-Demand');
    expect(statement).toContain('understate the bill');
  });

  test('the gap wording reaches the rendered document, not just the helper', async () => {
    const silent = await generateCalculatorDocxReport(record(), { pricingModelNotes: [] });
    const silentText = textOf(await entry(silent, 'word/document.xml'));

    expect(silentText).toContain('Committed-rate scope was not recorded');
    expect(silentText).toContain('No per-service notes were supplied');
  });

  test('an estimate with no committed row says so positively rather than saying nothing', () => {
    const onDemandOnly = estimateTables(record({}, {
      scenarios: YEARS.map((year, index) => ({
        key: year, label: `${year} | On-Demand`, kind: 'period' as const, monthly: 1000 + index, url: null,
      })),
    }));

    expect(pricingModelStatement(onDemandOnly)).toContain('No row above uses a committed-rate purchase model');
  });

  test('an unrecorded pricing model is admitted rather than assumed to be On-Demand', () => {
    const unknown = estimateTables(record({}, {
      scenarios: [
        { key: 'baseline', label: 'Lift and shift', kind: 'sizing', monthly: 1000, url: null },
        { key: 'rightsized', label: 'Right-sized', kind: 'sizing', monthly: 800, url: null },
      ],
    }));

    expect(pricingModelStatement(unknown)).toContain('was not recorded per scenario');
    expect(pricingModelStatement(unknown)).toContain('cannot state which rates are committed');
  });

  test('a caller that names its own committed models overrides the vocabulary match', () => {
    const tables = estimateTables(record(), {
      isCommittedPricingModel: (model) => model === 'House Term Deal',
    });

    // Nothing here is "House Term Deal", so no row counts as committed under the override.
    expect(tables.flatMap((table) => table.rows).every((row) => !row.committed)).toBe(true);
    expect(pricingModelStatement(tables)).toContain('No row above uses a committed-rate purchase model');
  });
});

describe('Degrading honestly when the record is incomplete', () => {
  test('a scenario with no link renders a stated gap, and no hyperlink for it', async () => {
    const scenarios = eighteenScenarios();
    scenarios[4].url = null;
    scenarios[17].url = null;

    const buffer = await generateCalculatorDocxReport(record({}, { scenarios }), OPTIONS);
    const xml = await entry(buffer, 'word/document.xml');
    const text = textOf(xml);

    expect(text).toContain(NO_LINK_TEXT);
    // Sixteen relationships, not eighteen with two pointing nowhere.
    expect(externalTargets(await entry(buffer, 'word/_rels/document.xml.rels'))).toHaveLength(16);
    expect((xml.match(/<w:hyperlink [^>]*r:id="/g) || []).length).toBe(16);
    // And the count is stated above the table, because nobody audits fifteen cells for blanks.
    expect(text).toContain('1 of these 15 rows has no shareable estimate link');
  });

  test('a missing monthly figure renders as not priced rather than as zero', async () => {
    const scenarios = eighteenScenarios();
    scenarios[0].monthly = null;

    const text = textOf(await entry(
      await generateCalculatorDocxReport(record({}, { scenarios }), OPTIONS),
      'word/document.xml',
    ));

    // $0.00 in a client document reads as free, which is a different claim from "AWS returned
    // no rate for this row".
    expect(text).toContain(NOT_PRICED);
    expect(text).toContain('carries no figure');
    expect(text).not.toContain('$0.00');
  });

  test('an empty scenario list still yields a valid document that explains the gap', async () => {
    const buffer = await generateCalculatorDocxReport(
      record({ status: 'FAILED', error_message: 'The pricing run ran out of turns.', result: undefined }),
      OPTIONS,
    );
    const text = textOf(await entry(buffer, 'word/document.xml'));

    expect(buffer.length).toBeGreaterThan(4000);
    expect(text).toContain('No scenarios were priced for this estimate');
    expect(text).toContain('records that gap rather than presenting an empty table');
    expect(text).toContain('The estimate is failed as at');
    expect(text).toContain('The pricing run ran out of turns.');
  });

  test('a record with no bands but one top-level estimate falls back to a single-row table', async () => {
    // The prose-estimate path. One link is still worth a table; inventing a split for it is not.
    const tables = estimateTables(record({}, { scenarios: [] }), OPTIONS);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(1);

    const buffer = await generateCalculatorDocxReport(record({}, { scenarios: [] }), OPTIONS);
    expect(externalTargets(await entry(buffer, 'word/_rels/document.xml.rels')))
      .toEqual(['https://calculator.aws/#/estimate?id=primary']);
  });

  test('a legacy record stored before kind and url existed still renders', async () => {
    // There are real records like this in DynamoDB. A throw here would mean every estimate
    // priced before scenario links existed loses its Word document.
    const buffer = await generateCalculatorDocxReport(record({}, {
      scenarios: [
        { key: 'baseline', label: 'Lift and shift', monthly: 1000 },
        { key: 'rightsized', label: 'Right-sized', monthly: 750 },
      ] as unknown as CalculationScenario[],
    }), OPTIONS);
    const text = textOf(await entry(buffer, 'word/document.xml'));

    expect(text).toContain('Sizing Estimates');
    expect(text).toContain('Not recorded');
    expect(text).toContain(NO_LINK_TEXT);
  });

  test('an unnamed estimate with no assumptions and no notes does not throw', async () => {
    const buffer = await generateCalculatorDocxReport(record({ name: '', region: undefined }, {
      assumptions: [], scenarios: [], url: null, monthlyTotal: null,
    }));
    const text = textOf(await entry(buffer, 'word/document.xml'));

    expect(buffer.length).toBeGreaterThan(3000);
    expect(text).toContain('AWS Cost Estimate');
    expect(text).toContain('No workload assumptions were recorded');
  });

  test('a currency other than USD is labelled rather than shown as dollars', async () => {
    const text = textOf(await entry(
      await generateCalculatorDocxReport(record({}, { currency: 'INR' }), OPTIONS),
      'word/document.xml',
    ));

    expect(text).toContain('MRR (INR)');
    expect(text).toContain('INR 19,688.31');
    expect(text).not.toContain('$19,688.31');
  });

  test('control characters and non-ASCII service names survive or are stripped, never corrupt the package', async () => {
    const buffer = await generateCalculatorDocxReport(record({}, {
      assumptions: ['Aurora\u0001 priced in Frankfurt', 'Owner: Zoë Müller'],
    }), OPTIONS);
    const text = textOf(await entry(buffer, 'word/document.xml'));

    expect(text).toContain('Aurora priced in Frankfurt');
    expect(text).toContain('Zoë Müller');
    expect(text).not.toContain('\u0001');
  });
});
