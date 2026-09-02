import { readFileSync } from 'fs';
import path from 'path';

describe('calculator result UI state mapping', () => {
  const source = readFileSync(path.join(__dirname, '../../frontend/src/app/calculator/view/page.tsx'), 'utf8');

  test('top AWS Calculator link is limited to single completed or review-needed estimates', () => {
    expect(source).toContain("['COMPLETED', 'NEEDS_REVIEW'].includes(data?.status || '') && (result.scenarios?.length || 0) <= 1");
  });

  test('partial estimates do not show normal client-ready deliverables', () => {
    expect(source.match(/data\?\.status !== 'PARTIAL'/g)?.length || 0).toBeGreaterThanOrEqual(4);
    expect(source).toContain('Open partial AWS estimate');
  });

  test('NEEDS_REVIEW has its own compact verification state', () => {
    expect(source).toContain("data?.status === 'NEEDS_REVIEW'");
    expect(source).toContain('Estimate created -');
    expect(source).toContain('need verification');
  });
});
