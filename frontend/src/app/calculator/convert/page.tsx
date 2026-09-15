'use client';

import { FormEvent, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { calculatorApi, type EnvironmentHours } from '@/lib/calculatorApi';

const REGIONS = [
  ['ap-south-1', 'Asia Pacific (Mumbai)'], ['ap-southeast-1', 'Asia Pacific (Singapore)'],
  ['ap-southeast-2', 'Asia Pacific (Sydney)'], ['eu-central-1', 'Europe (Frankfurt)'],
  ['eu-west-1', 'Europe (Ireland)'], ['us-east-1', 'US East (N. Virginia)'],
  ['us-west-2', 'US West (Oregon)'], ['ca-central-1', 'Canada (Central)'],
] as const;

const DEFAULT_ENVIRONMENT_POLICY: EnvironmentHours[] = [
  { name: 'Production', hoursPerDay: 24 },
  { name: 'UAT', hoursPerDay: 12 },
  { name: 'Staging', hoursPerDay: 12 },
  { name: 'Test', hoursPerDay: 8 },
  { name: 'Development', hoursPerDay: 8 },
  { name: 'Non-Production', hoursPerDay: 8 },
  { name: 'Sandbox', hoursPerDay: 8 },
];

export default function CalculatorWorkbookConverterPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [region, setRegion] = useState('');
  const [environmentHours, setEnvironmentHours] = useState<EnvironmentHours[]>(DEFAULT_ENVIRONMENT_POLICY);
  const [projects, setProjects] = useState<Array<{ project_id: string; project_title: string }>>([]);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void calculatorApi.getCalculationProjects().then((data) => {
      setProjects(data.items.flatMap((item) => item.project_id ? [{ project_id: item.project_id, project_title: item.project_title }] : []));
    }).catch(() => undefined);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError('Choose an Excel workbook first.'); return; }
    setBusy(true); setError(null);
    setProgress('Uploading the original workbook...');
    try {
      const uploaded = await calculatorApi.uploadResourceSheet(file);
      setProgress('Reading sheets and preserving source references...');
      const created = await calculatorApi.analyzeCalculation({
        name: file.name.replace(/\.[^.]+$/, '') || 'Formatted AWS workload workbook',
        input_s3_key: uploaded.s3_key,
        prepare_workbook: true,
        region: region || undefined,
        project_id: projectId || undefined,
        environment_hours: environmentHours,
      });
      if (created.status === 'ANALYZING') {
        setProgress('AI is interpreting services, sizing and material gaps...');
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          const current = await calculatorApi.getCalculation(created.calculation_id);
          setProgress(current.progress_message || 'Preparing your workbook...');
          if (current.status === 'REVIEW_REQUIRED') break;
          if (current.status === 'FAILED') throw new Error(current.error_message || 'Workbook preparation failed.');
        }
        if (Date.now() >= deadline) throw new Error('Workbook preparation is still running. Open the estimate from its project to check the result.');
      }
      setProgress('Prepared workbook ready. Opening review...');
      router.push(`/calculator/new?review=${encodeURIComponent(created.calculation_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workbook could not be analyzed.');
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6 lg:p-10">
      <div className="max-w-2xl">
        <p className="page-kicker">AWS Cost Calculator</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-primary">Prepare your workbook</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          Turn an existing Excel file into a clear, source-linked input for your AWS estimate.
          We add the columns you need and highlight only important values that are missing.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['1', 'Upload', 'Choose your original workbook'],
          ['2', 'Complete', 'Fill highlighted cells'],
          ['3', 'Estimate', 'Use it to build pricing'],
        ].map(([number, title, text], index) => (
          <div key={number} className="flex items-start gap-3 rounded-xl border border-border bg-surface-elevated p-4">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${index === 0 ? 'bg-accent text-surface' : 'bg-surface text-text-muted'}`}>{number}</span>
            <div><p className="text-sm font-semibold text-text-primary">{title}</p><p className="mt-1 text-xs leading-5 text-text-muted">{text}</p></div>
          </div>
        ))}
      </div>

      <section className="card overflow-hidden">
        <div className="border-b border-border bg-surface-elevated px-6 py-5 sm:px-8">
          <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 text-accent" size={19} /><div><h2 className="text-base font-semibold text-text-primary">Start with your original file</h2><p className="mt-1 text-sm text-text-secondary">Your original workbook stays unchanged.</p></div></div>
        </div>
        <form onSubmit={submit} className="space-y-6 p-6 sm:p-8">
          <label className="group flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-surface px-6 text-center transition-colors hover:border-accent/60 hover:bg-accent/5">
            {file ? <FileSpreadsheet size={32} className="text-accent" /> : <UploadCloud size={32} className="text-accent" />}
            <span className="mt-3 text-sm font-semibold text-text-primary">{file ? file.name : 'Drop your workbook here or browse'}</span>
            <span className="mt-1 text-xs text-text-muted">Excel .xlsx or CSV · Original file is never overwritten</span>
            <input className="sr-only" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <label className="block text-sm font-semibold text-text-primary">
            Default AWS Region <span className="font-normal text-text-muted">(used only where the workbook does not specify one)</span>
            <select className="premium-input mt-2 w-full" value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Let the workbook decide</option>
              {REGIONS.map(([value, label]) => <option key={value} value={value}>{label} ({value})</option>)}
            </select>
          </label>
          <section className="rounded-xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-text-primary">Environment runtime policy</h3>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              These values fill blank compute schedules in the prepared workbook. Explicit workbook hours always win.
              Production databases default to Multi-AZ; these lower environments default to Single-AZ unless the workbook says otherwise.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {environmentHours.map((entry, index) => (
                <label key={entry.name} className="text-xs font-semibold text-text-muted">
                  {entry.name}
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={24}
                      value={entry.hoursPerDay}
                      onChange={(event) => setEnvironmentHours((current) => current.map((item, at) => at === index
                        ? { ...item, hoursPerDay: Math.min(24, Math.max(1, Number(event.target.value) || item.hoursPerDay)) }
                        : item))}
                      className="premium-input w-full px-3 py-2 text-sm"
                    />
                    <span className="shrink-0 font-normal text-text-muted">h/day</span>
                  </div>
                </label>
              ))}
            </div>
          </section>
          <label className="block text-sm font-semibold text-text-primary">
            Project <span className="font-normal text-text-muted">(optional)</span>
            <select className="premium-input mt-2 w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Keep in ungrouped estimates</option>
              {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.project_title}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-text-secondary">
            <span><strong className="text-text-primary">What you edit:</strong> the prepared workbook after it downloads, wherever cells are highlighted.</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent"><CheckCircle2 size={14} /> Source references retained</span>
          </div>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          {busy && progress && (
            <div className="rounded-xl border border-accent/30 bg-accent/5 p-4" role="status" aria-live="polite">
              <div className="flex items-center gap-3"><Loader2 size={18} className="animate-spin text-accent" /><div><p className="text-sm font-semibold text-text-primary">Preparing your workbook</p><p className="mt-1 text-xs text-text-secondary">{progress}</p></div></div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full w-2/3 animate-pulse rounded-full bg-accent" /></div>
              <p className="mt-2 text-xs text-text-muted">You can leave this page. The conversion continues and remains available under the selected project.</p>
            </div>
          )}
          <button className="btn-primary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || !file}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {busy ? 'Preparing workbook...' : 'Prepare workbook'}
          </button>
        </form>
      </section>
    </main>
  );
}
