'use client';

import { FormEvent, useState } from 'react';
import { ArrowRight, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { calculatorApi } from '@/lib/calculatorApi';

export default function CalculatorWorkbookConverterPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError('Choose an Excel workbook first.'); return; }
    setBusy(true); setError(null);
    try {
      const uploaded = await calculatorApi.uploadResourceSheet(file);
      const created = await calculatorApi.analyzeCalculation({
        name: file.name.replace(/\.[^.]+$/, '') || 'Formatted AWS workload workbook',
        input_s3_key: uploaded.s3_key,
        prepare_workbook: true,
      });
      router.push(`/calculator/new?review=${encodeURIComponent(created.calculation_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workbook could not be analyzed.');
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
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-text-secondary">
            <span><strong className="text-text-primary">What you edit:</strong> the prepared workbook after it downloads, wherever cells are highlighted.</span>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent"><CheckCircle2 size={14} /> Source references retained</span>
          </div>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button className="btn-primary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" disabled={busy || !file}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {busy ? 'Preparing workbook...' : 'Prepare workbook'}
          </button>
        </form>
      </section>
    </main>
  );
}
