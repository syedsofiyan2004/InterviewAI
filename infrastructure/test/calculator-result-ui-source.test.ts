import { readFileSync } from 'fs';
import path from 'path';

describe('calculator result UI state mapping', () => {
  const source = readFileSync(path.join(__dirname, '../../frontend/src/app/calculator/view/page.tsx'), 'utf8');

  test('AWS Calculator link is the primary action shown for any status with a URL (PARTIAL as secondary)', () => {
    // The link must appear for all statuses — not locked to COMPLETED/NEEDS_REVIEW only.
    // A PARTIAL estimate has a valid (but partial) Calculator URL and should show it.
    expect(source).toContain('Open AWS Pricing Calculator');
    expect(source).toContain('Open partial AWS estimate');
    // The link block is not inside a COMPLETED/NEEDS_REVIEW guard — it covers PARTIAL too.
    expect(source).not.toContain("['COMPLETED', 'NEEDS_REVIEW'].includes(data?.status || '') && (result.scenarios?.length || 0) <= 1");
  });

  test('Calculator link renders before download buttons — primary action first', () => {
    // The Calculator link must come before PDF/Excel/Word in the source so it is the
    // first interactive element the user sees. Source position is a proxy for DOM order.
    const calculatorLinkPos = source.indexOf('Open AWS Pricing Calculator');
    const downloadPdfPos = source.indexOf("'Download PDF'");
    expect(calculatorLinkPos).toBeGreaterThan(0);
    expect(downloadPdfPos).toBeGreaterThan(0);
    expect(calculatorLinkPos).toBeLessThan(downloadPdfPos);
  });

  test('partial estimates block PDF and Word but allow Excel (clearly marked as subset)', () => {
    // PDF and Word are blocked for PARTIAL — they are full client-ready deliverables.
    expect(source.match(/data\?\.status !== 'PARTIAL'/g)?.length || 0).toBeGreaterThanOrEqual(2);
    // Excel IS allowed for PARTIAL but carries an explicit subset label.
    expect(source).toContain('Download Excel (subset)');
    expect(source).toContain('PRICED SUBSET ONLY');
  });

  test('FAILED state explicitly states no Excel was generated', () => {
    expect(source).toContain('No final Excel has been generated');
    expect(source).toContain('validated AWS estimate does not yet exist');
  });

  test('NEEDS_REVIEW has its own compact verification state', () => {
    expect(source).toContain("data?.status === 'NEEDS_REVIEW'");
    expect(source).toContain('Estimate created -');
    expect(source).toContain('need verification');
  });

  test('PROCESSING card shows stage-specific label (BUILDING and VALIDATING)', () => {
    expect(source).toContain('Building AWS Pricing Calculator estimates');
    expect(source).toContain('Validating saved estimates');
    // CONFIRMED = plan locked, about to start; also shows the processing spinner.
    expect(source).toContain('Preparing to build estimates');
    // Spec section 64: narrating stage maps to "Generating Excel workbook".
    expect(source).toContain('Generating Excel workbook');
  });

  test('CONFIRMED status keeps the poll running — execution is imminent', () => {
    // CONFIRMED must NOT appear in the stop-poll list, otherwise the page would freeze
    // while the worker hasn't started yet.
    const stopList = source.match(/'CONFIRMED'.*includes.*next\.status|next\.status.*'CONFIRMED'/);
    // It SHOULD appear in the isProcessing list (shows spinner) but NOT in the stop-poll list.
    expect(source).toContain("'CONFIRMED'");
    // The stop-poll condition uses includes(next.status) — CONFIRMED must not be in it.
    const stopPollLine = source.match(/return \[.*\]\.includes\(next\.status\)/);
    expect(stopPollLine?.[0] ?? '').not.toContain("'CONFIRMED'");
    void stopList;
  });
});
