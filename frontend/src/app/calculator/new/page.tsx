'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Calculator, Download, FileSpreadsheet, Loader2, X } from 'lucide-react';
import {
  calculatorApi,
  DEFAULT_ENVIRONMENT_HOURS,
  TEMPLATE_COLUMNS,
  TEMPLATE_ROWS,
  type EnvironmentHours,
} from '@/lib/calculatorApi';

/**
 * A handful of common AWS regions. The field stays a free-text-backed select
 * rather than an exhaustive enum because the MCP server validates the region
 * against the live AWS manifest anyway, and the model records the choice in the
 * estimate's assumptions when none is given.
 */
const REGIONS = [
  { value: '', label: 'Let the estimator choose (ap-south-1)' },
  { value: 'ap-south-1', label: 'Asia Pacific (Mumbai) - ap-south-1' },
  { value: 'us-east-1', label: 'US East (N. Virginia) - us-east-1' },
  { value: 'us-west-2', label: 'US West (Oregon) - us-west-2' },
  { value: 'eu-west-1', label: 'Europe (Ireland) - eu-west-1' },
  { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore) - ap-southeast-1' },
];

const EXAMPLE = `A production WordPress environment:
- Application Load Balancer
- 2x t3.large EC2 instances running Linux, on-demand
- RDS PostgreSQL db.t3.medium, Multi-AZ, 100 GB storage
- 200 GB of S3 Standard storage
- NAT Gateway with 500 GB monthly data processing`;

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

export default function NewCalculationPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [region, setRegion] = useState('');
  const [environments, setEnvironments] = useState<EnvironmentHours[]>(DEFAULT_ENVIRONMENT_HOURS);
  const [sheet, setSheet] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      const created = await calculatorApi.createCalculation({
        name: safeName,
        prompt: safePrompt || undefined,
        region: region || undefined,
        environment_hours: environments,
        input_s3_key: inputKey,
      });
      router.push(`/calculator/view?id=${created.calculation_id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start the estimate');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <Link
        href="/calculator"
        className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
      >
        <ArrowLeft size={16} />
        Back to estimates
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

      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <div className="border-b border-border pb-5">
          <h2 className="text-lg font-semibold text-text-primary">Workload details</h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            Name it something your team will recognise when comparing estimates later.
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

        <button
          type="submit"
          disabled={loading}
          className="btn-primary w-full py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <Calculator size={18} />}
          {uploading ? 'Uploading resource list...' : loading ? 'Starting estimate...' : 'Build Estimate'}
        </button>
      </form>
    </div>
  );
}
