'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, InterviewIntelligenceRecord } from '@/lib/api';
import { ArrowLeft, ArrowRight, BrainCircuit, BriefcaseBusiness, CheckCircle2, ClipboardCheck, Download, ExternalLink, FileText, MessageSquareText, RefreshCw, ShieldCheck, Trash2, Upload, Users, type LucideIcon } from 'lucide-react';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EvidenceCard } from '@/components/ui/EvidenceCard';
import { HeroNumber } from '@/components/ui/HeroNumber';
import { getIntelligenceCandidateName } from '@/lib/getIntelligenceCandidateName';
import { LiveProgressBanner } from '@/components/ui/LiveProgressBanner';
import { QuestionPlanPicker } from '@/components/interview/QuestionPlanPicker';

const workspaceTabs = ['Brief', 'Panel guide', 'Case interview', 'Transcript', 'Review'];
const steps = workspaceTabs.map((label, index) => ({ label, anchor: `workspace-${index}` }));

export default function InterviewIntelligenceViewPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get('id') || '';
  const [record, setRecord] = useState<InterviewIntelligenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  /** Whether the topic/count picker is open for regenerating an existing guide. */
  const [replanOpen, setReplanOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');
  const [visibleStep, setVisibleStep] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [candidateEmail, setCandidateEmail] = useState('');
  const [organizerEmail, setOrganizerEmail] = useState('');
  const automaticAnalysisRef = useRef<string | null>(null);

  const activeStep = useMemo(() => {
    if (!record) return 0;
    if (record.status === 'approved') return 4;
    if (record.aiEvaluation) return 4;
    if (record.transcript) return 4;
    if (record.caseInterview?.enabled) return 2;
    if (record.questionPlan) return 1;
    return 0;
  }, [record]);

  useEffect(() => {
    setVisibleStep(activeStep);
  }, [activeStep]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!id) return;
      try {
        const data = await api.getIntelligenceInterview(id);
        if (!mounted) return;
        setRecord(data);
        setTranscriptText(data.transcript?.rawText || '');
        setCandidateEmail(data.candidate.email || '');
        setOrganizerEmail(data.teams.organizerEmail || '');
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Failed to load intelligence interview');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, [id]);

  const runAction = async (label: string, action: () => Promise<InterviewIntelligenceRecord>) => {
    setBusy(label);
    setError(null);
    try {
      const updated = await action();
      setRecord(updated);
    } catch (err) {
      // Question generation persists before the response returns. A dropped
      // browser/API response must not leave the workspace showing an error
      // when the guide was actually created.
      if (label === 'questions') {
        try {
          const latest = await api.getIntelligenceInterview(id);
          if (latest.questionPlan) {
            setRecord(latest);
            return;
          }
        } catch {
          // Surface the original action error below if the verification read also fails.
        }
      }
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!record?.transcript || !record.questionPlan || record.aiEvaluation || busy) return;
    if (record.status === 'analysis_processing' || record.status === 'analysis_failed') return;
    // Do not race analysis with question generation — wait for the guide to finish.
    if (record.progress_stage === 'queued' || record.progress_stage === 'generating_questions') return;
    if (automaticAnalysisRef.current === record.intelligence_id) return;
    automaticAnalysisRef.current = record.intelligence_id;
    void runAction('analysis', () => api.analyzeIntelligenceInterview(record.intelligence_id));
  }, [record?.intelligence_id, record?.transcript?.uploadedAt, record?.questionPlan?.generatedAt, record?.aiEvaluation, busy]);

  useEffect(() => {
    if (!record || record.status !== 'analysis_processing') return;
    let cancelled = false;

    const refreshReview = async () => {
      try {
        const latest = await api.getIntelligenceInterview(record.intelligence_id);
        if (cancelled) return;
        setRecord(latest);
        if (latest.status === 'analysis_failed' && latest.analysisError) {
          setError(latest.analysisError);
        }
      } catch {
        // Keep the saved processing state visible; the next poll can recover.
      }
    };

    void refreshReview();
    const timer = window.setInterval(() => { void refreshReview(); }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [record?.intelligence_id, record?.status]);

  // Question generation runs in the background (it exceeds the API Gateway
  // response window), so poll immediately and periodically until the guide
  // lands or the worker reports back.
  useEffect(() => {
    if (!record) return;
    // Poll while the worker is active. This must not exit early when a plan
    // already exists, or "Refresh guide" would never pick up the new one.
    const generating = record.progress_stage === 'queued' || record.progress_stage === 'generating_questions';
    if (!generating) return;
    let cancelled = false;

    const refreshQuestions = async () => {
      try {
        const latest = await api.getIntelligenceInterview(record.intelligence_id);
        if (cancelled) return;
        setRecord(latest);
        if (latest.progress_stage === 'failed') {
          setError(latest.progress_message || 'The interview guide could not be generated. Please retry.');
        }
      } catch {
        // Keep the current state visible; the next poll can recover.
      }
    };

    // Fire once immediately so the user does not stare at the button for 4s.
    void refreshQuestions();
    const timer = window.setInterval(() => { void refreshQuestions(); }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [record?.intelligence_id, record?.progress_stage]);

  useEffect(() => {
    if (!record || record.teams.transcriptStatus !== 'transcribing') return;
    let cancelled = false;

    const refreshTranscript = async () => {
      try {
        const latest = await api.getIntelligenceInterview(record.intelligence_id);
        if (cancelled) return;
        setRecord(latest);
        setTranscriptText(latest.transcript?.rawText || '');
        if (latest.teams.transcriptStatus === 'failed' && latest.teams.error) {
          setError(latest.teams.error);
        }
      } catch {
        // Keep the saved transcription state visible; the next poll can recover.
      }
    };

    void refreshTranscript();
    const timer = window.setInterval(() => { void refreshTranscript(); }, 7000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [record?.intelligence_id, record?.teams.transcriptStatus]);

  if (loading) {
    return <IntelligenceViewSkeleton />;
  }

  if (!record) {
    return (
      <div className="mx-auto max-w-4xl p-8">
        <Link href="/interviews/intelligence" className="text-sm font-semibold text-accent">Back</Link>
        <p className="mt-6 text-sm text-danger">{error || 'Record not found'}</p>
      </div>
    );
  }

  const reviewInProgress = busy === 'analysis' || record.status === 'analysis_processing';
  const nextAction = !record.questionPlan
    ? { tab: 1, label: 'Prepare panel guide', detail: 'Generate the focused interview guide before the conversation.' }
    : !record.transcript
      ? record.caseInterview?.enabled
        ? { tab: 2, label: 'Review the optional case', detail: 'Use the case pack only if the panel wants a case-style assessment for this role.' }
        : { tab: 3, label: 'Bring in the transcript', detail: 'Continue after Teams has completed transcription for the meeting.' }
      : !record.aiEvaluation
        ? { tab: 4, label: 'Review interview evidence', detail: 'MiMo compares the transcript with the role, guide, candidate context, and optional case evidence.' }
        : record.status !== 'approved'
          ? { tab: 4, label: 'Approve the report', detail: 'Complete the human review before sharing the final report.' }
          : { tab: 4, label: 'Download approved report', detail: 'The evidence-backed PDF is ready to circulate.' };

  const downloadReport = async () => {
    setBusy('report');
    setError(null);
    try {
      const report = await api.getIntelligenceReport(record.intelligence_id);
      window.open(report.download_url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be prepared');
    } finally {
      setBusy(null);
    }
  };

  const deleteWorkspace = async () => {
    setBusy('delete');
    setError(null);
    try {
      await api.deleteIntelligenceInterview(record.intelligence_id);
      router.push('/interviews/intelligence');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The workspace could not be deleted');
      setBusy(null);
    }
  };

  const saveDetails = () => runAction('workspace details', () => api.updateIntelligenceDetails(record.intelligence_id, { candidateEmail, organizerEmail }));

  const uploadResume = async (file: File) => {
    setBusy('resume');
    setError(null);
    try {
      const upload = await api.getIntelligenceResumeUploadUrl(record.intelligence_id, {
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
      });
      const response = await fetch(upload.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!response.ok) throw new Error('The resume could not be uploaded. Please try again.');
      setRecord(await api.confirmIntelligenceResume(record.intelligence_id, { s3_key: upload.s3_key, file_name: file.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The resume could not be uploaded.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <BackButton defaultHref="/interviews/intelligence" defaultLabel="Intelligence Interviews" />

      <section className="intelligence-card intelligence-workspace-header flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between md:p-7">
        <div className="min-w-0">
          <p className="page-kicker">Interview workspace</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">{getIntelligenceCandidateName(record)}</h1>
          <p className="mt-2 text-sm text-text-secondary">{record.job.title}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Pill>{record.teams.mode === 'live' ? 'Teams transcript connected' : 'Transcript upload available'}</Pill>
            {record.questionPlan && <Pill muted>Panel guide ready</Pill>}
          </div>
        </div>

        <button type="button" onClick={() => setDeleteOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-xs font-semibold text-danger hover:bg-danger/5">
          <Trash2 size={15} /> Delete workspace
        </button>
      </section>

      {busy && (
        <div className="intelligence-progress-banner" role="status" aria-live="polite">
          <RefreshCw size={16} className="animate-spin text-accent" />
          <span>
            {busy === 'questions' && 'Preparing your interview guide...'}
            {busy === 'case interview' && 'Preparing the optional case interview...'}
            {busy === 'transcript' && 'Saving the Teams transcript...'}
            {busy === 'teams transcript' && 'Syncing the completed Teams transcript...'}
            {busy === 'analysis' && 'Reviewing the interview evidence...'}
            {busy === 'approve' && 'Approving the final report...'}
            {busy === 'report' && 'Preparing the PDF report...'}
            {busy === 'delete' && 'Deleting the workspace...'}
            {busy === 'workspace details' && 'Saving interview details...'}
            {busy === 'resume' && 'Uploading and reading the resume...'}
          </span>
        </div>
      )}

      {error && <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger" role="alert">{error}</div>}

      <section className="intelligence-next-action" aria-label="Recommended next action">
        <div>
          <p className="page-kicker">Recommended next action</p>
          <h2 className="mt-1 text-base font-semibold text-text-primary">{nextAction.label}</h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">{nextAction.detail}</p>
        </div>
        <button type="button" onClick={() => setVisibleStep(nextAction.tab)} className="btn-primary shrink-0 px-4 py-2.5 text-sm font-semibold">
          Open section
        </button>
      </section>

      <WorkspaceTabs activeTab={visibleStep} onSelect={setVisibleStep} />

      <div className="min-w-0">
      <Section visible={visibleStep === 0} icon={Users} title="Interview brief" detail="Review the role and candidate context before preparing the panel guide.">
        <div className="grid gap-4 md:grid-cols-2">
          <Info label="Candidate" value={record.candidate.name} />
          <Info label="Role" value={record.job.title} />
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Candidate email</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">Used to keep the candidate record connected to the interview workspace.</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input type="email" value={candidateEmail} onChange={(event) => setCandidateEmail(event.target.value)} placeholder="candidate@email.com" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none focus:border-accent" />
              <button type="button" onClick={saveDetails} disabled={busy === 'workspace details'} className="btn-secondary shrink-0 px-3 py-2 text-xs font-semibold disabled:opacity-50">Save</button>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-4 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Meeting organiser email</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">Use the Microsoft 365 account that scheduled the meeting. MiMo uses it to find the matching Teams transcript after the call.</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input type="email" value={organizerEmail} onChange={(event) => setOrganizerEmail(event.target.value)} placeholder="organiser@minfytech.com" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none focus:border-accent" />
              <button type="button" onClick={saveDetails} disabled={busy === 'workspace details'} className="btn-secondary shrink-0 px-3 py-2 text-xs font-semibold disabled:opacity-50">Save</button>
            </div>
          </div>
        </div>
        <div className="mt-4 rounded-2xl border border-border bg-surface p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-text-primary">Candidate resume</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">The guide includes an opening question and two or three questions grounded in the candidate&apos;s past experience. These context questions are excluded from panel coverage scoring.</p>
              {record.candidate.resumeS3Key && record.candidate.resumeFileName && <p className="mt-2 text-xs font-semibold text-success">Ready: {record.candidate.resumeFileName}</p>}
              {!record.candidate.resumeS3Key && record.candidate.resumeText && <p className="mt-2 text-xs font-semibold text-success">Imported from the candidate record</p>}
            </div>
            {record.source_mode !== 'keka_live' || !record.candidate.resumeText ? (
              <label className="btn-primary inline-flex cursor-pointer items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold">
                <Upload size={16} />
                {record.candidate.resumeS3Key ? 'Replace resume' : 'Upload resume'}
                <input type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="sr-only" onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadResume(file);
                  event.currentTarget.value = '';
                }} />
              </label>
            ) : null}
          </div>
        </div>
        {record.candidate.resumeS3Key && organizerEmail.trim() && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-text-primary">Setup complete</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">The interview brief is ready. Prepare a structured guide before the conversation is scheduled.</p>
            </div>
            <button type="button" onClick={() => setVisibleStep(1)} className="btn-primary shrink-0 px-4 py-2.5 text-sm font-semibold">Next step</button>
          </div>
        )}
        <details className="mt-4 rounded-xl border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
            <span>Official job description</span>
            <span className="text-xs font-medium text-text-muted">View full description</span>
          </summary>
          <div className="border-t border-border px-4 pb-4 pt-3">
            <p className="text-xs leading-5 text-text-muted">{record.keka.mode === 'live' ? 'Attached from the selected Keka Hire role when this workspace was created.' : 'Attached to this workspace when it was created.'}</p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{formatJobDescription(record.job.description)}</p>
          </div>
        </details>
      </Section>

      <Section visible={visibleStep === 1} icon={ClipboardCheck} title="Interview guide" detail="A structured set of scenario prompts, follow-ups, and evidence signals for the panel.">
        {!record.questionPlan && (record.progress_stage === 'queued' || record.progress_stage === 'generating_questions') ? (
          <LiveProgressBanner
            taskType="questions"
            title="Generating interview guide"
            subtitle="The AI is writing role-specific scenario prompts, follow-ups, and evaluation signals for the panel..."
            startTime={record.analysis_started_at}
            progressMessage={record.progress_message}
            progressStage={record.progress_stage}
            progressEvents={record.progress_events}
          />
        ) : !record.questionPlan ? (
          <QuestionPlanPicker
            intelligenceId={record.intelligence_id}
            busy={busy === 'questions'}
            onGenerate={(choices) => runAction('questions', () => api.generateIntelligenceQuestions(record.intelligence_id, choices))}
          />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Panel guide</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">Questions are selected from the approved bank for this role and grouped by interview purpose.</p>
              </div>
              {!record.transcript && (
                <button
                  type="button"
                  onClick={() => setReplanOpen((open) => !open)}
                  disabled={busy === 'questions' || record.progress_stage === 'queued' || record.progress_stage === 'generating_questions'}
                  className="btn-secondary shrink-0 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  {busy === 'questions' || record.progress_stage === 'queued' || record.progress_stage === 'generating_questions'
                    ? 'Regenerating...'
                    : replanOpen ? 'Cancel' : 'Change topics or count'}
                </button>
              )}
            </div>

            {record.questionPlan.selectedTopics?.length ? (
              <div className="rounded-2xl border border-border bg-surface p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Focus areas for this round</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {record.questionPlan.selectedTopics.map((topic) => (
                    <span key={topic} className="rounded-lg border border-accent/25 bg-accent/10 px-2.5 py-1 text-xs font-medium text-text-primary">
                      {topic}
                    </span>
                  ))}
                </div>
                {record.questionPlan.requestedQuestionCount ? (
                  <p className="mt-3 text-xs text-text-muted">
                    Planned for {record.questionPlan.requestedQuestionCount} role question
                    {record.questionPlan.requestedQuestionCount === 1 ? '' : 's'}. Competencies outside this list were not scheduled for this round.
                  </p>
                ) : null}
              </div>
            ) : null}

            {replanOpen && !record.transcript && (
              <QuestionPlanPicker
                intelligenceId={record.intelligence_id}
                busy={busy === 'questions'}
                submitLabel="Regenerate guide"
                onGenerate={(choices) => {
                  setReplanOpen(false);
                  runAction('questions', () => api.generateIntelligenceQuestions(record.intelligence_id, choices));
                }}
              />
            )}
            <TwoColumn leftTitle="Candidate summary" left={record.questionPlan.candidateSummary} rightTitle="JD summary" right={record.questionPlan.jdSummary} />
            <div className="grid gap-3 md:grid-cols-3">
              {record.questionPlan.skillAreas.map((area) => (
                <div key={area.skill} className="rounded-xl border border-border bg-surface p-4">
                  <p className="text-sm font-semibold text-text-primary">{area.skill}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-accent">{area.priority}</p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">{area.reason}</p>
                </div>
              ))}
            </div>
            {record.questionPlan.panelPlan.map((plan) => {
              const member = record.panel.find((item) => item.interviewerId === plan.interviewerId);
              return (
                <div key={plan.interviewerId} className="rounded-2xl border border-border bg-surface p-5">
                  <p className="text-sm font-semibold text-text-primary">{member?.name || 'Interviewer'} / {plan.focusArea}</p>
                  <div className="mt-4 space-y-4">
                    {plan.questions.map((question, index) => (
                      <div key={`${plan.interviewerId}-${index}`}>
                        {(index === 0 || plan.questions[index - 1]?.questionType !== question.questionType) && (
                          <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                            {question.questionType === 'introduction'
                              ? 'Opening and candidate context'
                              : question.questionType === 'resume'
                                ? 'Resume and experience discussion'
                                : 'Role scenarios and technical depth'}
                          </p>
                        )}
                        <div className="rounded-xl border border-border bg-surface-elevated p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-text-primary">{index + 1}. {question.question}</p>
                          {question.countsTowardPanelEvaluation === false && <span className="rounded-full border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Candidate context</span>}
                        </div>
                        <List title="Follow-ups" items={question.followUps} />
                        <List title="What to evaluate" items={question.whatToEvaluate} />
                        <List title="Strong signals" items={question.expectedStrongAnswerSignals} />
                        <List title="Red flags" items={question.redFlags} danger />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="page-kicker">Next decision</p>
                  <p className="mt-1 text-base font-semibold text-text-primary">Choose how this interview continues</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {record.teams.meetingUrl && (
                    <a
                      href={record.teams.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary hover:border-accent/50 hover:text-accent"
                    >
                      Open Teams meeting <ExternalLink size={12} />
                    </a>
                  )}
                  <span className="w-fit rounded-full border border-border bg-surface-elevated px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                    Case is optional
                  </span>
                </div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setVisibleStep(2)}
                  className="group rounded-xl border border-border bg-surface-elevated p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/50"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                        <BriefcaseBusiness size={18} />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">Prepare case interview</p>
                        <p className="mt-1 text-xs leading-5 text-text-secondary">
                          Generate a role-specific scenario and panel rubric when the interview needs case-style assessment.
                        </p>
                      </div>
                    </div>
                    <ArrowRight size={16} className="mt-1 shrink-0 text-text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setVisibleStep(3)}
                  className="group rounded-xl border border-success/25 bg-success/10 p-4 text-left transition hover:-translate-y-0.5 hover:border-success/50"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-success/15 text-success">
                        <MessageSquareText size={18} />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">Continue to transcript</p>
                        <p className="mt-1 text-xs leading-5 text-text-secondary">
                          Skip the case pack and sync the completed Teams transcript for the final review.
                        </p>
                      </div>
                    </div>
                    <ArrowRight size={16} className="mt-1 shrink-0 text-success transition group-hover:translate-x-0.5" />
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section visible={visibleStep === 2} icon={BriefcaseBusiness} title="Optional case interview" detail="Generate a role-specific case pack only when the panel wants case-style assessment.">
        {!record.caseInterview?.enabled ? (
          <ActionBlock
            title="Add a case interview to this workspace"
            body="MiMo will generate a candidate-facing scenario and a panel-only rubric based on this role, JD, resume context, and seniority. The standard interview workflow stays unchanged if you skip it."
            button="Generate case interview"
            loading={busy === 'case interview'}
            onClick={() => runAction('case interview', () => api.generateIntelligenceCaseInterview(record.intelligence_id))}
          />
        ) : (
          <div className="space-y-5">
            <div className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-text-primary">{record.caseInterview.title || 'Case interview'}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-accent">{record.caseInterview.difficulty || 'practitioner'} case</p>
                  {/* A template case reads exactly like an AI-authored one on the
                      page, so the panel is told which they are running. */}
                  {record.caseInterview.source === 'template' && (
                    <p className="mt-2 inline-block rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
                      Built from the job description — the AI case generation step did not complete. Refresh the case to try again.
                    </p>
                  )}
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{record.caseInterview.format}</p>
                </div>
                {!record.transcript && (
                  <button type="button" onClick={() => runAction('case interview', () => api.generateIntelligenceCaseInterview(record.intelligence_id))} disabled={busy === 'case interview'} className="btn-secondary shrink-0 px-3 py-2 text-xs font-semibold disabled:opacity-50">
                    {busy === 'case interview' ? 'Refreshing...' : 'Refresh case'}
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-5">
              <p className="page-kicker">Candidate case pack</p>
              <p className="mt-2 text-sm leading-6 text-text-secondary">{record.caseInterview.candidatePack?.scenario}</p>
              <List title="Context" items={record.caseInterview.candidatePack?.context || []} />
              <List title="Deliverables" items={record.caseInterview.candidatePack?.deliverables || []} />
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(record.caseInterview.candidatePack?.tasks || []).map((task, index) => (
                  <div key={`${task.title}-${index}`} className="rounded-xl border border-border bg-surface-elevated p-4">
                    <p className="text-sm font-semibold text-text-primary">{index + 1}. {task.title}</p>
                    {task.expectedDurationMinutes && <p className="mt-1 text-xs text-text-muted">{task.expectedDurationMinutes} minutes</p>}
                    <List title="Instructions" items={task.instructions} />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-surface p-5">
              <p className="page-kicker">Panel-only guide</p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(record.caseInterview.interviewerGuide?.competencies || []).map((competency) => (
                  <div key={competency.name} className="rounded-xl border border-border bg-surface-elevated p-4">
                    <p className="text-sm font-semibold text-text-primary">{competency.name}</p>
                    <p className="mt-2 text-xs leading-5 text-text-secondary">{competency.whatGoodLooksLike}</p>
                    <p className="mt-2 text-xs leading-5 text-danger">{competency.weakSignals}</p>
                  </div>
                ))}
              </div>
              <List title="Strong answer markers" items={record.caseInterview.interviewerGuide?.strongAnswerMarkers || []} />
              <List title="Probing questions" items={(record.caseInterview.interviewerGuide?.probingQuestions || []).map((probe) => `${probe.area}: ${probe.question}`)} />
            </div>

            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Use it only if the panel chooses case assessment</p>
                <p className="mt-1 text-sm leading-6 text-text-secondary">If discussed in the interview, MiMo will evaluate it in the final report. If not discussed, it will not be treated as mandatory evidence.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {record.teams.meetingUrl && (
                  <a
                    href={record.teams.meetingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary inline-flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-semibold"
                  >
                    Open Teams meeting <ExternalLink size={14} />
                  </a>
                )}
                <button type="button" onClick={() => setVisibleStep(3)} className="btn-primary shrink-0 px-4 py-2.5 text-sm font-semibold">Continue to transcript</button>
              </div>
            </div>
          </div>
        )}
      </Section>

      <Section visible={visibleStep === 3} icon={MessageSquareText} title="Interview transcript" detail="Bring in the completed interview conversation before the evidence review starts.">
        {!record.transcript && record.teams.transcriptStatus === 'transcribing' ? (
          <ActionBlock
            title="Recording transcription in progress"
            body="The direct Teams transcript was not available, so MiMo is transcribing the meeting recording with AWS Transcribe. This page will update automatically when the transcript is ready."
            button="Checking transcript"
            loading
            onClick={() => undefined}
          />
        ) : !record.transcript && record.teams.mode === 'live' ? (
          <ActionBlock
            title="Sync transcript from Microsoft Teams"
            body="MiMo will first try the Teams transcript. If Microsoft Graph cannot provide it, MiMo will use the meeting recording and create a transcript through AWS Transcribe."
            button={record.teams.transcriptStatus === 'failed' ? 'Retry Teams sync' : 'Sync Teams transcript'}
            loading={busy === 'teams transcript'}
            onClick={() => runAction('teams transcript', () => api.syncTeamsTranscript(record.intelligence_id))}
          />
        ) : !record.transcript ? (
          <>
            <textarea
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
              rows={8}
              placeholder="Paste Teams transcript after the interview..."
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm leading-6 text-text-primary outline-none focus:border-accent"
            />
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy === 'transcript'}
                onClick={() => runAction('transcript', () => api.updateIntelligenceTranscript(record.intelligence_id, { rawText: transcriptText, source: 'manual' }))}
                className="btn-primary px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
              >
                Save transcript
              </button>
            </div>
          </>
        ) : (
          <ActionBlock
            title="Transcript received"
            body="The interview conversation is saved and ready for the AI evidence review."
            button="Open review"
            loading={false}
            onClick={() => setVisibleStep(4)}
          />
        )}
      </Section>

      <Section visible={visibleStep === 4} icon={BrainCircuit} title="AI interview review" detail="Minfy AI evaluates the candidate and panel against the job description, guide, resume, transcript, and optional case evidence.">
        {!record.transcript ? (
          <ActionBlock
            title="Transcript needed"
            body="Add the completed interview transcript before starting the evidence review."
            button="Open transcript"
            loading={false}
            onClick={() => setVisibleStep(3)}
          />
        ) : !record.aiEvaluation ? (
          <LiveProgressBanner
            taskType="analysis"
            title="Preparing AI Interview Review"
            subtitle="Evaluating the candidate transcript, job description requirements, and panel evidence..."
            error={error}
            startTime={record?.analysis_started_at}
            progressMessage={record?.progress_message}
            progressStage={record?.progress_stage}
            progressEvents={record?.progress_events}
            onRetry={() => runAction('analysis', () => api.analyzeIntelligenceInterview(record.intelligence_id))}
          />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="rounded-xl border border-border bg-surface p-5">
                <p className="text-sm font-semibold text-text-primary">Candidate evaluation</p>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{record.aiEvaluation.candidateEvaluation.summary}</p>
                <p className="mt-3 text-sm font-semibold text-accent">Recommendation: {record.aiEvaluation.candidateEvaluation.recommendation.replace(/_/g, ' ')}</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">{record.aiEvaluation.candidateEvaluation.recommendationReason}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                <HeroNumber
                  value={record.aiEvaluation.candidateEvaluation.skillScores.length}
                  label="Skills scored"
                />
                <HeroNumber
                  value={record.aiEvaluation.interviewerEvaluations.length}
                  label="Panel reviewed"
                  tone="success"
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <AnalysisList title="Strengths" items={record.aiEvaluation.candidateEvaluation.strengths} />
              <AnalysisList title="Concerns" items={record.aiEvaluation.candidateEvaluation.concerns} />
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Evidence by job requirement</p>
              <div className="grid gap-3">
                {record.aiEvaluation.coverageMatrix.map((entry) => (
                  <EvidenceCard
                    key={entry.jdSkill}
                    title={`${entry.jdSkill} - ${entry.covered.toUpperCase()}`}
                    excerpt={entry.evidence}
                    source={entry.askedBy?.length ? `Asked by: ${entry.askedBy.join(', ')}` : undefined}
                    tone={entry.covered === 'yes' ? 'success' : entry.covered === 'partial' ? 'warning' : 'danger'}
                  />
                ))}
              </div>
            </div>
            {record.aiEvaluation.panelCalibration && (
              <div className="rounded-xl border border-warning/30 bg-warning/5 p-4">
                <p className="text-sm font-semibold text-text-primary">Panel calibration</p>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{record.aiEvaluation.panelCalibration.summary}</p>
                {record.aiEvaluation.panelCalibration.outliers.length > 0 && (
                  <List title="Outliers" items={record.aiEvaluation.panelCalibration.outliers.map((item) => `${item.name}: ${item.score}/10 / ${item.reason}`)} danger />
                )}
              </div>
            )}
            {record.aiEvaluation.caseEvaluation && (
              <div className="rounded-xl border border-accent/25 bg-accent/5 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-semibold text-text-primary">Case interview evaluation</p>
                  <p className="text-xs font-semibold uppercase tracking-wide text-accent">{record.aiEvaluation.caseEvaluation.overallScore}/10 case score</p>
                </div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{record.aiEvaluation.caseEvaluation.summary}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {record.aiEvaluation.caseEvaluation.competencyScores.map((item) => (
                    <div key={item.competency} className="rounded-lg border border-border bg-surface p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{item.competency} / {item.score}/10</p>
                      <p className="mt-2 text-xs leading-5 text-text-secondary">{item.evidence}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section visible={visibleStep === 4 && !!record.aiEvaluation} icon={FileText} title="Final decision" detail="Review the AI recommendation, approve it, and download the formatted report.">
        {record.aiEvaluation ? (
          <div className="space-y-4">
            <div className="card overflow-hidden">
              <div className="border-b border-border px-5 py-4">
                <p className="page-kicker">Decision summary</p>
                <h3 className="mt-1 text-base font-semibold text-text-primary">Review before approval</h3>
              </div>
              <div className="p-5">
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary">{record.aiEvaluation.finalReport}</p>
              </div>
            </div>
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">Shareable interview report</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">Download the formatted PDF when the hiring review is ready to circulate.</p>
              </div>
              <button type="button" onClick={downloadReport} disabled={busy === 'report'} className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                {busy === 'report' ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                {busy === 'report' ? 'Preparing PDF...' : 'Download PDF'}
              </button>
            </div>
            <div className="rounded-xl border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-text-secondary">
              AI-assisted recommendation. Final hiring decision requires human review.
            </div>
            {record.status === 'approved' ? (
              <div className="inline-flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-4 py-2 text-sm font-semibold text-success">
                <CheckCircle2 size={16} />
                Approved
              </div>
            ) : (
              <div className="space-y-3">
                <textarea
                  value={approvalNotes}
                  onChange={(event) => setApprovalNotes(event.target.value)}
                  rows={3}
                  placeholder="Optional approval notes"
                  className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={() => runAction('approve', () => api.approveIntelligenceInterview(record.intelligence_id, approvalNotes))}
                  disabled={busy === 'approve'}
                  className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  <ShieldCheck size={16} />
                  Approve final report
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-text-muted">Run AI analysis to generate the final report.</p>
        )}
      </Section>
      </div>
      <ConfirmDialog
        isOpen={deleteOpen}
        title="Delete this interview workspace?"
        description="This permanently removes the Intelligence workspace and its generated report. It does not affect other interview evaluations."
        confirmLabel="Delete workspace"
        onCancel={() => setDeleteOpen(false)}
        onConfirm={deleteWorkspace}
      />
    </div>
  );
}

function Section({ visible, icon: Icon, title, detail, children }: { visible?: boolean; icon: LucideIcon; title: string; detail?: string; children: React.ReactNode }) {
  if (visible === false) return null;
  return (
    <section className="intelligence-stage overflow-hidden">
      <div className="flex items-center gap-4 p-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Icon size={18} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            {detail && <p className="mt-1 text-xs leading-5 text-text-muted">{detail}</p>}
          </div>
        </div>
      </div>
      <div className="border-t border-border px-5 pb-5 pt-5">{children}</div>
    </section>
  );
}

function InterviewIntelligenceRail({ record, activeStep }: { record: InterviewIntelligenceRecord; activeStep: number }) {
  return (
    <aside className="intelligence-rail lg:sticky lg:top-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="page-kicker">Workflow</p>
          <p className="mt-1 text-sm font-semibold text-text-primary">From data to decision</p>
        </div>
        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">{activeStep + 1}/{steps.length}</span>
      </div>
      <nav className="mt-4 space-y-1" aria-label="Interview intelligence workflow">
        {steps.map((step, index) => {
          const complete = index < activeStep || (index === steps.length - 1 && record.status === 'approved');
          const current = index === activeStep;
          return (
            <a
              key={step.anchor}
              href={`#${step.anchor}`}
              aria-current={current ? 'step' : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors ${current ? 'bg-accent/10 text-text-primary' : 'text-text-muted hover:bg-surface hover:text-text-primary'}`}
            >
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${complete ? 'bg-success text-white' : current ? 'bg-accent text-accent-foreground' : 'bg-surface text-text-muted'}`}>
                {complete ? '✓' : String(index + 1).padStart(2, '0')}
              </span>
              <span className="text-xs font-semibold">{step.label}</span>
            </a>
          );
        })}
      </nav>
      <p className="mt-4 border-t border-border pt-4 text-xs leading-5 text-text-muted">
        Each stage keeps the interview context together so reviewers can move forward without losing the evidence behind the recommendation.
      </p>
    </aside>
  );
}

function WorkflowTabs({ activeStep, visibleStep, onSelect }: { activeStep: number; visibleStep: number; onSelect: (step: number) => void }) {
  return (
    <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5" aria-label="Interview intelligence workflow">
      {steps.map((step, index) => {
        const complete = index < activeStep;
        const current = index === visibleStep;
        return (
          <button
            type="button"
            key={step.label}
            onClick={() => onSelect(index)}
            aria-current={current ? 'step' : undefined}
            className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-3 text-left transition-colors ${current ? 'border-accent/40 bg-accent/10 text-text-primary' : 'border-border bg-surface-elevated text-text-muted hover:border-accent/30 hover:text-text-primary'}`}
          >
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${complete ? 'bg-success text-white' : current ? 'bg-accent text-accent-foreground' : 'bg-surface text-text-muted'}`}>
              {complete ? '✓' : String(index + 1).padStart(2, '0')}
            </span>
            <span className="min-w-0 text-xs font-semibold leading-4">{step.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function WorkspaceTabs({ activeTab, onSelect }: { activeTab: number; onSelect: (tab: number) => void }) {
  return (
    <nav className="card flex gap-1 overflow-x-auto p-2" aria-label="Interview workspace sections" role="tablist">
      {workspaceTabs.map((label, index) => (
        <button
          type="button"
          key={label}
          onClick={() => onSelect(index)}
          role="tab"
          aria-selected={activeTab === index}
          className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${activeTab === index ? 'bg-accent text-accent-foreground' : 'text-text-muted hover:bg-surface hover:text-text-primary'}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function formatJobDescription(description: string) {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function IntelligenceViewSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10" aria-busy="true" aria-live="polite">
      <div className="h-5 w-56 animate-pulse rounded bg-surface" />
      <div className="intelligence-hero grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)]">
        <div className="space-y-4">
          <div className="h-3 w-40 animate-pulse rounded bg-surface" />
          <div className="h-10 w-2/3 animate-pulse rounded bg-surface" />
          <div className="h-4 w-40 animate-pulse rounded bg-surface" />
          <div className="flex gap-2"><div className="h-7 w-24 animate-pulse rounded-full bg-surface" /><div className="h-7 w-24 animate-pulse rounded-full bg-surface" /></div>
        </div>
        <div className="space-y-3 rounded-2xl bg-surface p-4"><div className="h-3 w-28 animate-pulse rounded bg-surface-elevated" />{[1, 2, 3, 4].map((item) => <div key={item} className="h-9 animate-pulse rounded-xl bg-surface-elevated" />)}</div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">{[1, 2, 3].map((item) => <div key={item} className="intelligence-metric h-28 animate-pulse" />)}</div>
      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]"><div className="intelligence-rail h-64 animate-pulse" /><div className="space-y-4">{[1, 2, 3].map((item) => <div key={item} className="intelligence-stage h-24 animate-pulse" />)}</div></div>
    </div>
  );
}

function Pill({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${muted ? 'border-border bg-surface text-text-muted' : 'border-accent/20 bg-accent/10 text-accent'}`}>{children}</span>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-2 text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function ActionBlock({ title, body, button, loading, onClick }: { title: string; body: string; button: string; loading: boolean; onClick: () => void }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      <p className="mt-2 text-sm leading-6 text-text-secondary">{body}</p>
      <button type="button" onClick={onClick} disabled={loading} className="btn-primary mt-4 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
        {loading ? <RefreshCw size={15} className="animate-spin" /> : null}
        {loading ? 'Working...' : button}
      </button>
    </div>
  );
}

function TwoColumn({ leftTitle, left, rightTitle, right }: { leftTitle: string; left: string; rightTitle: string; right: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{leftTitle}</p>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{left}</p>
      </div>
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{rightTitle}</p>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{right}</p>
      </div>
    </div>
  );
}

function List({ title, items, danger = false }: { title: string; items: string[]; danger?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <p className={`text-xs font-semibold uppercase tracking-wide ${danger ? 'text-danger' : 'text-text-muted'}`}>{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 text-text-secondary">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function AnalysisList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-text-secondary">
        {items.length ? items.map((item) => <li key={item}>{item}</li>) : <li>No items recorded.</li>}
      </ul>
    </div>
  );
}
