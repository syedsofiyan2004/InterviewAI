import type { WorkbookIR } from '../lambdas/shared/workbook';
import type { CanonicalWorkbook } from '../lambdas/shared/canonical-workbook';
import { buildWorkbookSemanticArtifacts } from '../lambdas/shared/workbook-semantic-model';

function workbookIr(): WorkbookIR {
  return {
    workbookId: 'workbook-1',
    fileHash: 'hash-1',
    fileName: 'template.xlsx',
    nonEmptyCellCount: 18,
    mergedRanges: [],
    namedRanges: [],
    sheets: [
      {
        name: '_MIMO_METADATA',
        index: 1,
        rowCount: 3,
        columnCount: 2,
        cells: [
          cell('_MIMO_METADATA', 1, 1, 'TemplateType'),
          cell('_MIMO_METADATA', 1, 2, 'MIMO Standard Costing Workbook'),
          cell('_MIMO_METADATA', 2, 1, 'TemplateVersion'),
          cell('_MIMO_METADATA', 2, 2, '2026.09'),
          cell('_MIMO_METADATA', 3, 1, 'ArchitectureSheet'),
          cell('_MIMO_METADATA', 3, 2, 'Architecture'),
        ],
      },
      {
        name: 'Template Guide',
        index: 2,
        rowCount: 1,
        columnCount: 2,
        cells: [
          cell('Template Guide', 1, 1, 'Runs_Value + Runs_Period defines task frequency'),
          cell('Template Guide', 1, 2, 'Blank means unknown, not zero'),
        ],
      },
      {
        name: 'Architecture',
        index: 3,
        rowCount: 1,
        columnCount: 3,
        cells: [
          cell('Architecture', 1, 1, 'Production'),
          cell('Architecture', 1, 2, 'Multi-AZ'),
          cell('Architecture', 1, 3, '2 reader replicas'),
        ],
      },
      {
        name: 'Assumptions',
        index: 4,
        rowCount: 1,
        columnCount: 2,
        cells: [
          cell('Assumptions', 1, 1, 'Production runtime'),
          cell('Assumptions', 1, 2, '24x7'),
        ],
      },
      {
        name: 'Scenarios',
        index: 5,
        rowCount: 1,
        columnCount: 1,
        cells: [cell('Scenarios', 1, 1, 'FY 2026')],
      },
    ],
  };
}

function canonicalWorkbook(): CanonicalWorkbook {
  return {
    rows: [
      {
        id: 'Digital Assets:10:0',
        billing: 'usage',
        service: 'AWS Lambda',
        label: 'Invoice processor',
        environment: 'Production',
        region: 'ap-south-1',
        quantities: [
          {
            unit: 'invocations/month',
            amount: 2_000_000,
            originalValue: 24_000_000,
            originalUnit: 'invocations',
            originalPeriod: 'year',
            derivedValue: 2_000_000,
            derivedUnit: 'invocations',
            derivedPeriod: 'month',
            conversionFormula: '24,000,000 / 12 = 2,000,000 invocations/month',
            basis: 'Lambda invocations',
            conversions: ['annual usage divided by 12 to a monthly basis'],
          },
        ],
        attributes: [{ label: 'Runtime', value: 'Node.js 20' }],
        provenance: [{ sheet: 'Workloads', row: 10, label: 'Annual Invocations', value: '24000000' }],
        unpriced: [],
      },
      {
        id: 'Digital Assets:11:0',
        billing: 'usage',
        service: 'AWS Fargate',
        label: 'DR warm standby task count',
        scenario: { key: 'fy-2026', label: 'FY 2026', kind: 'period' },
        environment: 'DR',
        quantities: [],
        attributes: [],
        provenance: [{ sheet: 'Digital Assets', row: 11, label: 'DR tasks', value: '' }],
        unpriced: [{
          provenance: { sheet: 'Digital Assets', row: 11, label: 'task vCPU size', value: '' },
          reason: 'Blank value remains unknown; no task vCPU size was stated.',
        }],
      },
    ],
    exclusions: [{
      label: 'Non-AWS appliance support',
      reason: 'Non-AWS item',
      attributes: [],
      provenance: [{ sheet: 'Non-AWS Items', row: 2, label: 'Support', value: 'Vendor contract' }],
    }],
    conversions: ['Invoice processor: annual usage divided by 12 to a monthly basis'],
    scenarios: [{ key: 'fy-2026', label: 'FY 2026', kind: 'period' }],
    accounting: {
      inputRows: 3,
      canonicalRows: 2,
      exclusions: 1,
      metricCells: 0,
      accountedMetricCells: 0,
      balanced: true,
    },
  };
}

function cell(sheet: string, row: number, col: number, formatted: string) {
  return {
    sheet,
    row,
    col,
    a1: `${String.fromCharCode(64 + col)}${row}`,
    raw: formatted,
    formatted,
    dataType: 'string',
  };
}

describe('WorkbookSemanticModel', () => {
  test('recognises a standard template from metadata without hardcoding the filename', () => {
    const { semanticModel } = buildWorkbookSemanticArtifacts({
      workbookIR: workbookIr(),
      canonicalModel: canonicalWorkbook(),
    });

    expect(semanticModel.template).toMatchObject({
      recognised: true,
      type: 'MIMO Standard Costing Workbook',
      version: '2026.09',
      metadataSheet: '_MIMO_METADATA',
    });
  });

  test('preserves Template Guide instructions, architecture rows and workbook policies', () => {
    const { semanticModel } = buildWorkbookSemanticArtifacts({
      workbookIR: workbookIr(),
      canonicalModel: canonicalWorkbook(),
    });

    expect(semanticModel.instructions.map((entry) => entry.text)).toContain(
      'Runs_Value + Runs_Period defines task frequency — Blank means unknown, not zero',
    );
    expect(semanticModel.architecture.map((entry) => entry.text)).toContain('Production — Multi-AZ — 2 reader replicas');
    expect(semanticModel.projectPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'template.architectureSheet', value: 'Architecture' }),
        expect.objectContaining({ field: 'Production runtime', value: '24x7' }),
      ]),
    );
  });

  test('keeps deterministic conversions with original and derived values', () => {
    const { semanticModel } = buildWorkbookSemanticArtifacts({
      workbookIR: workbookIr(),
      canonicalModel: canonicalWorkbook(),
    });

    expect(semanticModel.resources[0].quantities[0]).toMatchObject({
      value: 2_000_000,
      unit: 'invocations/month',
      original: { value: 24_000_000, unit: 'invocations', period: 'year' },
      derived: { value: 2_000_000, unit: 'invocations', period: 'month' },
      resolutionType: 'DERIVED',
    });
  });

  test('blank values remain unresolved rather than becoming zero', () => {
    const { semanticModel } = buildWorkbookSemanticArtifacts({
      workbookIR: workbookIr(),
      canonicalModel: canonicalWorkbook(),
    });

    expect(semanticModel.unresolved).toEqual([
      expect.objectContaining({
        field: 'task vCPU size',
        materiality: 'HIGH',
        message: 'Blank value remains unknown; no task vCPU size was stated.',
      }),
    ]);
    expect(semanticModel.resources[1].quantities).toEqual([]);
  });

  test('creates a scenario manifest and requirements without Calculator field IDs', () => {
    const { scenarioManifest, scenarioRequirements } = buildWorkbookSemanticArtifacts({
      workbookIR: workbookIr(),
      canonicalModel: canonicalWorkbook(),
      requestedPlan: {
        scenarios: [
          { label: 'On-Demand FY 2026', pricing_model: 'on-demand', scope: 'FY 2026', environments: [] },
          { label: '1Y Compute Savings FY 2026', pricing_model: 'compute-savings-1yr', scope: 'FY 2026', environments: [] },
        ],
      },
    });

    expect(scenarioManifest.expectedScenarioCount).toBe(3);
    expect(scenarioManifest.scenarios.map((scenario) => scenario.label)).toEqual([
      'FY 2026',
      'On-Demand FY 2026',
      '1Y Compute Savings FY 2026',
    ]);
    expect(scenarioRequirements[0]).toMatchObject({
      version: 'scenario-requirements.v1',
      scenarioId: 'scenario:fy-2026',
      label: 'FY 2026',
    });
    expect(JSON.stringify(scenarioRequirements)).not.toMatch(/fieldId|calculatorField|serviceCode/);
  });
});
