'use client';

import { FormEvent, useState } from 'react';
import { ArrowRight, FileSpreadsheet, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { calculatorApi } from '@/lib/calculatorApi';

export default function CalculatorWorkbookConverterPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('Formatted AWS workload workbook');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) { setError('Choose an Excel workbook first.'); return; }
    setBusy(true); setError(null);
    try {
      const uploaded = await calculatorApi.uploadResourceSheet(file);
      const created = await calculatorApi.analyzeCalculation({
        name: name.trim() || 'Formatted AWS workload workbook',
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
    <main className="mx-auto max-w-3xl space-y-8 p-6 lg:p-10">
      <div>
        <p className="page-kicker">AWS Cost Calculator</p>
        <h1 className="mt-2 text-3xl font-semibold text-text-primary">Excel Converter</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
          Convert any workload workbook into a clear pricing table before building an estimate.
          MIMO adds missing columns, highlights material cells to complete, and keeps source references.
        </p>
      </div>

      <section className="card space-y-6 p-6">
        <div className="rounded-lg border border-accent/25 bg-accent/5 p-4 text-sm leading-6 text-text-secondary">
          <strong className="text-text-primary">Which file do I edit?</strong><br />
          After conversion, edit the downloaded <strong>prepared workbook</strong> wherever cells are highlighted.
          Then upload that completed prepared workbook in the estimate review screen. You do not edit or re-upload the original.
        </div>
        <form onSubmit={submit} className="space-y-5">
          <label className="block text-sm font-semibold text-text-primary">
            Workbook name
            <input className="premium-input mt-2 w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm font-semibold text-text-secondary hover:border-accent/50">
            <FileSpreadsheet size={20} className="text-accent" />
            <span>{file ? file.name : 'Choose .xlsx or .csv workbook'}</span>
            <input className="sr-only" type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button className="btn-primary inline-flex items-center gap-2" disabled={busy || !file}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {busy ? 'Analyzing workbook...' : 'Analyze and format workbook'}
          </button>
        </form>
      </section>
    </main>
  );
}
