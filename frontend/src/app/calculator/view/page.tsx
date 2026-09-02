'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ExternalLink, FileDown, FileSpreadsheet, FileText, Info, Loader2, PiggyBank, RefreshCw, Trash2 } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContextChat } from '@/components/chat/ContextChat';
import {
  calculatorApi,
  formatCurrency,
  formatMonthly,
  schedulingSaving,
  type CalculationResultResponse,
  type CalculationScenario,
} from '@/lib/calculatorApi';

const POLL_INTERVAL_MS = 3000;
const MONTHS_PER_YEAR = 12;

const annual = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value * MONTHS_PER_YEAR : null;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** The kinds of band, in the order their cards appear. Mirrors calculator-report.ts. */
const SCENARIO_KINDS = ['sizing', 'period', 'environment'] as const;
type ScenarioKind = (typeof SCENARIO_KINDS)[number];

/**
 * Defaults to `sizing` rather than to an "unknown" bucket: every scenario stored before
 * `kind` existed was half of a baseline/right-sized pair, because that was the only thing
 * the pipeline could emit. An older estimate therefore keeps rendering as the sizing
 * comparison it actually is, saving line included.
 */
const kindOf = (scenario: CalculationScenario): ScenarioKind => scenario.kind || 'sizing';

/**
 * The copy each kind needs, and the reason it cannot be shared.
 *
 * Five monthly figures for five consecutive years and three monthly figures for three
 * concurrent environments look identical in a table, and only one of the two may be added
 * up. The blurb is the only thing standing between a reader and a wrong headline number.
 */
const KIND_COPY: Record<ScenarioKind, { title: string; labelColumn: string; blurb: (count: number) => string }> = {
  sizing: {
    title: 'Sizing scenarios',
    labelColumn: 'Scenario',
    blurb: (count) =>
      `${count === 2 ? 'Both priced' : 'Each priced'} from the same live AWS rates, so only one of them will ever be spent — these are alternatives, not costs that add together.`,
  },
  period: {
    title: 'Cost by year',
    labelColumn: 'Year',
    blurb: (count) =>
      `${count} consecutive years, each priced from the same live AWS rates. Every figure is the monthly cost of that year's configuration, and the years run one after another — adding the monthly figures together does not give a monthly bill.`,
  },
  environment: {
    // Not "Cost by environment": the page already has a card under that exact heading,
    // rolling one priced landscape up by environment. These are separate estimates with
    // their own links, and two identical headings would read as a fault.
    title: 'Cost by environment, priced separately',
    labelColumn: 'Environment',
    blurb: (count) =>
      `These ${count} environments run at the same time rather than one after another, so their monthly costs genuinely do add up. Each is priced from the same live AWS rates.`,
  },
};

/**
 * What each downloadable form of the estimate actually holds.
 *
 * Three controls side by side with nothing to tell them apart is three files downloaded to find
 * out which one was wanted, and they are not three renderings of one document: the PDF is the
 * cost argument, the workbook is a model to be argued with, and the Word file exists to carry a
 * clickable estimate link per scenario. Keyed rather than repeated per control, so a button's
 * tooltip and the line under the row cannot drift apart.
 *
 * Each claim is what the matching renderer emits — calculator-report.ts, tco-workbook.ts and
 * calculator-docx.ts respectively.
 */
const DOWNLOAD_CONTENTS = {
  PDF: 'the document you send a client — monthly and annual totals, a section per scenario, cost '
    + 'by environment, and every line item beside the arithmetic that produced it, then the '
    + 'assumptions and exclusions those figures rest on.',
  Excel: 'a TCO model rather than the PDF again — per-server costs, a consolidated summary, priced '
    + 'scenarios, a commercial breakdown carrying credits and discount, assumptions and line items, '
    + 'a sheet each. Its totals are live formulas, so changing one figure moves every total above it.',
  Word: 'one clickable AWS Pricing Calculator link per scenario, with the monthly (MRR) and annual '
    + '(ARR) figures and the pricing model each was bought on. A fiscal-year plan priced at several '
    + 'pricing models runs to eighteen links, which a PDF can only print as text nobody can click.',
} as const;

function CalculationDetailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get('id');

  const [data, setData] = useState<CalculationResultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Its own flag, not a shared one: two buttons behind a single boolean means asking for
  // the PDF greys out the workbook and spins both spinners.
  const [downloadingWorkbook, setDownloadingWorkbook] = useState(false);
  const [downloadingDocument, setDownloadingDocument] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // See the list page: window.confirm puts the CloudFront hostname above the message,
  // which reads as a browser warning instead of the app asking.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = async () => {
    if (!id) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await calculatorApi.deleteCalculation(id);
      // Back to the list: this page's record no longer exists, and staying would
      // show a 404 on the next poll.
      router.push('/calculator');
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not delete this estimate.'));
      setDeleting(false);
    }
  };

  const downloadPdf = async () => {
    if (!id) return;
    setDownloading(true);
    try {
      const { download_url } = await calculatorApi.getCalculationReportUrl(id);
      // Presigned URL with a download disposition — navigating to it saves the file
      // without leaving the page.
      window.location.href = download_url;
    } catch (err: unknown) {
      setError(errorMessage(err, 'The PDF could not be generated.'));
    } finally {
      setDownloading(false);
    }
  };

  const downloadWorkbook = async () => {
    if (!id) return;
    setDownloadingWorkbook(true);
    try {
      const { download_url } = await calculatorApi.getCalculationWorkbookUrl(id);
      window.location.href = download_url;
    } catch (err: unknown) {
      setError(errorMessage(err, 'The Excel workbook could not be generated.'));
    } finally {
      setDownloadingWorkbook(false);
    }
  };

  const downloadDocument = async () => {
    if (!id) return;
    setDownloadingDocument(true);
    try {
      const { download_url } = await calculatorApi.getCalculationDocumentUrl(id);
      window.location.href = download_url;
    } catch (err: unknown) {
      setError(errorMessage(err, 'The Word document could not be generated.'));
    } finally {
      setDownloadingDocument(false);
    }
  };

  /** Returns true once the job reaches a terminal state, which stops the poll. */
  const fetchResult = useCallback(async (): Promise<boolean> => {
    if (!id) return true;
    try {
      const next = await calculatorApi.getCalculationResult(id);
      setData(next);
      setError(null);
      return ['COMPLETED', 'PARTIAL', 'FAILED', 'REVIEW_REQUIRED'].includes(next.status);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not load this estimate'));
      // Stop polling on a hard error rather than hammering a failing endpoint.
      return true;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function poll() {
      const done = await fetchResult();
      if (!done && !cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, fetchResult]);

  if (!id) {
    return (
      <div className="card border-danger/30 bg-danger/5 p-6 text-sm font-semibold text-danger">
        No estimate id was provided.
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center gap-3 text-sm text-text-secondary">
        <Loader2 size={18} className="animate-spin text-accent" />
        Loading estimate...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="card border-danger/30 bg-danger/5 p-6 text-sm font-semibold text-danger">
        {error}
      </div>
    );
  }

  const result = data?.result ?? null;
  const isProcessing = data?.status === 'PROCESSING';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/calculator"
          className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={16} />
          Back to estimates
        </Link>
        <div className="flex items-center gap-2">
          {data && <StatusBadge status={data.status} />}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-muted transition-colors hover:border-danger/40 hover:bg-danger/5 hover:text-danger disabled:opacity-50"
          >
            {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Delete
          </button>
        </div>
      </div>

      {isProcessing && (
        <div className="card flex items-start gap-3 border-accent/30 bg-accent/5 p-5">
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">Building your estimate</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {data?.progress_message ||
                'Looking up AWS services and pricing fields. This usually takes a minute or two.'}
            </p>
          </div>
        </div>
      )}

      {data?.status === 'FAILED' && (
        <div className="card border-danger/30 bg-danger/5 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-danger">This estimate could not be built</p>
              <p className="mt-1 break-words text-sm leading-6 text-text-secondary">
                {data.error_message || result?.validationErrors?.[0] || 'The estimate failed validation.'}
              </p>
              {!data.error_message && !!result?.validationErrors?.length && (
                <ul className="mt-3 space-y-1.5">
                  {result.validationErrors.slice(0, 8).map((message, index) => (
                    <li key={index} className="text-sm leading-6 text-text-secondary">{message}</li>
                  ))}
                </ul>
              )}
              <Link
                href="/calculator/new"
                className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                <RefreshCw size={14} />
                Try again with more detail
              </Link>
            </div>
          </div>
        </div>
      )}

      {data?.status === 'REVIEW_REQUIRED' && (
        <div className="card border-warning/30 bg-warning/5 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-semibold text-text-primary">Requirements need review</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">No AWS estimate has been generated yet.</p>
              <Link href={`/calculator/new?review=${encodeURIComponent(id)}`} className="mt-3 inline-flex text-sm font-semibold text-accent hover:underline">
                Continue review
              </Link>
            </div>
          </div>
        </div>
      )}

      {data?.status === 'PARTIAL' && (
        <div className="card border-warning/30 bg-warning/5 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">Saved estimate did not pass validation</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                The output remains available for diagnosis, but it is not a validated successful estimate and should not be shared as final.
              </p>
              {!!result?.validationErrors?.length && (
                <ul className="mt-3 space-y-1.5">
                  {result.validationErrors.map((message, index) => (
                    <li key={index} className="text-sm leading-6 text-text-secondary">{message}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {result && data?.status !== 'FAILED' && (
        <>
          <div className="card p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Estimated monthly cost
                </p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-text-primary">
                  {formatMonthly(result.monthlyTotal, result.currency)}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {formatCurrency(annual(result.monthlyTotal), result.currency)} per year (monthly &times; 12)
                </p>
                {/* What the uploaded sheet said, beside what live pricing says. The gap
                    is usually the conversation: a rate that has moved since the model
                    was built, a purchase term nobody committed to, a resource omitted. */}
                {typeof result.reportedMonthlyTotal === 'number' && (
                  <p className="mt-2 text-xs text-text-muted">
                    Your uploaded model states{' '}
                    <strong className="font-semibold text-text-secondary">
                      {formatMonthly(result.reportedMonthlyTotal, result.currency)}
                    </strong>
                    {typeof result.monthlyTotal === 'number' && result.reportedMonthlyTotal > 0 && (
                      <>
                        {' '}&mdash;{' '}
                        {Math.abs(result.monthlyTotal - result.reportedMonthlyTotal) < 0.005
                          ? 'the same as this estimate'
                          : `${formatCurrency(Math.abs(result.monthlyTotal - result.reportedMonthlyTotal), result.currency)} (${Math.abs(
                              ((result.monthlyTotal - result.reportedMonthlyTotal) / result.reportedMonthlyTotal) * 100,
                            ).toFixed(0)}%) ${result.monthlyTotal > result.reportedMonthlyTotal ? 'below' : 'above'} this estimate`}
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadPdf()}
                  disabled={downloading}
                  title={DOWNLOAD_CONTENTS.PDF}
                  className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {downloading ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />}
                  {downloading ? 'Preparing...' : 'Download PDF'}
                </button>
                {/* The workbook, not a second rendering of the PDF: its totals are live
                    formulas, so a cost review can change a figure or type in a credit
                    percentage and watch everything downstream move. */}
                <button
                  type="button"
                  onClick={() => void downloadWorkbook()}
                  disabled={downloadingWorkbook}
                  title={DOWNLOAD_CONTENTS.Excel}
                  className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {downloadingWorkbook
                    ? <Loader2 size={15} className="animate-spin" />
                    : <FileSpreadsheet size={15} />}
                  {downloadingWorkbook ? 'Preparing...' : 'Download Excel'}
                </button>
                {/* Word, because a matrix estimate is a grid of shareable links: OOXML carries
                    real hyperlinks, so each row reads as one click instead of a 90-character
                    URL printed as ink. */}
                <button
                  type="button"
                  onClick={() => void downloadDocument()}
                  disabled={downloadingDocument}
                  title={DOWNLOAD_CONTENTS.Word}
                  className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {downloadingDocument
                    ? <Loader2 size={15} className="animate-spin" />
                    : <FileText size={15} />}
                  {downloadingDocument ? 'Preparing...' : 'Download Word'}
                </button>
                {result.url && data?.status === 'COMPLETED' && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
                  >
                    Open in AWS Calculator
                    <ExternalLink size={15} />
                  </a>
                )}
                {result.url && data?.status === 'PARTIAL' && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="This link contains only the resources that passed deterministic read-back validation. Review the exclusions before using it."
                    className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
                  >
                    Open partial AWS estimate
                    <ExternalLink size={15} />
                  </a>
                )}
              </div>
            </div>
            {/* The three formats carry genuinely different content, and a button label cannot
                say which — so the answer used to be to download all three and look. Stated
                here as well as in each button's tooltip, because a tooltip is invisible on a
                touch screen and to anyone who does not think to hover. */}
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">In each download</p>
              <ul className="mt-2 space-y-1.5">
                {Object.entries(DOWNLOAD_CONTENTS).map(([format, contains]) => (
                  <li key={format} className="flex gap-2 text-xs leading-5 text-text-muted">
                    <span className="text-accent">•</span>
                    <span>
                      <strong className="font-semibold text-text-secondary">{format}</strong>
                      {' '}&mdash; {contains}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-4 border-t border-border pt-4 text-xs leading-5 text-text-muted">
              AWS recalculates the live price when the link is opened. Press{' '}
              <strong className="font-semibold text-text-secondary">Update estimate</strong> there to
              refresh against current pricing.
            </p>
          </div>

          {/* One card per band of scenarios, each row carrying its own shareable estimate.
              Grouped by kind rather than listed flat because the three kinds are not
              interchangeable: only one sizing will ever be spent, consecutive years are
              spent in sequence, and concurrent environments genuinely do add up. Rendering
              them alike would put a confident wrong headline figure in front of a client. */}
          {(() => {
            const scenarios = result.scenarios ?? [];
            // One band is not a comparison, and alone it says nothing the header above has
            // not already said.
            if (scenarios.length < 2) return null;

            return SCENARIO_KINDS
              .map((kind) => ({ kind, rows: scenarios.filter((entry) => kindOf(entry) === kind) }))
              .filter((group) => group.rows.length > 0)
              .map(({ kind, rows }) => {
                const copy = KIND_COPY[kind];
                const priced = rows
                  .map((entry) => entry.monthly)
                  .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
                const monthlyTotal = priced.length ? priced.reduce((total, value) => total + value, 0) : null;
                const missing = rows.length - priced.length;
                // A total over a partly-priced band is still the only figure available, but
                // saying so unqualified would understate it by however many bands AWS
                // returned no rate for.
                const caveat = missing
                  ? ` ${missing} of the ${rows.length} could not be priced and ${missing === 1 ? 'is' : 'are'} not in this total.`
                  : '';

                return (
                  <div key={kind} className="card overflow-hidden">
                    <div className="border-b border-border px-6 py-4">
                      <h2 className="text-lg font-semibold text-text-primary">{copy.title}</h2>
                      <p className="mt-1 text-xs leading-5 text-text-muted">{copy.blurb(rows.length)}</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left">
                            <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">{copy.labelColumn}</th>
                            <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Monthly</th>
                            <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Annual</th>
                            <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Estimate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((scenario, index) => (
                            <tr key={`${scenario.key}-${index}`} className="border-b border-border last:border-0">
                              <td className="px-6 py-3">
                                <span className="font-semibold text-text-primary">{scenario.label}</span>
                                {scenario.detail && (
                                  <span className="mt-1 block text-xs leading-5 text-text-muted">{scenario.detail}</span>
                                )}
                              </td>
                              <td className="px-6 py-3 text-right align-top tabular-nums text-text-primary">
                                {formatCurrency(scenario.monthly, result.currency)}
                              </td>
                              <td className="px-6 py-3 text-right align-top tabular-nums text-text-secondary">
                                {formatCurrency(annual(scenario.monthly), result.currency)}
                              </td>
                              {/* A link per row, not one link for the table. "No link" where
                                  the run priced the band and the estimate export failed —
                                  a real outcome, and a dead button would be a worse answer
                                  than saying so. */}
                              <td className="px-6 py-3 text-right align-top">
                                {scenario.url && scenario.status === 'COMPLETED' ? (
                                  <a
                                    href={scenario.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-accent hover:underline"
                                  >
                                    Open estimate
                                    <ExternalLink size={13} />
                                  </a>
                                ) : scenario.url && scenario.status === 'PARTIAL' ? (
                                  <a
                                    href={scenario.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="This estimate contains only resources that passed deterministic read-back validation."
                                    className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold text-warning hover:underline"
                                  >
                                    Open partial estimate
                                    <ExternalLink size={13} />
                                  </a>
                                ) : (
                                  <span className="whitespace-nowrap text-xs text-text-muted">No link</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Consecutive years get a multi-year total and are never added into a
                        monthly one; concurrent environments get both. A sizing pair gets
                        neither, because whichever way you add two costings of one workload
                        the answer is a figure nobody will be billed. */}
                    {kind === 'period' && monthlyTotal !== null && (
                      <p className="border-t border-border px-6 py-4 text-xs leading-5 text-text-muted">
                        Across all {rows.length} years:{' '}
                        <strong className="font-semibold text-text-secondary">
                          {formatCurrency(annual(monthlyTotal), result.currency)}
                        </strong>{' '}
                        in total &mdash; the sum of each year&rsquo;s annual cost (monthly &times; 12). That is a
                        multi-year total, not a monthly figure.{caveat}
                      </p>
                    )}
                    {kind === 'environment' && monthlyTotal !== null && (
                      <p className="border-t border-border px-6 py-4 text-xs leading-5 text-text-muted">
                        All {rows.length} environments running together:{' '}
                        <strong className="font-semibold text-text-secondary">
                          {formatMonthly(monthlyTotal, result.currency)}
                        </strong>
                        , {formatCurrency(annual(monthlyTotal), result.currency)} per year.{caveat}
                      </p>
                    )}
                    {kind === 'sizing' && (() => {
                      // Only stated when both scenarios priced and right-sizing is the
                      // cheaper of the two; a "saving" that is actually an increase would be
                      // a lie, and an unpriced scenario has no difference to report. Keyed on
                      // baseline/rightsized because that pair is the only comparison in which
                      // a difference IS a saving — the gap between two years or two
                      // concurrent environments is not one.
                      const baseline = rows.find((entry) => entry.key === 'baseline')?.monthly;
                      const rightsized = rows.find((entry) => entry.key === 'rightsized')?.monthly;
                      if (typeof baseline !== 'number' || typeof rightsized !== 'number') return null;
                      if (rightsized >= baseline || baseline <= 0) return null;
                      return (
                        <p className="border-t border-border px-6 py-4 text-xs leading-5 text-text-muted">
                          Right-sizing saves{' '}
                          <strong className="font-semibold text-text-secondary">
                            {formatMonthly(baseline - rightsized, result.currency)}
                          </strong>{' '}
                          &mdash; {formatCurrency(annual(baseline - rightsized), result.currency)} a year, or{' '}
                          {(((baseline - rightsized) / baseline) * 100).toFixed(0)}% of the baseline.
                        </p>
                      );
                    })()}
                  </div>
                );
              });
          })()}

          {/* Where the money goes, by environment. Sourced from the calculator's own
              grouping so this and the shareable link cannot disagree. */}
          {result.environments.length > 0 && (
            <div className="card overflow-hidden">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-text-primary">Cost by environment</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Environment</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Hours/day</th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Monthly</th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Annual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.environments.map((entry) => (
                      <tr key={entry.name} className="border-b border-border last:border-0">
                        <td className="px-6 py-3 font-semibold text-text-primary">{entry.name}</td>
                        <td className="px-6 py-3 text-text-secondary">{entry.hoursPerDay}h</td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-primary">
                          {formatCurrency(entry.monthly, result.currency)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-secondary">
                          {formatCurrency(annual(entry.monthly), result.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Only shown when something is actually scheduled below 24h. */}
          {(() => {
            const saved = schedulingSaving(result);
            if (saved === null || saved <= 0) return null;
            return (
              <div className="card border-success/30 bg-success/5 p-6">
                <div className="flex items-start gap-3">
                  <PiggyBank size={18} className="mt-0.5 shrink-0 text-success" />
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-text-primary">Saving from scheduled shutdown</h2>
                    <p className="mt-1 text-sm leading-6 text-text-secondary">
                      Running non-production on a schedule instead of 24/7 avoids about{' '}
                      <strong className="font-semibold text-success">{formatCurrency(saved, result.currency)}</strong> per
                      month, or {formatCurrency(annual(saved), result.currency)} per year.
                    </p>
                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      Derived from the priced monthly cost and the configured hours, for time-billed
                      resources only — not a separate AWS quote. Usage-based services such as S3
                      storage cost the same whether the environment is running or not.
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

          {result.lineItems.length > 0 && (
            <div className="card overflow-hidden">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-text-primary">Breakdown</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Service
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Configuration
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Env
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Hours
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Monthly
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Annual
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.lineItems.map((item, index) => (
                      <tr key={`${item.service}-${index}`} className="border-b border-border last:border-0">
                        <td className="px-6 py-3 font-semibold text-text-primary">{item.service}</td>
                        <td className="px-6 py-3 text-text-secondary">{item.detail || '—'}</td>
                        <td className="px-6 py-3 text-text-secondary">{item.environment || '—'}</td>
                        <td className="px-6 py-3 text-text-muted">
                          {item.timeBilled && item.hoursPerDay ? `${item.hoursPerDay}h` : 'usage'}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-primary">
                          {formatCurrency(item.monthly, result.currency)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-secondary">
                          {formatCurrency(annual(item.monthly), result.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.assumptions.length > 0 && (
            <div className="card p-6">
              <div className="flex items-center gap-2">
                <Info size={16} className="text-accent" />
                <h2 className="text-lg font-semibold text-text-primary">Assumptions</h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Defaults chosen on your behalf. Check these before sharing the estimate.
              </p>
              <ul className="mt-4 space-y-2">
                {result.assumptions.map((assumption, index) => (
                  <li key={index} className="flex gap-2 text-sm leading-6 text-text-secondary">
                    <span className="text-accent">•</span>
                    <span>{assumption}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="card border-warning/30 bg-warning/5 p-6">
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-warning" />
                <h2 className="text-lg font-semibold text-text-primary">Warnings</h2>
              </div>
              <ul className="mt-4 space-y-2">
                {result.warnings.map((warning, index) => (
                  <li key={index} className="flex gap-2 text-sm leading-6 text-text-secondary">
                    <span className="text-warning">•</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete estimate?"
        description="This will permanently delete this estimate, its uploaded sheet and its PDF."
        confirmLabel="Delete"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />

      {/*
        Mounted as soon as the record loads, whether or not it has finished pricing. A run still
        in flight is something the assistant can genuinely answer about — its context block
        carries the pipeline's position and it has a tool for reading the current one — and the
        drawer is where the remaining time is shown, which is no use if the drawer only appears
        once the waiting is over. Applying a change produces a NEW revision, so route to it
        rather than leaving the user on the estimate they just superseded.
      */}
      {id && data && (
        <ContextChat
          app="calculator"
          entityId={id}
          onApplied={(change) => {
            if (change.kind === 'estimate_change') {
              router.push(`/calculator/view?id=${encodeURIComponent(change.calculationId)}`);
            }
          }}
        />
      )}
    </div>
  );
}

export default function CalculationDetailPage() {
  // useSearchParams requires a Suspense boundary above it.
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <Loader2 size={18} className="animate-spin text-accent" />
          Loading estimate...
        </div>
      }
    >
      <CalculationDetailContent />
    </Suspense>
  );
}
