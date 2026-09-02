import { writeFileSync } from 'node:fs';
import { generateCalculatorPdfReport } from '../lambdas/shared/calculator-report';
import type { CalculationResult } from '../schema/calculator';

// SCRATCH — renders real PDFs to disk for a visual check. Delete after looking.

const OUT = process.env.SCRATCH_OUT || 'C:/Users/SYED~1.SOF/AppData/Local/Temp';

const base = (overrides: Partial<CalculationResult>): CalculationResult => ({
  url: 'https://calculator.aws/#/estimate?id=8f2c1d4e9b6a47f0a3c5e7d2b1904f6c',
  currency: 'USD',
  monthlyTotal: 1000,
  lineItems: [
    { service: 'Amazon EC2', detail: 'm6i.2xlarge x 4, Linux, On-Demand', monthly: 620.5, environment: 'Production', hoursPerDay: 24, timeBilled: true },
    { service: 'Amazon RDS for PostgreSQL', detail: 'db.r6g.xlarge Multi-AZ, 500 GB gp3', monthly: 480.2, environment: 'Production', hoursPerDay: 24, timeBilled: true },
    { service: 'Amazon S3', detail: '4 TB Standard + 1.2 TB Glacier IR', monthly: 118.4, environment: 'Production', timeBilled: false },
    { service: 'Amazon EC2', detail: 't3.large x 2, Linux', monthly: 84.1, environment: 'Dev', hoursPerDay: 8, timeBilled: true },
  ],
  environments: [
    { name: 'Production', hoursPerDay: 24, monthly: 1219.1 },
    { name: 'Dev', hoursPerDay: 8, monthly: 84.1 },
  ],
  assumptions: [
    'Prices are On-Demand list prices for ap-south-1 as at 25-08-2026, before any Enterprise Discount Program terms.',
    'Storage growth is not modelled; the figures reflect the volumes stated in the uploaded sheet.',
  ],
  warnings: ['Two rows named a service AWS does not publish pricing for and were skipped.'],
  ...overrides,
} as CalculationResult);

const options = {
  name: 'Digital Assets - five year capacity model',
  environmentHours: [
    { name: 'Production', hoursPerDay: 24 },
    { name: 'Dev', hoursPerDay: 8 },
  ],
  createdAt: Date.UTC(2026, 7, 25),
  region: 'ap-south-1',
};

const link = (id: string) => `https://calculator.aws/#/estimate?id=${id}`;

const years = ['26-27', '27-28', '28-29', '29-30', '30-31'].map((label, index) => ({
  key: label,
  label,
  kind: 'period' as const,
  monthly: 12450.75 + index * 3100.4,
  url: link(`${'a1b2c3d4e5f60718293a4b5c6d7e8f9'}${index}`),
  detail: `Fiscal ${label} usage column from the uploaded model`,
}));

const environments = ['Dev', 'Testing (QA)', 'UAT'].map((label, index) => ({
  key: label,
  label,
  kind: 'environment' as const,
  monthly: 2100.5 + index * 640.25,
  url: link(`${'f0e9d8c7b6a5948372615f4e3d2c1b0'}${index}`),
  detail: `Lower Environment band: ${label}`,
}));

const sizing = [
  { key: 'baseline', label: 'Lift and shift', kind: 'sizing' as const, monthly: 4820.6, url: link('11111111111111111111111111111111'), detail: 'As sized in the uploaded sheet' },
  { key: 'rightsized', label: 'Right-sized', kind: 'sizing' as const, monthly: 3644.25, url: link('22222222222222222222222222222222'), detail: 'Graviton where supported, one size down on idle tiers' },
];

test('scratch: render period, environment, combined and legacy PDFs', async () => {
  const cases: Array<[string, CalculationResult]> = [
    ['scratch-period.pdf', base({ scenarios: years, monthlyTotal: 12450.75 })],
    ['scratch-environment.pdf', base({ scenarios: environments, monthlyTotal: 2100.5 })],
    ['scratch-combined.pdf', base({ scenarios: [...years, ...environments], monthlyTotal: 12450.75 })],
    ['scratch-sizing.pdf', base({ scenarios: sizing, monthlyTotal: 4820.6 })],
    // Legacy: no kind, no url anywhere — the shape really stored in DynamoDB today.
    ['scratch-legacy.pdf', base({
      url: null,
      scenarios: [
        { key: 'baseline', label: 'Lift and shift', monthly: 4820.6 },
        { key: 'rightsized', label: 'Right-sized', monthly: 3644.25 },
      ] as CalculationResult['scenarios'],
    })],
  ];

  for (const [name, value] of cases) {
    const buffer = await generateCalculatorPdfReport(value, options);
    writeFileSync(`${OUT}/${name}`, buffer);
    // eslint-disable-next-line no-console
    console.log(`${name}: ${buffer.length} bytes`);
  }
}, 120000);
