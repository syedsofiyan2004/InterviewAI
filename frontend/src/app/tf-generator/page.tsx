'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  CloudCog,
  Code2,
  Download,
  FileCheck2,
  FileSpreadsheet,
  LockKeyhole,
  Network,
  Play,
  RefreshCw,
  Rocket,
  Route,
  Server,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, TfJob } from '@/lib/api';
import {
  generateTfReviewSummary,
  generateTerraformFiles,
  parseTfWorkbook,
  TfFile,
  TfManifest,
  TfReviewSummary,
  TfValidationMessage,
  validateTfManifest,
} from './terraform-workspace';

export default function TfGeneratorPage() {
  const [manifest, setManifest] = useState<TfManifest | null>(null);
  const [messages, setMessages] = useState<TfValidationMessage[]>([]);
  const [files, setFiles] = useState<TfFile[]>([]);
  const [selectedFile, setSelectedFile] = useState('provider.tf');
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [roleArn, setRoleArn] = useState('');
  const [tfJob, setTfJob] = useState<TfJob | null>(null);
  const [runnerLoading, setRunnerLoading] = useState(false);
  const [runnerError, setRunnerError] = useState<string | null>(null);

  const selected = files.find((file) => file.filename === selectedFile) || files[0];
  const hasErrors = messages.some((message) => message.severity === 'error');
  const hasWarnings = messages.some((message) => message.severity === 'warning');

  const summary = useMemo(() => {
    const regions = Array.from(new Set((manifest?.vpcs || []).map((vpc) => vpc.region).filter(Boolean)));
    const publicSubnets = manifest?.subnets.filter((subnet) => subnet.route_type === 'public').length || 0;
    const privateSubnets = manifest?.subnets.filter((subnet) => subnet.route_type === 'private').length || 0;
    return {
      accounts: manifest?.accounts.length || 0,
      vpcs: manifest?.vpcs.length || 0,
      subnets: manifest?.subnets.length || 0,
      publicSubnets,
      privateSubnets,
      natEnabled: manifest?.vpcs.filter((vpc) => vpc.nat_gateway).length || 0,
      regions,
    };
  }, [manifest]);

  const intakeState = manifest ? 'Workbook parsed' : loading ? 'Reading workbook' : 'Waiting for workbook';
  const reviewState = files.length ? 'Terraform ready' : hasErrors ? 'Fix validation issues' : 'Not generated yet';
  const deployState = tfJob ? humanTfStatus(tfJob.status) : files.length ? 'Ready to create job' : 'Waiting for Terraform';
  const roleArnValid = /^arn:aws:iam::\d{12}:role\/(TerraformDeployRole|MinfyTerraformDeployRole)$/.test(roleArn.trim());
  const reviewSummary = useMemo(() => (
    manifest ? generateTfReviewSummary(manifest, messages) : null
  ), [manifest, messages]);

  useEffect(() => {
    if (!tfJob || !isTfJobRunning(tfJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const refreshed = await api.getTfJob(tfJob.job_id);
        setTfJob(refreshed);
      } catch (err: any) {
        setRunnerError(err.message || 'Unable to refresh Terraform job status');
      }
    }, 8000);

    return () => window.clearInterval(timer);
  }, [tfJob?.job_id, tfJob?.status]);

  const downloadFile = (file: TfFile | undefined) => {
    if (!file) return;
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadBundle = () => {
    if (!files.length) return;
    const content = files
      .map((file) => `# ===== ${file.filename} =====\n${file.content.trim()}\n`)
      .join('\n\n');
    downloadFile({ filename: `${slugForDownload(manifest?.deployment_name || 'terraform-review')}.tfbundle.txt`, content });
  };

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setFiles([]);
    setMessages([]);
    setManifest(null);
    setRoleArn('');
    setTfJob(null);
    setRunnerError(null);
    setFileName(file.name);

    try {
      const parsed = await parseTfWorkbook(file);
      const validation = validateTfManifest(parsed);
      setManifest(parsed);
      setRoleArn(parsed.accounts.find((account) => account.role_arn)?.role_arn || '');
      setMessages(validation);
      if (!validation.some((message) => message.severity === 'error')) {
        const generated = generateTerraformFiles(parsed);
        setFiles(generated);
        setSelectedFile(generated[0]?.filename || '');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to parse workbook');
    } finally {
      setLoading(false);
    }
  };

  const createDeploymentJob = async () => {
    if (!manifest || !files.length || !roleArnValid) return;
    setRunnerLoading(true);
    setRunnerError(null);
    try {
      const created = await api.createTfJob({
        deployment_name: manifest.deployment_name,
        primary_region: manifest.primary_region,
        role_arn: roleArn.trim(),
        files,
      });
      setTfJob(created);
    } catch (err: any) {
      setRunnerError(err.message || 'Unable to create Terraform deployment job');
    } finally {
      setRunnerLoading(false);
    }
  };

  const runRunnerAction = async (action: 'plan' | 'approve' | 'apply') => {
    if (!tfJob) return;
    setRunnerLoading(true);
    setRunnerError(null);
    try {
      const next = action === 'plan'
        ? await api.runTfPlan(tfJob.job_id)
        : action === 'approve'
          ? await api.approveTfJob(tfJob.job_id)
          : await api.runTfApply(tfJob.job_id);
      setTfJob(next);
    } catch (err: any) {
      setRunnerError(err.message || `Unable to ${action} Terraform job`);
    } finally {
      setRunnerLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-8">
      <section className="relative overflow-hidden rounded-2xl border border-border bg-surface-elevated/80 px-6 py-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_18%,rgba(16,185,129,0.16),transparent_28rem),radial-gradient(circle_at_92%_4%,rgba(79,70,229,0.14),transparent_26rem)]" />
        <div className="relative z-10 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-lg shadow-accent/20">
                <CloudCog size={23} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Minfy AI TF Generator</p>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">AWS network deployment console</p>
              </div>
            </div>

            <h1 className="mt-7 max-w-4xl text-[clamp(34px,5vw,64px)] font-semibold leading-[0.98] tracking-tight text-text-primary">
              Review infrastructure before it reaches AWS.
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-text-secondary">
              Convert prerequisite workbooks into a checked network manifest and Terraform files. The workspace generates VPC, subnet, routing, and output code for controlled plan review.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-background/70 p-4 backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted">Control state</p>
                <p className="mt-2 text-xl font-semibold text-text-primary">{reviewState}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${hasErrors ? 'bg-danger/10 text-danger' : files.length ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                Production review
              </span>
            </div>
            <div className="mt-5 grid gap-2">
              <FlowItem active={!!manifest} label="Workbook" value={intakeState} />
              <FlowItem active={!!messages.length && !hasErrors} warning={hasWarnings} label="Validation" value={messages.length ? `${messages.length} checks returned` : 'Awaiting manifest'} />
              <FlowItem active={!!files.length} label="Terraform" value={files.length ? `${files.length} files generated` : 'Locked until valid'} />
              <FlowItem active={!!tfJob && !isTfJobFailed(tfJob.status)} warning={isTfJobFailed(tfJob?.status)} locked={!files.length} label="Deploy" value={deployState} />
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <FileSpreadsheet size={20} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-text-primary">Workbook intake</h2>
                <p className="text-xs text-text-muted">Secure browser-side parsing before plan review.</p>
              </div>
            </div>

            <div className="mt-5 rounded-xl border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{fileName || 'No workbook selected'}</p>
                  <p className="mt-1 text-xs text-text-muted">Accepted: .xlsx</p>
                </div>
                <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 transition-transform hover:-translate-y-0.5">
                  <Upload size={16} />
                  Upload
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="hidden"
                    onChange={(event) => handleUpload(event.target.files?.[0] || null)}
                  />
                </label>
              </div>
            </div>

            {loading && (
              <Notice tone="info" title="Parsing workbook" detail="Building the deployment manifest and Terraform review bundle." />
            )}
            {error && (
              <Notice tone="error" title="Workbook could not be parsed" detail={error} />
            )}

            <div className="mt-5 rounded-xl border border-warning/25 bg-warning/5 p-4">
              <div className="flex gap-3">
                <LockKeyhole size={18} className="mt-0.5 text-warning" />
                <div>
                  <p className="text-sm font-semibold text-text-primary">Deployment guardrail</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                    AWS changes require Terraform plan output, role verification, explicit approval, and the controlled deployment runner.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Metric title="Accounts" value={summary.accounts} icon={ShieldCheck} caption="Context only" />
            <Metric title="Regions" value={summary.regions.length} icon={Server} caption={summary.regions[0] || 'None'} />
            <Metric title="VPCs" value={summary.vpcs} icon={Network} caption={`${summary.natEnabled} NAT enabled`} />
            <Metric title="Subnets" value={summary.subnets} icon={Route} caption={`${summary.publicSubnets} public / ${summary.privateSubnets} private`} />
          </div>
        </div>

        <div className="space-y-5">
          {reviewSummary && (
            <ReviewAssistant summary={reviewSummary} />
          )}

          <div className="card overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-base font-semibold text-text-primary">Network manifest</h2>
                <p className="mt-1 text-xs text-text-muted">Only VPC networking is generated. Non-network workbook tabs stay outside Terraform scope.</p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-secondary">
                <FileCheck2 size={14} />
                {manifest ? manifest.deployment_name : 'Awaiting workbook'}
              </span>
            </div>

            {manifest ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left">
                  <thead>
                    <tr className="border-b border-border bg-surface/80">
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Type</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Name</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">CIDR</th>
                      <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">Placement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifest.vpcs.map((vpc) => (
                      <tr key={`vpc-${vpc.logical_name}`} className="border-b border-border/80">
                        <td className="px-5 py-3 text-sm font-semibold text-text-primary">VPC</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{vpc.logical_name}</td>
                        <td className="px-5 py-3 font-mono text-xs text-text-secondary">{vpc.cidr}</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{vpc.region}</td>
                      </tr>
                    ))}
                    {manifest.subnets.map((subnet) => (
                      <tr key={`subnet-${subnet.logical_name}`} className="border-b border-border/80">
                        <td className="px-5 py-3 text-sm font-semibold text-text-primary">Subnet</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">{subnet.logical_name}</td>
                        <td className="px-5 py-3 font-mono text-xs text-text-secondary">{subnet.cidr}</td>
                        <td className="px-5 py-3 text-sm text-text-secondary">
                          <span className="capitalize">{subnet.route_type}</span> / AZ {subnet.az_label.toUpperCase()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex min-h-[280px] items-center justify-center px-6 py-10">
                <div className="max-w-md text-center">
                  <Network className="mx-auto text-accent" size={32} />
                  <p className="mt-4 text-base font-semibold text-text-primary">Upload a workbook to review the deployment manifest</p>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    The review will show accounts as context, then the VPCs and subnets that Terraform can generate.
                  </p>
                </div>
              </div>
            )}
          </div>

          {messages.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  {hasErrors ? <AlertTriangle size={18} className="text-danger" /> : <CheckCircle2 size={18} className="text-success" />}
                  <h2 className="text-base font-semibold text-text-primary">Validation</h2>
                </div>
                <span className="text-xs font-medium text-text-muted">{hasErrors ? 'Action needed' : 'Ready for code review'}</span>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {messages.map((message, index) => (
                  <ValidationCard key={`${message.title}-${index}`} message={message} />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {files.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Rocket size={18} className="text-accent" />
                <h2 className="text-base font-semibold text-text-primary">Controlled deployment</h2>
              </div>
              <p className="mt-1 text-xs text-text-muted">Create a secured job, run Terraform plan, approve the result, then apply through the AWS runner.</p>
            </div>
            <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${tfJob ? tfStatusClass(tfJob.status) : 'bg-surface text-text-secondary'}`}>
              {deployState}
            </span>
          </div>

          <div className="grid gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-semibold text-text-primary">Cross-account deploy role</span>
                <input
                  value={roleArn}
                  onChange={(event) => {
                    setRoleArn(event.target.value);
                    setTfJob(null);
                  }}
                  placeholder="arn:aws:iam::123456789012:role/TerraformDeployRole"
                  className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 font-mono text-sm text-text-primary outline-none transition-colors focus:border-accent"
                />
                <span className={`mt-2 block text-xs ${roleArn && !roleArnValid ? 'text-danger' : 'text-text-muted'}`}>
                  Allowed roles: TerraformDeployRole or MinfyTerraformDeployRole in the target AWS account.
                </span>
              </label>

              {runnerError && (
                <Notice tone="error" title="Terraform runner error" detail={runnerError} />
              )}

              {tfJob?.plan_output && (
                <RunnerOutput title="Latest plan output" content={tfJob.plan_output} />
              )}
              {tfJob?.apply_output && (
                <RunnerOutput title="Latest apply output" content={tfJob.apply_output} />
              )}
            </div>

            <div className="rounded-2xl border border-border bg-surface/70 p-4">
              <div className="space-y-3">
                <RunnerStep index="01" title="Create job" active={!!tfJob} />
                <RunnerStep index="02" title="Run plan" active={!!(tfJob?.plan_output || tfJob?.status === 'PLAN_SUCCEEDED' || tfJob?.status === 'APPROVED' || tfJob?.status.startsWith('APPLY_'))} />
                <RunnerStep index="03" title="Approve plan" active={!!(tfJob?.approved_at || tfJob?.status === 'APPROVED' || tfJob?.status.startsWith('APPLY_'))} />
                <RunnerStep index="04" title="Apply" active={tfJob?.status === 'APPLY_SUCCEEDED'} />
              </div>

              <div className="mt-5 grid gap-2">
                {!tfJob ? (
                  <button
                    type="button"
                    disabled={!roleArnValid || runnerLoading}
                    onClick={createDeploymentJob}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {runnerLoading ? <RefreshCw size={16} className="animate-spin" /> : <CloudCog size={16} />}
                    Create deployment job
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={runnerLoading || isTfJobRunning(tfJob.status)}
                      onClick={() => runRunnerAction('plan')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isTfJobRunning(tfJob.status) ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                      Run Terraform plan
                    </button>
                    <button
                      type="button"
                      disabled={runnerLoading || tfJob.status !== 'PLAN_SUCCEEDED'}
                      onClick={() => runRunnerAction('approve')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm font-semibold text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ShieldCheck size={16} />
                      Approve latest plan
                    </button>
                    <button
                      type="button"
                      disabled={runnerLoading || !tfJob.approved_at || !['APPROVED', 'APPLY_FAILED'].includes(tfJob.status)}
                      onClick={() => runRunnerAction('apply')}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white shadow-sm shadow-success/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Rocket size={16} />
                      Apply to AWS
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {files.length > 0 && (
        <section className="card overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Code2 size={18} className="text-accent" />
                <h2 className="text-base font-semibold text-text-primary">Terraform review</h2>
              </div>
              <p className="mt-1 text-xs text-text-muted">Generated for source review. AWS changes require a controlled plan and approval workflow.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => downloadFile(selected)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:bg-surface-elevated"
              >
                <Download size={16} />
                Download file
              </button>
              <button
                type="button"
                onClick={downloadBundle}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm shadow-accent/20"
              >
                <Download size={16} />
                Download bundle
              </button>
            </div>
          </div>
          <div className="grid min-h-[500px] grid-cols-1 lg:grid-cols-[250px_1fr]">
            <aside className="border-b border-border bg-surface/80 p-3 lg:border-b-0 lg:border-r">
              <div className="space-y-1">
                {files.map((file) => (
                  <button
                    key={file.filename}
                    onClick={() => setSelectedFile(file.filename)}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${selected?.filename === file.filename ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-surface-elevated hover:text-text-primary'}`}
                  >
                    <span>{file.filename}</span>
                    {selected?.filename === file.filename && <ArrowRight size={14} />}
                  </button>
                ))}
              </div>
            </aside>
            <pre className="overflow-auto bg-[#07111f] p-5 text-xs leading-6 text-slate-100">
              <code>{selected?.content || ''}</code>
            </pre>
          </div>
        </section>
      )}
    </div>
  );
}

function ReviewAssistant({ summary }: { summary: TfReviewSummary }) {
  const toneClass = summary.readiness === 'Blocked'
    ? 'bg-danger/10 text-danger'
    : summary.readiness === 'Review needed'
      ? 'bg-warning/10 text-warning'
      : 'bg-success/10 text-success';

  const visibleFindings = summary.findings.slice(0, 4);

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <BrainCircuit size={20} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-text-primary">Deployment review assistant</h2>
              <p className="mt-1 text-xs leading-5 text-text-muted">{summary.headline}</p>
            </div>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${toneClass}`}>
            {summary.readiness}
          </span>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-border p-5 lg:border-b-0 lg:border-r">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Resource plan</p>
          <div className="mt-4 grid gap-2">
            {summary.resource_plan.map((item) => (
              <div key={item.label} className="rounded-xl border border-border bg-surface/70 px-3 py-3">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold text-text-primary">{item.label}</p>
                  <p className="font-mono text-lg font-semibold text-accent">{item.count}</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-muted">Recommendations</p>
          <div className="mt-4 space-y-3">
            {visibleFindings.map((finding, index) => (
              <div key={`${finding.title}-${index}`} className="rounded-xl border border-border bg-surface/60 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-text-primary">{finding.title}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${finding.severity === 'error' ? 'bg-danger/10 text-danger' : finding.severity === 'warning' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>
                    {finding.severity}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-text-secondary">{finding.recommendation}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-xl border border-border bg-background/60 px-4 py-3">
            <p className="text-xs font-semibold text-text-primary">Next checkpoint</p>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{summary.next_steps[0]}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FlowItem({ active, warning, locked, label, value }: { active: boolean; warning?: boolean; locked?: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/70 px-3 py-2.5">
      <div>
        <p className="text-xs font-semibold text-text-primary">{label}</p>
        <p className="mt-0.5 text-[11px] text-text-muted">{value}</p>
      </div>
      <span className={`h-2.5 w-2.5 rounded-full ${locked ? 'bg-text-muted' : warning ? 'bg-warning' : active ? 'bg-success' : 'bg-border'}`} />
    </div>
  );
}

function Metric({ title, value, icon: Icon, caption }: { title: string; value: number; icon: LucideIcon; caption: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon size={18} />
        </span>
        <p className="text-2xl font-semibold text-text-primary">{value}</p>
      </div>
      <p className="mt-4 text-sm font-semibold text-text-primary">{title}</p>
      <p className="mt-1 truncate text-xs text-text-muted">{caption}</p>
    </div>
  );
}

function Notice({ tone, title, detail }: { tone: 'info' | 'error'; title: string; detail: string }) {
  const toneClass = tone === 'error'
    ? 'border-danger/30 bg-danger/5 text-danger'
    : 'border-accent/25 bg-accent/5 text-accent';

  return (
    <div className={`mt-4 rounded-lg border px-4 py-3 ${toneClass}`}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{detail}</p>
    </div>
  );
}

function ValidationCard({ message }: { message: TfValidationMessage }) {
  const toneClass = message.severity === 'error'
    ? 'border-danger/30 bg-danger/5'
    : message.severity === 'warning'
      ? 'border-warning/30 bg-warning/5'
      : 'border-success/25 bg-success/5';

  return (
    <div className={`rounded-xl border px-4 py-3 ${toneClass}`}>
      <p className="text-sm font-semibold text-text-primary">{message.title}</p>
      <p className="mt-1 text-xs leading-5 text-text-secondary">{message.detail}</p>
    </div>
  );
}

function RunnerStep({ index, title, active }: { index: string; title: string; active: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-3 ${active ? 'border-accent/25 bg-accent/10' : 'border-border bg-background/70'}`}>
      <div className="flex items-center gap-3">
        <span className={`font-mono text-xs font-semibold ${active ? 'text-accent' : 'text-text-muted'}`}>{index}</span>
        <span className="text-sm font-semibold text-text-primary">{title}</span>
      </div>
      <span className={`h-2.5 w-2.5 rounded-full ${active ? 'bg-success' : 'bg-border'}`} />
    </div>
  );
}

function RunnerOutput({ title, content }: { title: string; content: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-[#07111f]">
      <div className="border-b border-white/10 px-4 py-3">
        <p className="text-sm font-semibold text-white">{title}</p>
      </div>
      <pre className="max-h-80 overflow-auto p-4 text-xs leading-6 text-slate-100">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function isTfJobRunning(status?: string): boolean {
  return ['PLAN_QUEUED', 'PLAN_RUNNING', 'APPLY_QUEUED', 'APPLY_RUNNING'].includes(status || '');
}

function isTfJobFailed(status?: string): boolean {
  return ['PLAN_FAILED', 'APPLY_FAILED'].includes(status || '');
}

function humanTfStatus(status: string): string {
  const labels: Record<string, string> = {
    CREATED: 'Job created',
    PLAN_QUEUED: 'Plan queued',
    PLAN_RUNNING: 'Plan running',
    PLAN_SUCCEEDED: 'Plan ready',
    PLAN_FAILED: 'Plan failed',
    APPROVED: 'Approved',
    APPLY_QUEUED: 'Apply queued',
    APPLY_RUNNING: 'Apply running',
    APPLY_SUCCEEDED: 'Applied',
    APPLY_FAILED: 'Apply failed',
  };
  return labels[status] || status;
}

function tfStatusClass(status: string): string {
  if (isTfJobFailed(status)) return 'bg-danger/10 text-danger';
  if (isTfJobRunning(status)) return 'bg-warning/10 text-warning';
  if (status === 'APPLY_SUCCEEDED' || status === 'PLAN_SUCCEEDED' || status === 'APPROVED') return 'bg-success/10 text-success';
  return 'bg-surface text-text-secondary';
}

function slugForDownload(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'terraform-review';
}
