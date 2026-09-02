import { readSectionStack } from '../lambdas/shared/section-stack';

/**
 * The grids below are trimmed transcriptions of real sheets, dumped through the same
 * merge-blanking that shared/workbook.ts applies - so a merged A5:J5 banner appears as one
 * populated cell and nine empties, which is the shape the reader actually receives. Row
 * counts are cut down but the ROW ORDER and the cell shapes are as the workbooks have them,
 * because those are the only properties under test.
 */

/**
 * docs/Rainbow_TCO_30Apr2026_v1_2.xlsx, sheet "Consolidated Master View".
 *
 * The sheet this module exists for: one header row stated ONCE at index 3, then group
 * headings buried in the data with no blank rows anywhere to separate them.
 */
const consolidatedMasterView = [
  ['Rainbow Hospitals - Consolidated Master Pricing View (30-Apr-2026 - v1.3)'],
  ['All figures USD. Validated line-by-line against the CtrlS PDF.'],
  [],
  ['S.No', 'Server / Service', 'Hosting Env', 'Category', 'Region', 'Instance', 'Monthly (USD)', 'Annual (USD)', 'Scope', 'Notes'],
  ['CtrlS PRODUCTION (PDF Validated)'],
  ['1', 'RAINDC03', 'CtrlS -> AWS', 'EC2 - Prod', 'Hyderabad', 'm6i.xlarge', '226.67', '2720.04', 'Phase 1', 'AD'],
  ['2', 'RAINHIS01', 'CtrlS -> AWS', 'EC2 - Prod', 'Hyderabad', 'r6i.2xlarge', '604.80', '7257.60', 'Phase 1', 'HIS app'],
  ['CtrlS NON-PRODUCTION (PDF Validated)'],
  ['15', 'RCHECCDEC', 'CtrlS -> AWS', 'EC2 - Non-Prod (SAP)', 'Hyderabad', 'm6a.xlarge', '188.34', '2260.08', 'Phase 1', 'SAP Dev'],
  ['16', 'RCHECCQAS', 'CtrlS -> AWS', 'EC2 - Non-Prod (SAP)', 'Hyderabad', 'm6a.xlarge', '188.34', '2260.08', 'Phase 1', 'SAP QA'],
  ['DR - MUMBAI (PDF Validated)'],
  ['25', 'RAINDR01', 'AWS DR', 'EC2 - DR', 'Mumbai', 'm6i.large', '113.15', '1357.80', 'Phase 1', 'Pilot light'],
  ['REMOVED - PACS & AD out of scope'],
  [],
  [],
  ['CONSOLIDATED TOTALS (PDF-Validated)'],
  ['', 'CtrlS Production', '', '', '', '', '10962.73', '131552.76'],
  ['', 'CtrlS Non-Production', '', '', '', '', '2465.10', '29581.20'],
];

describe('readSectionStack on a sheet that names no sections', () => {
  it('returns exactly one unlabelled section spanning every data row, because a plain single-table sheet is the overwhelmingly common case and splitting it would make the reader unusable', () => {
    const sections = readSectionStack([
      ['Server Name', 'vCPU', 'RAM (GiB)'],
      ['web-01', '4', '16'],
      ['web-02', '4', '16'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBeUndefined();
    expect(sections[0].labelRow).toBeUndefined();
    expect(sections[0].headerRow).toBe(0);
    expect(sections[0].firstDataRow).toBe(1);
    expect(sections[0].lastDataRow).toBe(2);
    expect(sections[0].dataRows).toEqual([1, 2]);
  });

  it('still returns one section when the sheet has no column names either, so a bare block of rows is not lost for want of a header', () => {
    const sections = readSectionStack([
      ['web-01', '4', '16'],
      ['web-02', '4', '16'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].headerRow).toBeUndefined();
    expect(sections[0].dataRows).toEqual([0, 1]);
  });

  it('treats a title above a single table as that table\'s label rather than as a section of its own, which is the shape of COSEC "Server Inventory" and of most sheets anyone uploads', () => {
    const serverInventory = [
      ['COSEC - AWS Server Inventory & Right-Sizing'],
      ['110 servers from the Azure export, right-sized against eu-central-1 on-demand rates.'],
      [],
      ['S.No', 'Server Name', 'Environment', 'OS', 'vCPU', 'RAM (GiB)', 'Recommended Instance', 'Hourly Rate ($)'],
      ['1', 'COSECAPP01', 'Production', 'Windows 2019', '8', '32', 'm6i.2xlarge', '0.4224'],
      ['2', 'COSECAPP02', 'Production', 'Windows 2019', '8', '32', 'm6i.2xlarge', '0.4224'],
      ['', 'TOTAL', '', '', '16', '64', '', '0.8448'],
    ];

    const sections = readSectionStack(serverInventory);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('COSEC - AWS Server Inventory & Right-Sizing');
    expect(sections[0].labelRow).toBe(0);
    expect(sections[0].headerRow).toBe(3);
    expect(sections[0].dataRows).toEqual([4, 5, 6]);
  });

  it('takes the heading from the FIRST row of a title-and-subtitle pair, because the second row is a sentence of explanation and would make a useless section name', () => {
    const sections = readSectionStack(consolidatedMasterView);

    expect(sections.map((section) => section.label)).not.toContain(
      'All figures USD. Validated line-by-line against the CtrlS PDF.',
    );
  });
});

describe('readSectionStack on the stacked "Consolidated Master View" sheet', () => {
  it('splits the one findBlocks table into its four populated groups, in sheet order', () => {
    const sections = readSectionStack(consolidatedMasterView);

    expect(sections.map((section) => section.label)).toEqual([
      'CtrlS PRODUCTION (PDF Validated)',
      'CtrlS NON-PRODUCTION (PDF Validated)',
      'DR - MUMBAI (PDF Validated)',
      'CONSOLIDATED TOTALS (PDF-Validated)',
    ]);
  });

  it('keeps the non-production rows in the non-production section, which is the whole point: filing a QA and Dev estate as production moves the figure the client budgets against', () => {
    const sections = readSectionStack(consolidatedMasterView);
    const production = sections[0];
    const nonProduction = sections[1];

    expect(production.dataRows).toEqual([5, 6]);
    expect(nonProduction.dataRows).toEqual([8, 9]);
    // Belt and braces on the misattribution itself: the SAP QA and Dev rows must not have
    // reached the section headed "CtrlS PRODUCTION".
    expect(production.dataRows).not.toContain(8);
    expect(production.dataRows).not.toContain(9);
  });

  it('points every section at the shared header row above the first banner, since sections two onward state no column names of their own', () => {
    const sections = readSectionStack(consolidatedMasterView);

    expect(sections.map((section) => section.headerRow)).toEqual([3, 3, 3, 3]);
    // The header sits ABOVE the label of every section after the first, so a reader that
    // only ever looked below a banner for column names would find none.
    expect(sections[1].headerRow!).toBeLessThan(sections[1].labelRow!);
  });

  it('never reports a banner row as a data row, so no group heading can reach a pricing loop as a machine with no size and no quantity', () => {
    const sections = readSectionStack(consolidatedMasterView);
    const bannerRows = [0, 1, 4, 7, 10, 12, 15];

    const claimed = sections.flatMap((section) => section.dataRows);
    for (const banner of bannerRows) {
      expect(claimed).not.toContain(banner);
    }
  });

  it('drops the "REMOVED - PACS & AD out of scope" heading entirely because nothing follows it, rather than emitting a section with an empty range for every caller to special-case', () => {
    const sections = readSectionStack(consolidatedMasterView);

    expect(sections.map((section) => section.label)).not.toContain('REMOVED - PACS & AD out of scope');
    // And the heading is not silently absorbed into the totals group that follows it.
    expect(sections[3].labelRow).toBe(15);
  });

  it('carries the totals group across the blank rows that separate it, because a blank row inside a section is spacing and not a boundary', () => {
    const sections = readSectionStack(consolidatedMasterView);

    expect(sections[3].dataRows).toEqual([16, 17]);
    expect(sections[3].label).toBe('CONSOLIDATED TOTALS (PDF-Validated)');
  });
});

describe('readSectionStack when each section states its own header row', () => {
  it('gives each section its own column names on "HIS BOM - KareXpert", where column I means "Total $/mo" in the first table and "Est $/mo" in the second, so sharing one header would read a total as a rate', () => {
    const hisBom = [
      ['Rainbow HIS BOM - KareXpert'],
      ['Figures taken from the KareXpert BOM dated 22-Apr-2026.'],
      [],
      ['#', 'Component', 'Instance', 'Qty', 'vCPU', 'RAM', 'Storage', 'Rate $/mo', 'Total $/mo', 'Notes'],
      ['1', 'EKS worker node', 'm6i.2xlarge', '3', '8', '32', '200 GB', '280.32', '840.96', 'HIS app tier'],
      [],
      ['Additional AWS Services (from KareXpert BOM)'],
      // The populated cells of a real header row are not contiguous; the middle columns of
      // the first table have no counterpart in the second.
      ['#', 'Service', 'Description', '', '', '', '', '', 'Est $/mo', 'Notes'],
      ['1', 'Amazon MQ', 'HL7 message broker', '', '', '', '', '', '96.40', 'mq.m5.large'],
    ];

    const sections = readSectionStack(hisBom);

    expect(sections).toHaveLength(2);
    expect(sections[0].headerRow).toBe(3);
    expect(sections[1].headerRow).toBe(7);
    expect(sections[1].label).toBe('Additional AWS Services (from KareXpert BOM)');
    expect(sections[1].dataRows).toEqual([8]);
  });

  it('reports no header row for a section that has none, because "Assumptions & Scope" is banner-and-label/value throughout and inventing a header would consume its first pair', () => {
    const assumptions = [
      ['REGION & DR'],
      ['Primary region', 'AWS Europe (Frankfurt) eu-central-1 - chosen to match the existing Azure footprint and the data-residency commitment.'],
      ['DR region', 'AWS Europe (Ireland) eu-west-1 - pilot light, RPO 15 min / RTO 4 h.'],
      [],
      ['MIGRATION STRATEGY'],
      ['Approach', 'Lift-and-shift via AWS Application Migration Service, then right-size from month 3 on observed utilisation.'],
    ];

    const sections = readSectionStack(assumptions);

    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.label)).toEqual(['REGION & DR', 'MIGRATION STRATEGY']);
    expect(sections[0].headerRow).toBeUndefined();
    expect(sections[1].headerRow).toBeUndefined();
    // A label/value pair is two populated cells, and taking it for a header row would lose it.
    expect(sections[0].dataRows).toEqual([1, 2]);
  });

  it('refuses to lend a wide table\'s header to a narrow label/value section beneath it, as "Pricing Inputs" would otherwise map an EBS $/GB-month rate onto the column named "Instance Type" and its 0.0952 onto "vCPU"', () => {
    const pricingInputs = [
      ['NEW-BUILD / SPECIAL INSTANCE TYPES'],
      ['Instance Type', 'vCPU', 'RAM (GiB)', 'On-Demand ($/hr)', '3-Yr RI ($/hr)'],
      ['m6i.large', '2', '8', '0.0984', '0.0413'],
      [],
      ['STORAGE, BACKUP, DRS, NETWORK RATES'],
      ['EBS gp3 storage rate ($/GB-month)', '0.0952'],
      ['S3 Standard rate ($/GB-month)', '0.0245'],
    ];

    const sections = readSectionStack(pricingInputs);

    expect(sections).toHaveLength(2);
    expect(sections[0].headerRow).toBe(1);
    expect(sections[1].headerRow).toBeUndefined();
    expect(sections[1].dataRows).toEqual([5, 6]);
  });
});

describe('readSectionStack on repeated header rows', () => {
  it('starts a new section where a sheet restates the same column names with no banner to announce them, instead of pricing a machine called "Server Name"', () => {
    const sections = readSectionStack([
      ['Server Name', 'vCPU', 'RAM (GiB)', 'Disk (GB)'],
      ['web-01', '4', '16', '200'],
      ['web-02', '4', '16', '200'],
      ['Server Name', 'vCPU', 'RAM (GiB)', 'Disk (GB)'],
      ['uat-01', '2', '8', '100'],
    ]);

    expect(sections).toHaveLength(2);
    expect(sections[0].dataRows).toEqual([1, 2]);
    expect(sections[1].headerRow).toBe(3);
    expect(sections[1].dataRows).toEqual([4]);
    // The restated header is a header, not a machine.
    expect(sections.flatMap((section) => section.dataRows)).not.toContain(3);
  });

  it('reads the second band set of docs/Digital_Assets.xlsx against its own header, because the lower-environment table states Dev, QA and UAT where the table above states five fiscal years, and inheriting the wrong one prices UAT volumes as a production year', () => {
    const digitalAssets = [
      [],
      [],
      ['Peak-to-average traffic ratio (assumption)'],
      [],
      ['Metric', '26-27', '27-28', '28-29', '29-30', '30-31'],
      ['Registered users', '120000', '180000', '250000', '320000', '400000'],
      ['Peak concurrent sessions', '2400', '3600', '5000', '6400', '8000'],
      [],
      ['Lower Environment'],
      [],
      ['Metric', 'Dev', 'Testing (QA)', 'UAT'],
      ['Registered users', '500', '2000', '12000'],
      ['Peak concurrent sessions', '20', '80', '400'],
    ];

    const sections = readSectionStack(digitalAssets);

    expect(sections).toHaveLength(2);
    expect(sections[0].headerRow).toBe(4);
    expect(sections[1].label).toBe('Lower Environment');
    expect(sections[1].headerRow).toBe(10);
    expect(sections[1].dataRows).toEqual([11, 12]);
  });

  it('does not promote a mid-table row of short text cells to a header, because a TOTAL row padded with dashes passes every shape test and promoting it would cut the table in half', () => {
    const sections = readSectionStack([
      ['Server', 'Environment', 'Region', 'Notes'],
      ['web-01', 'Prod', 'Hyderabad', 'AD replica'],
      ['TOTAL', '-', '-', 'pending review'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].headerRow).toBe(0);
    expect(sections[0].dataRows).toEqual([1, 2]);
  });

  it('still finds a section in a table with no numbers in it anywhere, where every row passes the header tests and a naive reader is left with no data rows and no sections at all', () => {
    const sections = readSectionStack([
      ['Region', 'Purpose', 'Notes'],
      ['eu-central-1', 'Primary', 'Matches the existing Azure footprint'],
      ['eu-west-1', 'DR', 'Pilot light'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].headerRow).toBe(0);
    expect(sections[0].dataRows).toEqual([1, 2]);
  });
});

describe('readSectionStack on one-cell rows that are not section headings', () => {
  it('reads a run of numbered prose as one heading and its commentary, not as one section per sentence, which is what "AD & PACS Infrastructure" rows 41-50 would otherwise produce', () => {
    const adAndPacs = [
      ['Rainbow Hospitals - AD & PACS Infrastructure Review'],
      ['Reconciled with Narsima on 25-Apr-2026.'],
      [],
      ['KEY ARCHITECTURE DECISIONS'],
      ['1. RAINDC03/02 (rainbow.local) stays in the Primary TCO - lift-and-shift. No changes.'],
      ['2. Branch AD servers remain on-premises and are NOT migrated to AWS.'],
      ['3. PACS storage stays on CtrlS until the imaging refresh completes.'],
      [],
      ['AD ENVIRONMENT SUMMARY (From Narsima - 25-Apr-2026)'],
      ['Total AD Objects', '3,374 (users + computers)'],
      ['Domain Controllers', '4 (2 primary + 2 branch)'],
      [],
      ['BRANCH AD SERVER INVENTORY (25 Locations - On-Premises, NOT migrated to AWS)'],
      ['S.No', 'Location', 'Server Name', 'Role', 'OS', 'vCPU', 'RAM (GiB)', 'Notes'],
      ['1', 'Hyderabad', 'RAINDC03', 'PDC', 'Windows 2019', '4', '16', 'Primary'],
      ['2', 'Vijayawada', 'VJADC01', 'RODC', 'Windows 2016', '2', '8', 'Branch'],
      [],
      ['AWS SERVICES - AD & PACS INFRASTRUCTURE (Added to TCO)'],
      ['S.No', 'Service', 'Purpose', 'Region', 'Sizing', 'Monthly (USD)', 'Annual (USD)', 'Notes'],
      ['1', 'FSx for Windows', 'PACS share', 'Hyderabad', '2 TB SSD', '437.00', '5244.00', 'Multi-AZ'],
    ];

    const sections = readSectionStack(adAndPacs);

    expect(sections.map((section) => section.label)).toEqual([
      'AD ENVIRONMENT SUMMARY (From Narsima - 25-Apr-2026)',
      'BRANCH AD SERVER INVENTORY (25 Locations - On-Premises, NOT migrated to AWS)',
      'AWS SERVICES - AD & PACS INFRASTRUCTURE (Added to TCO)',
    ]);
    // Nine sentences of architecture notes, one per row, produced no sections at all.
    expect(sections.map((section) => section.label)).not.toContain('KEY ARCHITECTURE DECISIONS');
  });

  it('does not carry a heading across the blank row that ends its run, since labelling the AD environment pairs "KEY ARCHITECTURE DECISIONS" would attribute them to the wrong heading entirely', () => {
    const sections = readSectionStack([
      ['KEY ARCHITECTURE DECISIONS'],
      ['1. Branch AD servers remain on-premises.'],
      [],
      ['AD ENVIRONMENT SUMMARY'],
      ['Total AD Objects', '3,374 (users + computers)'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('AD ENVIRONMENT SUMMARY');
    expect(sections[0].labelRow).toBe(3);
    expect(sections[0].dataRows).toEqual([4]);
  });

  it('recognises a heading whose lone cell sits in column B, because "Consolidated Summary" leaves column A empty down the whole sheet and a heading is flush with its own table, not with column A', () => {
    const consolidatedSummary = [
      ['', 'Rainbow Hospitals - Consolidated Summary'],
      ['', 'Primary: Hyderabad | DR: Mumbai Active-Passive | 3-Yr No Upfront'],
      [],
      ['', 'Component', 'Monthly (USD)', 'Annual (USD)', 'Share (%)'],
      ['', 'Compute (EC2)', '18420.55', '221046.60', '52%'],
      ['', 'Storage (EBS/S3/FSx)', '4110.20', '49322.40', '12%'],
    ];

    const sections = readSectionStack(consolidatedSummary);

    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe('Rainbow Hospitals - Consolidated Summary');
    expect(sections[0].headerRow).toBe(3);
    expect(sections[0].dataRows).toEqual([4, 5]);
  });

  it('does not split a data block on a stray number left behind by a merged cell, which is a measurement that lost its neighbours rather than a heading called "3000"', () => {
    const sections = readSectionStack([
      ['Server', 'vCPU', 'RAM (GiB)'],
      ['web-01', '4', '16'],
      ['3000'],
      ['web-02', '4', '16'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].dataRows).toEqual([1, 2, 3]);
  });

  it('does not split a data block on a stray value indented past the table\'s first column, the shape a vertical merge leaves behind, because nobody writes a heading to the right of the rows it introduces', () => {
    const sections = readSectionStack([
      ['Server', 'Volume type', 'Size (GB)'],
      ['web-01', 'gp3', '200'],
      ['', 'gp3'],
      ['web-02', 'gp3', '200'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].dataRows).toEqual([1, 2, 3]);
  });

  it('returns no sections for a sheet of nothing but headings, since there is no data row for one to cover', () => {
    expect(readSectionStack([['REGION & DR'], [], ['MIGRATION STRATEGY'], ['PRICING DISCLAIMER']])).toEqual([]);
  });
});

describe('readSectionStack on malformed and degenerate grids', () => {
  it('returns no sections for an entirely empty sheet rather than one section with an incoherent empty range', () => {
    expect(readSectionStack([])).toEqual([]);
    expect(readSectionStack([[], [], []])).toEqual([]);
  });

  it('reads a ragged grid without assuming every row has the same number of cells, because a CSV line with fewer commas and a sheet row that ends early both arrive short', () => {
    const sections = readSectionStack([
      ['Location', 'Server', 'Role', 'OS', 'vCPU', 'RAM (GiB)'],
      ['Hyderabad', 'RAINDC03', 'PDC', 'Windows 2019', '4', '16'],
      ['Vijayawada', 'VJADC01', 'RODC'],
      ['Nellore', 'NLRDC01', 'RODC', 'Windows 2016'],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].headerRow).toBe(0);
    expect(sections[0].dataRows).toEqual([1, 2, 3]);
  });

  it('accepts numbers, nulls and undefined in place of strings, and counts a stated zero as a populated cell rather than an empty one', () => {
    const sections = readSectionStack([
      ['Instance Type', 'vCPU', 'RAM (GiB)', 'On-Demand ($/hr)'],
      ['m6i.xlarge', 4, 16, 0.1968],
      ['r6i.2xlarge', 8, null, undefined],
      ['c6i.large', 2, 4, 0],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].headerRow).toBe(0);
    // Row 3's last cell is the number 0. A reader that treated it as empty would drop the row
    // from the section and, downstream, silently price a zero-rate instance as unpriced.
    expect(sections[0].dataRows).toEqual([1, 2, 3]);
    expect(sections[0].lastDataRow).toBe(3);
  });

  it('ends the last section on its last populated row so trailing blank rows are not claimed as data', () => {
    const sections = readSectionStack([
      ['Service', 'Monthly (USD)', 'Annual (USD)'],
      ['Amazon MQ', '96.40', '1156.80'],
      ['FSx for Windows', '437.00', '5244.00'],
      [],
      [],
      [],
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].lastDataRow).toBe(2);
    expect(sections[0].dataRows).toEqual([1, 2]);
  });

  it('returns no sections for a heading followed only by blank rows, the shape of a group emptied out of scope', () => {
    expect(readSectionStack([['REMOVED - PACS & AD out of scope'], [], []])).toEqual([]);
  });

  it('reports first and last data row consistently with the row list for every section it returns, so a caller looping the range and a caller iterating the list agree', () => {
    for (const grid of [consolidatedMasterView, [['a', 'b', 'c'], ['1', '2', '3']]]) {
      for (const section of readSectionStack(grid)) {
        expect(section.firstDataRow).toBe(section.dataRows[0]);
        expect(section.lastDataRow).toBe(section.dataRows[section.dataRows.length - 1]);
        expect(section.dataRows.length).toBeGreaterThan(0);
      }
    }
  });
});
