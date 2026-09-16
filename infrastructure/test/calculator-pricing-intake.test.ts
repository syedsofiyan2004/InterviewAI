import ExcelJS from 'exceljs';
import {
  generatePricingIntakeWorkbook,
  pricingIntakeDownloadName,
} from '../lambdas/shared/calculator-pricing-intake';
import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';
import type { CalculationResource, WorkbookInsights } from '../schema/calculator';

const workbookInsights = (overrides: Partial<WorkbookInsights> = {}): WorkbookInsights => ({
  file_name: 'customer.xlsx',
  sheets: [],
  regions: [],
  facts: [],
  rate_card: [],
  reported: [],
  excerpts: [],
  server_count: 0,
  total_disk_gb: 0,
  dr_eligible_count: 0,
  ...overrides,
});

describe('prepared calculator pricing intake', () => {
  it('keeps the prepared download name short and stable across repeated uploads', () => {
    expect(pricingIntakeDownloadName('mimo-pricing-intake-mimo-pricing-intake-customer.xlsx'))
      .toBe('customer-aws-pricing-input.xlsx');
    expect(pricingIntakeDownloadName('b274d9ee-151d-43a4-86a4-7bc7c4d44108-customer-aws-pricing-input.xlsx'))
      .toBe('customer-aws-pricing-input.xlsx');
  });

  it('groups repeated missing technical fields instead of creating one web question per resource', async () => {
    const resources: CalculationResource[] = Array.from({ length: 250 }, (_, index) => ({
      sheet: 'VMs',
      row: index + 2,
      name: `vm-${index + 1}`,
      service: 'Amazon EC2',
      environment: 'Production',
      raw: `vm-${index + 1}`,
    }));

    const artifact = await generatePricingIntakeWorkbook({ resources, workbook: workbookInsights() });

    expect(artifact.summary.status).toBe('NEEDS_INPUT');
    expect(artifact.summary.normalizedResourceCount).toBe(250);
    expect(artifact.summary.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'Region', affectedCount: 250 }),
      expect.objectContaining({ column: 'Instance / Size', affectedCount: 250 }),
      expect.objectContaining({ column: 'Monthly Hours', affectedCount: 250 }),
      expect.objectContaining({ column: 'Operating System', affectedCount: 250 }),
    ]));
    expect(artifact.summary.missing.length).toBeLessThan(10);

    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(artifact.workbook as any);
    const intake = parsed.getWorksheet('Pricing Intake')!;
    expect(intake.rowCount).toBe(251);
    expect(intake.getCell('F2').fill).toMatchObject({ pattern: 'solid' });
    expect(parsed.getWorksheet('Inputs Needed')!.rowCount).toBeLessThan(12);
  });

  it('creates a separate pricing sheet for every detected year or scenario', async () => {
    const resources: CalculationResource[] = ['FY26-27', 'FY27-28'].map((scenario, index) => ({
      sheet: 'Digital Assets',
      row: 10 + index,
      name: 'API workload',
      scenario,
      service: 'Amazon ECS Fargate',
      environment: 'Production',
      region: 'ap-south-1',
      vcpu: 1,
      ram_gb: 2,
      hoursPerMonth: 730,
      quantity: String(index + 2),
      raw: `${scenario} API workload`,
    }));

    const artifact = await generatePricingIntakeWorkbook({
      resources,
      workbook: workbookInsights({
        bands: [
          { key: 'FY26-27', label: 'FY26-27', kind: 'period', sheet: 'Digital Assets' },
          { key: 'FY27-28', label: 'FY27-28', kind: 'period', sheet: 'Digital Assets' },
        ],
      }),
    });

    expect(artifact.summary.status).toBe('READY');
    expect(artifact.summary.scenarioSheets).toEqual(['Scenario FY26-27', 'Scenario FY27-28']);
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(artifact.workbook as any);
    expect(parsed.getWorksheet('Scenario FY26-27')!.getCell('H2').value).toBe('2');
    expect(parsed.getWorksheet('Scenario FY27-28')!.getCell('H2').value).toBe('3');
    const roundTrip = await analyseWorkbook(artifact.workbook, 'prepared-scenarios.xlsx');
    expect(roundTrip.resources.map((entry) => entry.scenario)).toEqual(expect.arrayContaining(['FY26-27', 'FY27-28']));
  });

  it('does not mistake a source-platform SKU for an AWS target instance', async () => {
    const artifact = await generatePricingIntakeWorkbook({
      resources: [{
        sheet: 'Azure inventory',
        row: 2,
        name: 'source-vm',
        service: 'Amazon EC2',
        source_size: 'Standard_D8s_v5',
        region: 'ap-south-1',
        os: 'Linux',
        hoursPerMonth: 730,
        raw: 'source-vm | Standard_D8s_v5',
      }],
      workbook: workbookInsights(),
    });

    expect(artifact.summary.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'Instance / Size' }),
    ]));
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(artifact.workbook as any);
    expect(parsed.getWorksheet('Pricing Intake')!.getCell('G2').value).toBe('');
    expect(parsed.getWorksheet('Source Lineage')!.getCell('E2').value).toContain('Standard_D8s_v5');
  });

  it('retains workbook instructions and parser conversions as agent evidence', async () => {
    const artifact = await generatePricingIntakeWorkbook({
      resources: [{
        sheet: 'Workloads', row: 2, name: 'web', service: 'Amazon EC2', size: 'm7g.large',
        region: 'ap-south-1', os: 'Linux', hoursPerMonth: 730, raw: 'web',
      }],
      workbook: workbookInsights({
        facts: [{ sheet: 'Instructions', label: 'Availability target', value: '99.9%' }],
        excerpts: [{ sheet: 'Notes', text: 'Exclude temporary test accounts.' }],
        conversions: ['Converted 2 TB to 2048 GB.'],
      }),
    });

    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(artifact.workbook as any);
    const values = parsed.getWorksheet('Source Context')!.getSheetValues().flat().join(' | ');
    expect(values).toContain('Availability target');
    expect(values).toContain('Exclude temporary test accounts.');
    expect(values).toContain('Converted 2 TB to 2048 GB.');
  });

  it('can be uploaded again without losing the normalized pricing rows', async () => {
    const artifact = await generatePricingIntakeWorkbook({
      resources: [{
        sheet: 'Original', row: 8, name: 'orders-api', service: 'Amazon EC2', size: 'm7g.large',
        region: 'ap-south-1', environment: 'Production', os: 'Linux', hoursPerMonth: 730,
        quantity: '3', disk_gb: 100, raw: 'orders-api source row',
      }],
      workbook: workbookInsights(),
    });

    const roundTrip = await analyseWorkbook(artifact.workbook, 'prepared-pricing-intake.xlsx');
    const resource = roundTrip.resources.find((entry) => entry.name === 'orders-api');
    expect(resource).toMatchObject({
      service: 'Amazon EC2',
      size: 'm7g.large',
      region: 'ap-south-1',
      environment: 'Production',
      os: 'Linux',
      hoursPerMonth: 730,
      quantity: '3',
      disk_gb: 100,
    });
  });

  it('accepts material values filled into highlighted generic columns on re-upload', async () => {
    const first = await generatePricingIntakeWorkbook({
      resources: [{
        sheet: 'DBs', row: 2, name: 'orders-db', service: 'Amazon RDS', size: 'db.r6g.large',
        // DR deliberately has no automatic availability posture: cold, warm and hot
        // recovery designs have materially different database configurations.
        region: 'ap-south-1', environment: 'DR', hoursPerMonth: 730,
        disk_gb: 500, raw: 'orders-db',
      }],
      workbook: workbookInsights(),
    });
    expect(first.summary.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'Availability' }),
    ]));

    const editable = new ExcelJS.Workbook();
    await editable.xlsx.load(first.workbook as any);
    editable.getWorksheet('Pricing Intake')!.getCell('Q2').value = 'Multi-AZ';
    const completed = Buffer.from(await editable.xlsx.writeBuffer());
    const reparsed = await analyseWorkbook(completed, 'completed-pricing-intake.xlsx');
    const second = await generatePricingIntakeWorkbook({ resources: reparsed.resources, workbook: reparsed.insights });

    expect(second.summary.status).toBe('READY');
    expect(second.summary.missing).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'Availability' }),
    ]));
  });

  it('applies the approved environment policy before the agent runs while preserving explicit values', async () => {
    const artifact = await generatePricingIntakeWorkbook({
      resources: [
        {
          sheet: 'Production', row: 2, name: 'orders-db', service: 'Amazon RDS', size: 'db.r6g.large',
          region: 'ap-south-1', raw: 'orders-db',
        },
        {
          sheet: 'Development', row: 2, name: 'dev-db', service: 'Amazon RDS', size: 'db.t4g.medium',
          region: 'ap-south-1', hoursPerMonth: 730, raw: 'dev-db',
        },
      ],
      workbook: workbookInsights(),
      environmentHours: [
        { name: 'Production', hoursPerDay: 24 },
        { name: 'Development', hoursPerDay: 8 },
      ],
    });

    expect(artifact.summary.status).toBe('READY');
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(artifact.workbook as any);
    const intake = parsed.getWorksheet('Pricing Intake')!;
    expect(intake.getCell('L2').value).toBeCloseTo(730);
    expect(intake.getCell('Q2').value).toBe('Multi-AZ');
    expect(intake.getCell('L3').value).toBeCloseTo(8 * 730 / 24);
    expect(intake.getCell('Q3').value).toBe('Single-AZ');
  });

  it('uses vInfo as the inventory authority for an RVTools workbook', async () => {
    const rvTools = new ExcelJS.Workbook();
    const vInfo = rvTools.addWorksheet('vInfo');
    vInfo.addRow(['VM', 'CPUs', 'Memory', 'Provisioned MB', 'OS according to the VMware Tools']);
    vInfo.addRow(['app-01', 4, 16384, 102400, 'Ubuntu Linux']);
    const vCpu = rvTools.addWorksheet('vCPU');
    vCpu.addRow(['VM', 'CPU']);
    vCpu.addRow(['app-01', 4]);
    const vMemory = rvTools.addWorksheet('vMemory');
    vMemory.addRow(['VM', 'Memory']);
    vMemory.addRow(['app-01', 16384]);

    const analysis = await analyseWorkbook(Buffer.from(await rvTools.xlsx.writeBuffer()), 'renamed-export.xlsx');
    expect(analysis.resources).toHaveLength(1);
    expect(analysis.resources[0].name).toBe('app-01');
    expect(analysis.insights.sheets.find((sheet) => sheet.name === 'vCPU')?.detail).toContain('auxiliary sheet');
  });
});
