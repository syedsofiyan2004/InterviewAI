import {
  numberFrom,
  readBands,
  readMetricMatrix,
  readUnit,
  roleFor,
} from '../lambdas/shared/metric-matrix';
import type { MatrixResource } from '../lambdas/shared/metric-matrix';

/**
 * The transposed-matrix reader, and specifically the guarantee that it hands the SHEET on
 * rather than only its own reading of the sheet.
 *
 * The bug these tests exist for shipped: a Fargate row saying "10 tasks per day" was priced as
 * 10 tasks a month, and a task duration of 1440 minutes was billed as 1440 hours. Neither is
 * diagnosable from what a `MatrixResource` used to carry -- `raw` is a joined prose string,
 * `usage_amount` has already had readUnit's conversions applied, and `rows` is bare row numbers
 * with no label on any of them -- so by the time anything downstream could have caught it, what
 * the author typed was gone. `cells` is that text, kept verbatim.
 *
 * So the assertions below are about losslessness, not about arithmetic: the fixture is the
 * docs/Digital_Assets.xlsx shape, and every claim is either "this cell survived exactly as
 * written" or "the existing fields still say what they always said".
 */

/** A five-year capacity model's header: one label column, one column per fiscal band. */
const HEADER = ['Metric', '26-27', '27-28'];

/**
 * The grid, as sheet-structure.ts hands it over.
 *
 * Load-bearing details, each pinned by a test below:
 *  - the Aurora trio is ONE resource assembled from three rows (a class, a count and a disk),
 *    which is what makes a per-group `cells` array more than a one-element list;
 *  - Aurora storage is BLANK in 27-28 and filled in 26-27, so the same group has a silent cell
 *    in one band and a stated one in the other;
 *  - the two Fargate rows are the reported bug verbatim -- a per-day count and a duration in
 *    minutes -- and both are the kind of figure that only reads correctly next to its label;
 *  - the Cognito row is a (millions/yr) figure, where the converted amount and the cell text
 *    differ by six orders of magnitude, so "no conversion happened on the way into `cells`" is
 *    a distinction a test can actually see.
 */
const DATA_ROWS: string[][] = [
  ['Aurora instance class', 'db.r6g.large', 'db.r6g.xlarge'],
  ['Aurora instance count', '2', '3'],
  ['Aurora storage (GB)', '100.6', ''],
  ['ECS Fargate number of tasks per day', '10', '20'],
  ['ECS Fargate task duration (minutes)', '1440', '1440'],
  ['Cognito MAU (millions/yr)', '120', '150'],
];

/** 0-based grid index of the first metric row, so row 0 of DATA_ROWS is Excel row 2. */
const FIRST_DATA_ROW = 1;

/** 1-based Excel row for a DATA_ROWS index, mirroring what readMetricMatrix cites. */
const sheetRow = (index: number) => FIRST_DATA_ROW + index + 1;

const read = () => readMetricMatrix(HEADER, DATA_ROWS, FIRST_DATA_ROW);

const inBand = (resources: MatrixResource[], band: string) =>
  resources.filter((resource) => resource.scenario === band);

/** The one resource in `band` whose metric wording mentions `text`. */
const find = (resources: MatrixResource[], band: string, text: string): MatrixResource => {
  const matches = inBand(resources, band).filter((resource) => resource.metric.includes(text));
  expect(matches).toHaveLength(1);
  return matches[0];
};

describe('readMetricMatrix cells: the sheet, kept verbatim', () => {
  it('keeps every cell of a multi-row group, one entry per contributing row', () => {
    const aurora = find(read().resources, '26-27', 'Aurora');

    // Three metric rows, one resource: a size, a quantity and a disk on a single line item.
    expect(aurora.cells).toEqual([
      { row: sheetRow(0), label: 'Aurora instance class', value: 'db.r6g.large' },
      { row: sheetRow(1), label: 'Aurora instance count', value: '2' },
      { row: sheetRow(2), label: 'Aurora storage (GB)', value: '100.6' },
    ]);
  });

  it('cites every row it assembled a resource from exactly once in cells', () => {
    // The invariant, asserted across the whole reading rather than on one fixture row: a cell
    // that contributed to a group is in that group's `cells` once -- not zero times (the loss
    // this field removes) and not twice (which would double-count it downstream, since
    // canonical-workbook.ts sums a group's cells into one row's quantities).
    for (const resource of read().resources) {
      const rows = resource.cells.map((cell) => cell.row);
      expect(new Set(rows).size).toBe(rows.length);

      for (const row of resource.rows) {
        expect(rows.filter((candidate) => candidate === row)).toHaveLength(1);
        const cell = resource.cells.find((candidate) => candidate.row === row)!;
        // A row this resource was assembled from had a value in this band, by construction.
        expect(cell.value).not.toBe('');
      }
    }
  });

  it('carries a per-day count through as the literal text the author typed', () => {
    // The reported bug, at the point where it became unfixable. "10" and "Number of tasks per
    // day" have to arrive TOGETHER for anything downstream to multiply by the days in a month;
    // a bare 10 with the label discarded is indistinguishable from 10 a month, which is how it
    // was priced.
    const fargate = find(read().resources, '26-27', 'number of tasks per day');

    expect(fargate.cells).toEqual([
      { row: sheetRow(3), label: 'ECS Fargate number of tasks per day', value: '10' },
    ]);
    // A string, not a number: parsing is downstream's job, and a `10` that arrived as a number
    // has already had a decision made about it here.
    expect(typeof fargate.cells[0].value).toBe('string');
    expect(fargate.cells[0].label).toBe('ECS Fargate number of tasks per day');
  });

  it('carries a duration in minutes through unconverted', () => {
    // The other half of the same bug: 1440 minutes billed as 1440 hours. The label is the only
    // place "minutes" is ever written, so it travels with the figure.
    const duration = find(read().resources, '26-27', 'task duration');

    expect(duration.cells).toEqual([
      { row: sheetRow(4), label: 'ECS Fargate task duration (minutes)', value: '1440' },
    ]);
  });

  it('does not apply the label conversion on the way into cells', () => {
    // readUnit reads "(millions/yr)" and returns 10,000,000 a month, correctly. `cells` must
    // still say 120. If it said 10000000 the field would be a second copy of usage_amount and
    // would prove nothing about the file.
    const cognito = find(read().resources, '26-27', 'Cognito MAU');

    expect(cognito.cells).toEqual([
      { row: sheetRow(5), label: 'Cognito MAU (millions/yr)', value: '120' },
    ]);
    expect(cognito.usage_amount).toBe(10_000_000);
  });

  it('records a blank cell as a blank entry rather than omitting it', () => {
    // Aurora storage is empty in 27-28. That is the sheet declining to state a figure, which is
    // a different claim from the sheet stating 0 -- a stated 0 vetoes the group, an absent
    // figure does not -- so the silence has to be visible rather than inferred from a gap in a
    // list of row numbers.
    const aurora = find(read().resources, '27-28', 'Aurora');

    const storage = aurora.cells.find((cell) => cell.row === sheetRow(2));
    expect(storage).toEqual({ row: sheetRow(2), label: 'Aurora storage (GB)', value: '' });

    // ...and the existing field keeps its existing meaning: `rows` is what was priced, so the
    // blank row is not in it.
    expect(aurora.rows).toEqual([sheetRow(0), sheetRow(1)]);
    expect(aurora.cells).toHaveLength(3);
  });

  it('reads each band from its own column', () => {
    const resources = read().resources;

    expect(find(resources, '27-28', 'Aurora').cells.map((cell) => cell.value))
      .toEqual(['db.r6g.xlarge', '3', '']);
    expect(find(resources, '27-28', 'number of tasks per day').cells[0].value).toBe('20');
    expect(find(resources, '27-28', 'Cognito MAU').cells[0].value).toBe('150');
  });

  it('trims whitespace and nothing else', () => {
    // The one transformation allowed, and the reason it is allowed: an Excel cell routinely
    // arrives with a wrapped newline in it, and "  10\n " is the same figure as "10". Case,
    // punctuation, currency symbols and thousands separators are NOT touched, because each of
    // them is a claim about the value.
    const reading = readMetricMatrix(
      ['Metric', 'Dev', 'UAT'],
      [
        ['Aurora instance class', ' db.r6g.large\n', 'db.r6g.large'],
        ['Aurora instance count', '  2 ', '4'],
        ['Aurora storage (GB)', '1,024.50', '2048'],
      ],
      0,
    );
    const dev = find(reading.resources, 'dev', 'Aurora');

    expect(dev.cells.map((cell) => cell.value)).toEqual(['db.r6g.large', '2', '1,024.50']);
  });
});

describe('MatrixResource: the existing fields are unchanged', () => {
  // `cells` is additive. Everything below is what the reader produced before it existed, and
  // callers (api-handler/calculator-workbook.ts copies these field by field onto a
  // CalculationResource) and the report depend on all of it.
  it('still produces the same resources, sizes, counts and usage figures', () => {
    const reading = read();

    expect(reading.bands.map((band) => band.key)).toEqual(['26-27', '27-28']);
    expect(reading.bands.every((band) => band.kind === 'period')).toBe(true);

    const aurora = find(reading.resources, '26-27', 'Aurora');
    expect(aurora.service).toBe('Amazon Aurora');
    expect(aurora.size).toBe('db.r6g.large');
    expect(aurora.quantity).toBe('2');
    expect(aurora.disk_gb).toBe(100.6);
    expect(aurora.rows).toEqual([sheetRow(0), sheetRow(1), sheetRow(2)]);
    expect(aurora.metric).toBe('Aurora instance class + Aurora instance count + Aurora storage (GB)');
    expect(aurora.raw).toBe(
      'Aurora instance class | db.r6g.large ; Aurora instance count | 2 ; Aurora storage (GB) | 100.6',
    );

    const cognito = find(reading.resources, '26-27', 'Cognito MAU');
    expect(cognito.usage_amount).toBe(10_000_000);
    expect(cognito.usage_unit).toBe('monthly active users');
    expect(reading.conversions).toContain(
      'Cognito MAU (millions/yr): millions expanded, per-year divided by 12',
    );

    // The count aside is still the only place a Fargate task's shape is written down.
    const fargate = find(reading.resources, '26-27', 'number of tasks per day');
    expect(fargate.service).toBe('AWS Fargate');
    expect(fargate.quantity).toBe('10');
  });

  it('still excludes a label-only row as a heading', () => {
    const reading = readMetricMatrix(
      HEADER,
      [...DATA_ROWS, ['Managed services', '', '']],
      FIRST_DATA_ROW,
    );

    expect(reading.exclusions.map((exclusion) => exclusion.metric)).toContain('Managed services');
    expect(reading.resources.some((resource) => resource.metric.includes('Managed services')))
      .toBe(false);
  });

  it('still reads bands, numbers and units the way it did', () => {
    expect(readBands(HEADER).map((band) => band.column)).toEqual([1, 2]);
    expect(numberFrom('1,024.50')).toBe(1024.5);
    expect(numberFrom('db.r6g.large')).toBeUndefined();

    expect(readUnit('Aurora I/O requests (millions/yr)', 127.2)).toEqual({
      amount: 10_600_000,
      unit: 'requests/month',
      conversion: 'millions expanded, per-year divided by 12',
    });
    expect(readUnit('S3 storage (GB/month)', 400)).toEqual({
      amount: 400,
      unit: 'GB/month',
      conversion: undefined,
    });
  });
});

describe('roleFor is importable', () => {
  // It was private, and canonical-workbook.ts had to re-implement a minimal copy of the role
  // table because it could not import it -- two copies of the ordering argument that "class"
  // before "count" rests on, which is exactly how the two drift apart. These assertions are
  // the behaviour the copy was written against.
  it('returns the role the label states', () => {
    expect(roleFor('Aurora instance class')).toBe('class');
    expect(roleFor('MSK broker type')).toBe('class');
    expect(roleFor('Aurora instance count')).toBe('count');
    expect(roleFor('ECS Fargate number of tasks per day')).toBe('count');
    expect(roleFor('Aurora storage (GB)')).toBe('storage');
    expect(roleFor('OpenSearch data node vCPU')).toBe('vcpu');
    expect(roleFor('OpenSearch data node memory (GiB)')).toBe('ram');
    expect(roleFor('Cognito MAU (millions/yr)')).toBe('usage');
  });

  it('ignores the parenthetical, which is commentary and not the role', () => {
    // The documented failure: matching `vcpu` inside the aside turned 5 Dev tasks into a
    // 5-vCPU machine. A label that says "count" is a count whatever its aside mentions.
    expect(roleFor('ECS Fargate task count (1 vCPU/2GB each)')).toBe('count');
    expect(roleFor('Aurora instance count (Multi-AZ: writer + reader)')).toBe('count');
  });
});
