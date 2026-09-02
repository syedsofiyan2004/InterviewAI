'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  Calculator,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FolderKanban,
  ListChecks,
  Loader2,
  PencilLine,
  X,
} from 'lucide-react';
import {
  calculatorApi,
  DEFAULT_ENVIRONMENT_HOURS,
  TEMPLATE_COLUMNS,
  TEMPLATE_ROWS,
  type CalculationProject,
  type CalculatorReviewCatalog,
  type EstimatePlanV2,
  type EnvironmentHours,
  type PlanProposal,
} from '@/lib/calculatorApi';
import {
  REVIEW_CONTROL_SPECS,
  answerIsComplete,
  defaultAnswerFor,
  formatReviewAnswer,
  validateFiniteOptions,
  type ReviewControlField,
  type ReviewValue,
} from '@/lib/calculatorReviewControls';

/**
 * Common AWS regions. The field stays a free-text-backed select rather than an
 * exhaustive enum because the MCP server validates the region against the live AWS
 * manifest anyway, and the model records the choice in the estimate's assumptions
 * when none is given.
 *
 * Frankfurt and the other European regions are here because an uploaded migration
 * model names its own target region — the example workbook targets eu-central-1 with
 * DR in eu-west-1 — and a list that cannot express the region on the sheet forces the
 * user to leave the field blank and hope the parser found it.
 */
const REGIONS = [
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai) - ap-south-1' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore) - ap-southeast-1' },
  { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney) - ap-southeast-2' },
  { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo) - ap-northeast-1' },
  { value: 'me-central-1', label: 'Middle East (UAE) - me-central-1' },
  { value: 'eu-central-1', label: 'Europe (Frankfurt) - eu-central-1' },
  { value: 'eu-west-1', label: 'Europe (Ireland) - eu-west-1' },
  { value: 'eu-west-2', label: 'Europe (London) - eu-west-2' },
  { value: 'eu-west-3', label: 'Europe (Paris) - eu-west-3' },
  { value: 'eu-north-1', label: 'Europe (Stockholm) - eu-north-1' },
  { value: 'us-east-1', label: 'US East (N. Virginia) - us-east-1' },
  { value: 'us-east-2', label: 'US East (Ohio) - us-east-2' },
  { value: 'us-west-2', label: 'US West (Oregon) - us-west-2' },
  { value: 'ca-central-1', label: 'Canada (Central) - ca-central-1' },
  { value: 'sa-east-1', label: 'South America (São Paulo) - sa-east-1' },
];

const EXAMPLE = `A production WordPress environment:
- Application Load Balancer
- 2x t3.large EC2 instances running Linux, on-demand
- RDS PostgreSQL db.t3.medium, Multi-AZ, 100 GB storage
- 200 GB of S3 Standard storage
- NAT Gateway with 500 GB monthly data processing`;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** CSV rather than xlsx: Excel opens it natively, the server accepts it back, and it needs no library either side. */
function downloadTemplate() {
  const escape = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  const csv = [TEMPLATE_COLUMNS, ...TEMPLATE_ROWS].map((row) => row.map(escape).join(',')).join('\r\n');
  // The BOM makes Excel open a UTF-8 CSV without mangling non-ASCII text.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aws-cost-estimate-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Build an estimate.
 *
 * `?project=<uuid>` is how a project page links here, and it preselects the folder the
 * estimate lands in. The picker is still shown rather than locked, because a user can
 * also arrive with no project in the URL, and a form that only worked from inside a
 * project would be a dead end for them.
 */
function NewCalculationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectParam = searchParams.get('project');
  const reviewParam = searchParams.get('review');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [region, setRegion] = useState('ap-south-1');
  const [environments, setEnvironments] = useState<EnvironmentHours[]>(DEFAULT_ENVIRONMENT_HOURS);
  const [sheet, setSheet] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<CalculationProject[]>([]);
  const [projectId, setProjectId] = useState(projectParam || '');
  const [calculationId, setCalculationId] = useState<string | null>(null);
  const [plan, setPlan] = useState<EstimatePlanV2 | null>(null);
  const [customRequirements, setCustomRequirements] = useState('');
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, ReviewValue>>({});
  const [reviewCatalog, setReviewCatalog] = useState<CalculatorReviewCatalog | null>(null);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [running, setRunning] = useState(false);

  // Real projects only. The server's synthetic "Ungrouped estimates" row is a view over
  // the estimates that belong to no project, not a folder anything can be written into.
  useEffect(() => {
    let cancelled = false;
    calculatorApi.getCalculationProjects()
      .then((data) => {
        if (!cancelled) setProjects(data.items.filter((entry) => !!entry.project_id));
      })
      // A failed project list must not block the form — the estimate can still be built
      // ungrouped, and the picker simply has nothing to offer.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!reviewParam || calculationId === reviewParam) return;
    let cancelled = false;
    calculatorApi.getCalculationPlan(reviewParam)
      .then((response) => {
        if (!cancelled) {
          setCalculationId(response.calculation_id);
          setPlan(response.plan);
        }
      })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err, 'The review plan could not be loaded.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [calculationId, reviewParam]);

  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    calculatorApi.getCalculatorReviewCatalog()
      .then((catalog) => { if (!cancelled) setReviewCatalog(catalog); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [plan?.planId]);

  const setHours = (index: number, raw: string) => {
    const parsed = Number(raw);
    setEnvironments((current) => current.map((entry, at) => (
      at === index
        ? { ...entry, hoursPerDay: Number.isFinite(parsed) ? Math.min(24, Math.max(1, Math.round(parsed))) : entry.hoursPerDay }
        : entry
    )));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const safeName = name.trim();
    const safePrompt = prompt.trim();

    if (!safeName) {
      setError('Please give this estimate a name.');
      return;
    }
    // Either input is enough on its own, but not neither.
    if (!sheet && safePrompt.length < 10) {
      setError('Describe the workload, or upload a resource list.');
      return;
    }

    setLoading(true);
    try {
      let inputKey: string | undefined;
      if (sheet) {
        setUploading(true);
        try {
          const uploaded = await calculatorApi.uploadResourceSheet(sheet);
          inputKey = uploaded.s3_key;
        } finally {
          setUploading(false);
        }
      }

      const created = await calculatorApi.analyzeCalculation({
        name: safeName,
        project_id: projectId || undefined,
        prompt: safePrompt || undefined,
        region: region || undefined,
        environment_hours: environments,
        input_s3_key: inputKey,
      });
      setCalculationId(created.calculation_id);
      setPlan(created.plan);
      const query = new URLSearchParams({ review: created.calculation_id });
      if (projectId) query.set('project', projectId);
      router.replace(`/calculator/new?${query.toString()}`);
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to start the estimate'));
      setLoading(false);
    }
  };

  const currentRevision = plan?.revisions.find((entry) => entry.revisionId === plan.currentRevisionId);
  const openQuestions = plan?.unresolved.filter((entry) => !entry.resolved) || [];
  const answerForQuestion = (question: EstimatePlanV2['unresolved'][number]) => (
    questionAnswers[question.id] ?? defaultAnswerFor(question.field, question.options)
  );

  const setQuestionAnswer = (
    question: EstimatePlanV2['unresolved'][number],
    field: ReviewControlField,
    raw: string,
  ) => {
    const value = field.kind === 'number' ? Number(raw) : raw;
    const spec = REVIEW_CONTROL_SPECS[question.field];
    setQuestionAnswers((current) => {
      if (!spec || spec.controls.length === 1 && field.key === 'value') {
        return { ...current, [question.id]: value };
      }
      const previous = current[question.id] ?? defaultAnswerFor(question.field, question.options);
      const record = previous && typeof previous === 'object' && !Array.isArray(previous)
        ? previous as Record<string, string | number>
        : {};
      return { ...current, [question.id]: { ...record, [field.key]: value } };
    });
  };

  const liveOptionsFor = (
    question: EstimatePlanV2['unresolved'][number],
    control: ReviewControlField,
  ) => {
    const live = reviewCatalog?.fields?.[question.field] || [];
    if (!live.length || control.kind !== 'searchable-select') return control.options || [];
    if (question.field === 'resource.region'
      || question.field === 'lambda.execution_profile'
      || question.field === 'sagemaker.inference_configuration' && control.key === 'workloadType'
      || question.field === 'nat_gateway.configuration' && control.key === 'mode'
      || question.field === 'cognito.tier') return control.options || [];
    const filtered = live.filter((option) => {
      const text = `${option.id} ${option.label} ${option.calculatorField}`.toLowerCase();
      if (control.key === 'instanceType') return /\bml\./.test(text);
      if (control.key === 'workloadType') return /real.?time|inference/.test(text);
      if (control.key === 'provider') return /anthropic|amazon|meta|mistral|cohere/.test(text);
      if (control.key === 'model') return /claude|titan|llama|mistral|command/.test(text);
      if (control.key === 'mode') return /regional|nat/.test(text);
      if (control.key === 'tier') return /lite|essentials|plus/.test(text);
      if (control.key === 'value') return true;
      return false;
    });
    return (filtered.length ? filtered : live)
      .map((option) => ({ value: option.id, label: option.label }))
      .slice(0, 200);
  };

  const validateQuestionAnswer = (question: EstimatePlanV2['unresolved'][number], answer: ReviewValue) => {
    const spec = REVIEW_CONTROL_SPECS[question.field];
    if (!spec) return validateFiniteOptions(question.field, answer, question.options);
    const record = answer && typeof answer === 'object' && !Array.isArray(answer)
      ? answer as Record<string, string | number>
      : { value: answer as string | number };
    return spec.controls.flatMap((control) => {
      if (control.kind !== 'searchable-select') return [];
      const options = liveOptionsFor(question, control);
      if (!options.length) return [];
      const raw = record[control.key];
      if (raw === undefined || raw === null || raw === '') return [];
      return options.some((option) => option.value === String(raw) || option.label === String(raw))
        ? []
        : [`${control.label} must be selected from the AWS-supported options.`];
    });
  };

  const renderReviewControl = (question: EstimatePlanV2['unresolved'][number]) => {
    const spec = REVIEW_CONTROL_SPECS[question.field];
    const controls = spec?.controls || [{
      key: 'value',
      label: 'Value',
      kind: question.options?.length ? 'searchable-select' as const : 'text' as const,
      options: question.options?.map((option) => ({ value: option, label: option })),
      source: question.options?.length ? 'Recommended' as const : 'Detected from workbook' as const,
      recommended: defaultAnswerFor(question.field, question.options) as string,
      required: true,
    }];
    const answer = answerForQuestion(question);
    const record = answer && typeof answer === 'object' && !Array.isArray(answer)
      ? answer as Record<string, string | number>
      : { value: answer as string | number };
    const shouldUseNativeSelect = (questionField: string, control: ReviewControlField) => (
      Boolean(control.options?.length)
      && (questionField === 'resource.region'
        || questionField === 'lambda.execution_profile'
        || questionField === 'sagemaker.inference_configuration' && control.key === 'workloadType'
        || questionField === 'nat_gateway.configuration' && control.key === 'mode'
        || questionField === 'cognito.tier')
    );

    return (
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {controls.map((control) => {
          const id = `${question.id}-${control.key}`;
          const value = record[control.key] ?? control.recommended ?? '';
          const options = liveOptionsFor(question, control);
          return (
            <div key={control.key}>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={id} className="text-xs font-semibold text-text-secondary">
                  {control.label}
                </label>
                <span className="rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-[11px] font-semibold text-text-muted">
                  {control.source}
                </span>
              </div>
              {control.kind === 'searchable-select' ? (
                shouldUseNativeSelect(question.field, control) ? (
                  <select
                    id={id}
                    className="premium-input w-full px-4 text-sm"
                    value={String(value)}
                    onChange={(event) => setQuestionAnswer(question, control, event.target.value)}
                  >
                    {!control.required && <option value="">Not used</option>}
                    {control.required && !value && <option value="">Choose an option</option>}
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      id={id}
                      list={`${id}-options`}
                      className="premium-input w-full px-4 text-sm"
                      value={String(value)}
                      onChange={(event) => setQuestionAnswer(question, control, event.target.value)}
                    />
                    <datalist id={`${id}-options`}>
                      {!control.required && <option value="" />}
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </datalist>
                  </>
                )
              ) : (
                <input
                  id={id}
                  type={control.kind === 'number' ? 'number' : 'text'}
                  className="premium-input w-full px-4 text-sm"
                  value={String(value)}
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  onChange={(event) => setQuestionAnswer(question, control, event.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const applyRequiredAnswers = async () => {
    if (!calculationId) return;
    const missing = openQuestions.filter((question) => (
      question.impact === 'high' && !answerIsComplete(question.field, answerForQuestion(question), question.options)
    ));
    if (missing.length) {
      setError(`Answer the ${missing.length} remaining required field${missing.length === 1 ? '' : 's'}.`);
      return;
    }
    const optionErrors = openQuestions.flatMap((question) => validateQuestionAnswer(question, answerForQuestion(question)));
    if (optionErrors.length) {
      setError(optionErrors[0]);
      return;
    }
    const answered = openQuestions
      .map((question) => ({ question, answer: answerForQuestion(question) }))
      .filter(({ answer, question }) => answerIsComplete(question.field, answer, question.options))
      .map(({ question, answer }) => ({
        scope: question.scope,
        field: question.field,
        operator: 'eq' as const,
        expected: answer,
        impact: question.impact === 'high' ? 'critical' as const : 'material' as const,
      }));
    if (!answered.length) return;

    setError(null);
    setCustomizing(true);
    try {
      const proposed = await calculatorApi.proposeStructuredPlan(calculationId, answered);
      if (proposed.proposal.unresolved.length) {
        setProposal(proposed.proposal);
        return;
      }
      const response = await calculatorApi.applyPlanProposal(calculationId, proposed.proposal);
      setPlan(response.plan);
      setProposal(null);
      setQuestionAnswers({});
    } catch (err: unknown) {
      setError(errorMessage(err, 'The required answers could not be applied.'));
    } finally {
      setCustomizing(false);
    }
  };

  const createProposal = async () => {
    if (!calculationId || !customRequirements.trim()) return;
    setError(null);
    setCustomizing(true);
    try {
      const response = await calculatorApi.proposePlan(calculationId, customRequirements.trim());
      setProposal(response.proposal);
    } catch (err: unknown) {
      setError(errorMessage(err, 'The proposed requirements could not be interpreted.'));
    } finally {
      setCustomizing(false);
    }
  };

  const applyProposal = async () => {
    if (!calculationId || !proposal) return;
    setError(null);
    setCustomizing(true);
    try {
      const response = await calculatorApi.applyPlanProposal(calculationId, proposal);
      setPlan(response.plan);
      setProposal(null);
      setCustomRequirements('');
      setQuestionAnswers({});
    } catch (err: unknown) {
      setError(errorMessage(err, 'The proposed changes could not be applied.'));
    } finally {
      setCustomizing(false);
    }
  };

  const confirmAndRun = async () => {
    if (!calculationId || !plan) return;
    const unresolvedHigh = plan.unresolved.some((entry) => !entry.resolved && entry.impact === 'high');
    if (unresolvedHigh || plan.status === 'NEEDS_INPUT') {
      setError('Resolve every high-impact requirement before building the estimate.');
      return;
    }
    setError(null);
    setRunning(true);
    try {
      await calculatorApi.confirmPlan(calculationId, plan.currentRevisionId);
      await calculatorApi.runPlan(calculationId);
      router.push(`/calculator/view?id=${calculationId}`);
    } catch (err: unknown) {
      setError(errorMessage(err, 'The confirmed estimate could not be started.'));
      setRunning(false);
    }
  };

  return (
    <div className="space-y-8">
      <Link
        href={projectParam ? `/calculator/project?id=${encodeURIComponent(projectParam)}` : '/calculator'}
        className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
      >
        <ArrowLeft size={16} />
        {projectParam ? 'Back to project' : 'Back to projects'}
      </Link>

      <div className="space-y-2">
        <p className="page-kicker">AWS Cost Calculator</p>
        <h1 className="text-2xl font-semibold text-text-primary">New estimate</h1>
        <p className="text-sm leading-6 text-text-secondary">
          Describe the workload in plain English. You get back a shareable AWS Pricing Calculator
          estimate with a cost breakdown.
        </p>
      </div>

      {error && (
        <div
          className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </div>
      )}

      {plan && currentRevision ? (
        <div className="card overflow-hidden">
          <div className="border-b border-border px-6 py-5 sm:px-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="page-kicker">Review / Customize requirements</p>
                <h2 className="mt-1 text-xl font-semibold text-text-primary">Confirm what AWS will price</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">
                  The workbook has been preserved and converted into a canonical plan. Review the detected scope
                  and resolve material gaps before any AWS Pricing Calculator estimate is created.
                </p>
              </div>
              <div className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs font-semibold text-text-secondary">
                <ListChecks size={15} className="text-accent" />
                Revision {plan.revisions.length}
              </div>
            </div>
          </div>

          <div className="grid border-b border-border sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Resources', `${plan.detectedDimensions.resourceCount}`],
              ['Mapped', `${plan.detectedDimensions.mappedResourceCount}`],
              ['Coverage', `${plan.detectedDimensions.coveragePct}%`],
              ['Scenarios', `${currentRevision.scenarios.length}`],
            ].map(([label, value], index) => (
              <div key={label} className={`px-6 py-4 ${index ? 'border-t border-border sm:border-l sm:border-t-0' : ''}`}>
                <p className="text-xs font-semibold text-text-muted">{label}</p>
                <p className="mt-1 text-lg font-semibold text-text-primary">{value}</p>
              </div>
            ))}
          </div>

          <div className="space-y-7 px-6 py-6 sm:px-8">
            <section>
              <h3 className="text-sm font-semibold text-text-primary">Detected dimensions</h3>
              <div className="mt-3 grid gap-4 md:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold text-text-muted">AWS services</p>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {plan.detectedDimensions.serviceFamilies.join(', ') || 'No service family confirmed'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-text-muted">Regions</p>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {plan.detectedDimensions.regions.join(', ') || 'Region requires confirmation'}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold text-text-muted">Environments</p>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {plan.detectedDimensions.environments.join(', ') || 'All resources'}
                  </p>
                </div>
              </div>
            </section>

            <section className="border-t border-border pt-6">
              <h3 className="text-sm font-semibold text-text-primary">Estimate scenarios</h3>
              <div className="mt-3 divide-y divide-border border-y border-border">
                {currentRevision.scenarios.map((scenario) => (
                  <div key={`${scenario.label}-${scenario.pricing_model}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{scenario.label}</p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {scenario.scope || 'All resources'}
                        {scenario.environments.length ? ` · ${scenario.environments.join(', ')}` : ''}
                      </p>
                    </div>
                    <span className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-text-secondary">
                      {scenario.pricing_model}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {openQuestions.length > 0 && (
              <section className="border-t border-border pt-6">
                <div className="flex items-start gap-3">
                  <AlertCircle size={18} className="mt-0.5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-text-primary">Input required</h3>
                    <p className="mt-1 text-sm leading-6 text-text-secondary">
                      High-impact gaps block generation. Answers are stored as typed resource constraints in a new plan revision.
                    </p>
                    <div className="mt-4 space-y-4">
                      {openQuestions.map((question) => (
                        <div key={question.id}>
                          <p className="block text-xs font-semibold text-text-secondary">
                            {question.prompt}
                          </p>
                          {renderReviewControl(question)}
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void applyRequiredAnswers()}
                      disabled={customizing}
                      className="btn-primary mt-4 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                    >
                      {customizing ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                      Apply answers
                    </button>
                  </div>
                </div>
              </section>
            )}

            <section className="border-t border-border pt-6">
              <div className="flex items-start gap-3">
                <PencilLine size={18} className="mt-0.5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <label htmlFor="custom-requirements" className="block text-sm font-semibold text-text-primary">
                    Customize requirements
                  </label>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    Examples: use eu-west-1, run 300 hours per month, require Multi-AZ, or use a 3-year Reserved Instance with no upfront payment.
                  </p>
                  <textarea
                    id="custom-requirements"
                    rows={3}
                    className="premium-input mt-3 w-full px-4 py-3 text-sm leading-6"
                    value={customRequirements}
                    onChange={(event) => setCustomRequirements(event.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void createProposal()}
                    disabled={customizing || !customRequirements.trim()}
                    className="btn-secondary mt-3 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                  >
                    {customizing ? <Loader2 size={15} className="animate-spin" /> : <PencilLine size={15} />}
                    Preview structured changes
                  </button>
                </div>
              </div>
            </section>

            {proposal && (
              <section className="border-t border-border pt-6" aria-live="polite">
                <h3 className="text-sm font-semibold text-text-primary">Proposed revision</h3>
                <p className="mt-1 text-sm leading-6 text-text-secondary">{proposal.summary}</p>
                <div className="mt-3 divide-y divide-border border-y border-border">
                  {proposal.requirements.map((requirement) => (
                    <div key={requirement.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <span className="font-semibold text-text-primary">{requirement.field}</span>
                      <span className="break-words text-text-secondary sm:text-right">{formatReviewAnswer(requirement.expected)}</span>
                    </div>
                  ))}
                  {proposal.unresolved.map((question) => (
                    <div key={question.id} className="flex items-start gap-2 py-3 text-sm text-warning">
                      <AlertCircle size={15} className="mt-0.5 shrink-0" />
                      {question.prompt}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void applyProposal()} disabled={customizing || proposal.unresolved.length > 0} className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                    <CheckCircle2 size={15} /> Apply revision
                  </button>
                  <button type="button" onClick={() => setProposal(null)} className="btn-secondary px-4 py-2.5 text-sm font-semibold">
                    Discard
                  </button>
                </div>
              </section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
              <p className="max-w-2xl text-xs leading-5 text-text-muted">
                Completion requires a shareable AWS Pricing Calculator link whose saved configuration and totals pass deterministic read-back validation.
              </p>
              <button
                type="button"
                onClick={() => void confirmAndRun()}
                disabled={running || plan.status === 'NEEDS_INPUT' || openQuestions.some((entry) => entry.impact === 'high') || !!proposal}
                className="btn-primary inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold disabled:opacity-50"
              >
                {running ? <Loader2 size={17} className="animate-spin" /> : <Calculator size={17} />}
                {running ? 'Starting estimate...' : 'Confirm and build estimate'}
              </button>
            </div>
          </div>
        </div>
      ) : (
      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <div className="border-b border-border pb-5">
          <h2 className="text-lg font-semibold text-text-primary">Workload details</h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            Name it something your team will recognise when comparing estimates later.
          </p>
        </div>

        {/* Three short fields across the measure, with the long description below sitting
            beside the two configuration panels, so the full page width is used rather
            than stacking every field down a narrow column. */}
        <div className="grid gap-5 lg:grid-cols-3">
          <div>
            <label htmlFor="calc-project" className="block text-xs font-semibold text-text-muted mb-2">
              Project
            </label>
            <select
              id="calc-project"
              className="premium-input w-full px-4 text-sm"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              aria-describedby="calc-project-help"
            >
              <option value="">No project (ungrouped)</option>
              {/* Holds the preselection from the URL steady while the list is in flight.
                  Without it the select falls back to "ungrouped" for a moment, and a fast
                  submit would file the estimate outside the project it was opened from. */}
              {projectParam && !projects.some((entry) => entry.project_id === projectParam) && (
                <option value={projectParam}>Loading project...</option>
              )}
              {projects.map((entry) => (
                <option key={entry.project_id as string} value={entry.project_id as string}>
                  {entry.project_title}
                </option>
              ))}
            </select>
            <p id="calc-project-help" className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-text-muted">
              <FolderKanban size={12} className="mt-1 shrink-0 text-accent" />
              <span>
                <Link href="/calculator/project/new" className="font-semibold text-accent hover:underline">
                  Create a project
                </Link>{' '}
                to keep every estimate for one engagement together.
              </span>
            </p>
          </div>
          <div>
            <label htmlFor="calc-name" className="block text-xs font-semibold text-text-muted mb-2">
              Estimate Name
            </label>
            <input
              id="calc-name"
              required
              className="premium-input w-full px-4 text-sm"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Verbal - production baseline"
            />
          </div>
          <div>
            <label htmlFor="calc-region" className="block text-xs font-semibold text-text-muted mb-2">
              Region
            </label>
            <select
              id="calc-region"
              className="premium-input w-full px-4 text-sm"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
            >
              {REGIONS.map((option) => (
                <option key={option.value || 'auto'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <label htmlFor="calc-prompt" className="block text-xs font-semibold text-text-muted mb-2">
              Describe the workload
            </label>
            <textarea
              id="calc-prompt"
              rows={8}
              className="premium-input w-full px-4 py-3 text-sm leading-6"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={EXAMPLE}
              aria-describedby="calc-prompt-help"
            />
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <p id="calc-prompt-help" className="text-xs leading-5 text-text-muted">
                Include instance sizes, storage and traffic where you know them. Anything you leave
                out gets a sensible default, listed in the estimate&apos;s assumptions.
              </p>
              <button
                type="button"
                onClick={() => setPrompt(EXAMPLE)}
                className="shrink-0 text-xs font-semibold text-accent hover:underline"
              >
                Use example
              </button>
            </div>
          </div>
          <div className="space-y-6">
          {/* Spreadsheet input. Optional and combinable with the description above —
              a sheet of resources plus a sentence of context is the common case. */}
          <div className="rounded-xl border border-border bg-surface-elevated p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-text-primary">Resource list (optional)</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Upload an .xlsx or .csv list of resources. The template columns are recognised
                  automatically; other sheets are read as-is and interpreted.
                </p>
              </div>
              <button
                type="button"
                onClick={downloadTemplate}
                className="btn-secondary inline-flex shrink-0 items-center gap-2 px-3 py-2 text-xs font-semibold"
              >
                <Download size={14} />
                Template
              </button>
            </div>

            <div className="mt-3">
              {sheet ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
                  <span className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-text-primary">
                    <FileSpreadsheet size={14} className="shrink-0 text-accent" />
                    <span className="truncate">{sheet.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSheet(null)}
                    className="shrink-0 text-text-muted transition-colors hover:text-danger"
                    aria-label="Remove the uploaded file"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs font-semibold text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary">
                  <FileSpreadsheet size={14} />
                  Choose a file
                  <input
                    type="file"
                    accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      setSheet(file);
                      setError(null);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          {/* Runtime hours. The whole point: non-production is normally shut down
              outside working hours, and pricing it at 24/7 overstates the estimate. */}
          <div className="rounded-xl border border-border bg-surface-elevated p-4">
            <p className="text-sm font-semibold text-text-primary">Runtime hours per environment</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              How many hours a day each environment actually runs. Time-billed resources are priced at
              these hours, so shutting non-production down overnight is reflected in the cost. A
              Hours/Day value in your sheet overrides the environment default for that row.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {environments.map((entry, index) => (
                <div key={entry.name}>
                  <label
                    htmlFor={`env-${index}`}
                    className="block text-xs font-semibold text-text-muted mb-1.5"
                  >
                    {entry.name}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id={`env-${index}`}
                      type="number"
                      min={1}
                      max={24}
                      value={entry.hoursPerDay}
                      onChange={(event) => setHours(index, event.target.value)}
                      className="premium-input w-full px-3 text-sm"
                    />
                    <span className="shrink-0 text-xs text-text-muted">h/day</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          </div>
        </div>

        <div className="flex justify-center border-t border-border pt-6">
        <button
          type="submit"
          disabled={loading}
          className="btn-primary flex w-full items-center justify-center gap-2 px-10 py-3 font-semibold disabled:opacity-50 sm:w-auto"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Calculator size={18} />}
          {uploading ? 'Uploading resource list...' : loading ? 'Starting estimate...' : 'Build Estimate'}
        </button>
        </div>
      </form>
      )}
    </div>
  );
}

export default function NewCalculationPage() {
  // useSearchParams requires a Suspense boundary above it.
  return (
    <Suspense
      fallback={(
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="animate-spin text-accent" />
        </div>
      )}
    >
      <NewCalculationForm />
    </Suspense>
  );
}
