'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, InterviewIntelligenceRecord } from '@/lib/api';
import { ArrowLeft, BrainCircuit, CheckCircle2, ClipboardCheck, Download, FileText, MessageSquareText, RefreshCw, ShieldCheck, Trash2, Upload, Users, type LucideIcon } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// Retained for the lightweight loading placeholder and legacy navigation helpers.
const steps = [
  { label: 'Interview data', anchor: 'stage-data' },
  { label: 'Panel guide', anchor: 'stage-questions' },
  { label: 'Transcript', anchor: 'stage-transcript' },
  { label: 'Panel scores', anchor: 'stage-scores' },
  { label: 'Analysis', anchor: 'stage-analysis' },
  { label: 'Report approval', anchor: 'stage-report' },
];
const workspaceTabs = ['Overview', 'Interview guide', 'Interview evidence', 'Decision'];

export default function InterviewIntelligenceViewPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get('id') || '';
  const [record, setRecord] = useState<InterviewIntelligenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [scores, setScores] = useState<Record<string, { score: string; feedback: string; opinion: 'proceed' | 'hold' | 'reject' | 'needs_review' }>>({});
  const [approvalNotes, setApprovalNotes] = useState('');
  const [visibleStep, setVisibleStep] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [candidateEmail, setCandidateEmail] = useState('');
  const [organizerEmail, setOrganizerEmail] = useState('');

  const activeStep = useMemo(() => {
    if (!record) return 0;
    if (record.status === 'approved') return 5;
    if (record.aiEvaluation) return 4;
    if (record.status === 'scores_submitted') return 3;
    if (record.transcript) return 2;
    if (record.questionPlan) return 1;
    return 0;
  }, [record]);

  useEffect(() => {
    if (!record?.candidate.resumeS3Key) {
      setVisibleStep(0);
      return;
    }
    if (activeStep <= 0) {
      setVisibleStep(0);
      return;
    }
    if (activeStep === 1) {
      const transcriptView = typeof window !== 'undefined' && window.sessionStorage.getItem(`intelligence-transcript-${id}`) === 'open';
      setVisibleStep(transcriptView ? 2 : 1);
      return;
    }
    setVisibleStep(activeStep <= 3 ? 2 : 3);
  }, [activeStep, id, record?.candidate.resumeS3Key]);

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
        setScores(Object.fromEntries(data.panel.map((member) => [
          member.interviewerId,
          {
            score: member.score === undefined ? '' : String(member.score),
            feedback: member.feedback || '',
            opinion: member.opinion || 'needs_review',
          },
        ])));
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
      if (label === 'mock transcript') setTranscriptText(updated.transcript?.rawText || '');
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

  const saveScores = () => runAction('scores', () => api.updateIntelligenceScores(record.intelligence_id, record.panel.map((member) => ({
    interviewerId: member.interviewerId,
    score: scores[member.interviewerId]?.score ? Number(scores[member.interviewerId].score) : undefined,
    feedback: scores[member.interviewerId]?.feedback || '',
    opinion: scores[member.interviewerId]?.opinion || 'needs_review',
  }))));

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
      <Link href="/interviews/intelligence" className="inline-flex items-center gap-2 pt-2 text-sm font-semibold text-text-secondary hover:text-accent">
        <ArrowLeft size={16} />
        Back to intelligence interviews
      </Link>

      <section className="intelligence-card flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between md:p-6">
        <div className="min-w-0">
          <p className="page-kicker">Interview Intelligence Mode</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary md:text-3xl">{record.candidate.name}</h1>
          <p className="mt-2 text-sm text-text-secondary">{record.job.title}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Pill>Interview workspace</Pill>
            <Pill muted>{record.teams.mode === 'live' ? 'Transcript connection ready' : 'Transcript capture ready'}</Pill>
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
            {busy === 'questions' && 'Preparing the panel guide...'}
            {busy === 'transcript' && 'Saving the Teams transcript...'}
            {busy === 'mock transcript' && 'Loading the demo transcript...'}
            {busy === 'teams transcript' && 'Syncing the completed Teams transcript...'}
            {busy === 'scores' && 'Saving panel scores...'}
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

      <div className="min-w-0">
      <Section visible={visibleStep === 0} icon={Users} title="Interview setup" detail="Confirm the meeting organiser and add the candidate resume before preparing the guide.">
        <div className="grid gap-4 md:grid-cols-2">
          <Info label="Candidate" value={record.candidate.name} />
          <Info label="Role" value={record.job.title} />
          <div className="rounded-2xl border border-border bg-surface p-4 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Meeting organiser email</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">Use the Microsoft 365 organiser whose account is included in the Teams Application Access Policy. This is the identity Minfy AI uses to locate the meeting and transcript.</p>
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
              <p className="mt-1 text-sm leading-6 text-text-secondary">The guide includes an opening question and two or three questions grounded in the candidate’s past experience. These context questions are excluded from panel coverage scoring.</p>
              {record.candidate.resumeFileName && <p className="mt-2 text-xs font-semibold text-success">Ready: {record.candidate.resumeFileName}</p>}
            </div>
            <label className="btn-primary inline-flex cursor-pointer items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold">
              <Upload size={16} />
              {record.candidate.resumeS3Key ? 'Replace resume' : 'Upload resume'}
              <input type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" className="sr-only" onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadResume(file);
                event.currentTarget.value = '';
              }} />
            </label>
          </div>
        </div>
        {record.candidate.resumeS3Key && organizerEmail.trim() && (
          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-text-primary">Setup complete</p>
              <p className="mt-1 text-sm leading-6 text-text-secondary">The interview context is ready. Prepare the panel guide when you are ready to schedule the conversation.</p>
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
            <p className="text-xs leading-5 text-text-muted">Sourced directly from the current Minfy Careers role page when this workspace was created.</p>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{record.job.description}</p>
          </div>
        </details>
      </Section>

      <Section visible={visibleStep === 1} icon={ClipboardCheck} title="Interview guide" detail="Questions, follow-ups, and evidence signals for the panel.">
        {!record.questionPlan ? (
          <ActionBlock
            title="Prepare the panel guide"
            body="Create the question plan before the interview. Each interviewer receives a focused guide with follow-ups and evaluation signals."
            button="Prepare guide"
            loading={busy === 'questions'}
            onClick={() => runAction('questions', () => api.generateIntelligenceQuestions(record.intelligence_id))}
          />
        ) : (
          <div className="space-y-5">
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
                      <div key={`${plan.interviewerId}-${index}`} className="rounded-xl border border-border bg-surface-elevated p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-text-primary">{index + 1}. {question.question}</p>
                          {question.countsTowardPanelEvaluation === false && <span className="rounded-full border border-border bg-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">Context question</span>}
                        </div>
                        <List title="Follow-ups" items={question.followUps} />
                        <List title="What to evaluate" items={question.whatToEvaluate} />
                        <List title="Strong signals" items={question.expectedStrongAnswerSignals} />
                        <List title="Red flags" items={question.redFlags} danger />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-text-primary">After the interview</p>
                <p className="mt-1 text-sm leading-6 text-text-secondary">When the call is complete and Teams has finished transcription, continue here to retrieve it.</p>
              </div>
              <button type="button" onClick={() => { window.sessionStorage.setItem(`intelligence-transcript-${id}`, 'open'); setVisibleStep(2); }} className="btn-secondary shrink-0 px-4 py-2.5 text-sm font-semibold">Next step</button>
            </div>
          </div>
        )}
      </Section>

      <Section visible={visibleStep === 2 && !record.transcript} icon={MessageSquareText} title="Teams transcript" detail="Retrieve the transcript only after the meeting has ended and Teams has finished processing it.">
        {record.teams.mode === 'live' ? (
          <ActionBlock
            title="Sync transcript from Microsoft Teams"
            body="Minfy AI will retrieve the transcript from the scheduled Teams meeting. If it is not ready yet, wait for Teams transcription to finish and try again."
            button={record.teams.transcriptStatus === 'failed' ? 'Retry Teams sync' : 'Sync Teams transcript'}
            loading={busy === 'teams transcript'}
            onClick={() => runAction('teams transcript', () => api.syncTeamsTranscript(record.intelligence_id))}
          />
        ) : (
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
              <button
                type="button"
                disabled={busy === 'mock transcript'}
                onClick={() => runAction('mock transcript', () => api.updateIntelligenceTranscript(record.intelligence_id, { useMockTeams: true, source: 'mock_teams' }))}
                className="rounded-lg border border-border bg-surface-elevated px-4 py-2.5 text-sm font-semibold text-text-primary disabled:opacity-50"
              >
                Load demo transcript
              </button>
            </div>
          </>
        )}
      </Section>

      <Section visible={visibleStep === 2 && !!record.transcript && record.status !== 'scores_submitted'} icon={Users} title="Panel feedback" detail="Record each interviewer's score and reasoning after the transcript is available.">
        <div className="space-y-4">
          {record.panel.map((member) => (
            <div key={member.interviewerId} className="rounded-xl border border-border bg-surface p-4">
              <p className="text-sm font-semibold text-text-primary">{member.name}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-[140px_180px_1fr]">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={scores[member.interviewerId]?.score || ''}
                  onChange={(event) => setScores({ ...scores, [member.interviewerId]: { ...(scores[member.interviewerId] || { feedback: '', opinion: 'needs_review' }), score: event.target.value } })}
                  placeholder="Score / 10"
                  className="rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                />
                <select
                  value={scores[member.interviewerId]?.opinion || 'needs_review'}
                  onChange={(event) => setScores({ ...scores, [member.interviewerId]: { ...(scores[member.interviewerId] || { score: '', feedback: '' }), opinion: event.target.value as 'proceed' | 'hold' | 'reject' | 'needs_review' } })}
                  className="rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                >
                  <option value="proceed">Proceed</option>
                  <option value="hold">Hold</option>
                  <option value="reject">Reject</option>
                  <option value="needs_review">Needs review</option>
                </select>
                <input
                  value={scores[member.interviewerId]?.feedback || ''}
                  onChange={(event) => setScores({ ...scores, [member.interviewerId]: { ...(scores[member.interviewerId] || { score: '', opinion: 'needs_review' }), feedback: event.target.value } })}
                  placeholder="Feedback or justification"
                  className="rounded-xl border border-border bg-surface-elevated px-4 py-3 text-sm text-text-primary outline-none focus:border-accent"
                />
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={saveScores} disabled={busy === 'scores'} className="btn-primary mt-4 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
          Save human scores
        </button>
      </Section>

      <Section visible={visibleStep === 3 && !record.aiEvaluation} icon={BrainCircuit} title="Evidence review" detail="Compare the JD, interview evidence, and panel feedback before making a decision.">
        {!record.aiEvaluation ? (
          <ActionBlock
            title="Run the evidence review"
            body="Analysis uses JD, resume, generated questions, transcript, and human panel scores. It does not replace human hiring judgment."
            button="Review interview"
            loading={busy === 'analysis'}
            onClick={() => runAction('analysis', () => api.analyzeIntelligenceInterview(record.intelligence_id))}
          />
        ) : (
          <div className="space-y-5">
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-sm font-semibold text-text-primary">Candidate evaluation</p>
              <p className="mt-2 text-sm leading-6 text-text-secondary">{record.aiEvaluation.candidateEvaluation.summary}</p>
              <p className="mt-3 text-sm font-semibold text-accent">Recommendation: {record.aiEvaluation.candidateEvaluation.recommendation.replace('_', ' ')}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{record.aiEvaluation.candidateEvaluation.recommendationReason}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <AnalysisList title="Strengths" items={record.aiEvaluation.candidateEvaluation.strengths} />
              <AnalysisList title="Concerns" items={record.aiEvaluation.candidateEvaluation.concerns} />
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-left">
                <thead className="bg-surface">
                  <tr>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">JD Skill</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Covered</th>
                    <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {record.aiEvaluation.coverageMatrix.map((entry) => (
                    <tr key={entry.jdSkill} className="border-t border-border">
                      <td className="px-4 py-3 text-sm font-semibold text-text-primary">{entry.jdSkill}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{entry.covered}</td>
                      <td className="px-4 py-3 text-sm text-text-secondary">{entry.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          </div>
        )}
      </Section>

      <Section visible={visibleStep === 3 && !!record.aiEvaluation} icon={FileText} title="Final decision" detail="Review the recommendation, approve it, and download the report.">
        {record.aiEvaluation ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-surface p-4">
              <pre className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{record.aiEvaluation.finalReport}</pre>
            </div>
            <button type="button" onClick={downloadReport} disabled={busy === 'report'} className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
              {busy === 'report' ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
              Download formatted PDF
            </button>
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
        <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">{activeStep + 1}/6</span>
      </div>
      <nav className="mt-4 space-y-1" aria-label="Interview intelligence workflow">
        {steps.map((step, index) => {
          const complete = index < activeStep || (index === 5 && record.status === 'approved');
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
    <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6" aria-label="Interview intelligence workflow">
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
    <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label="Interview workspace sections">
      {workspaceTabs.map((label, index) => (
        <button
          type="button"
          key={label}
          onClick={() => onSelect(index)}
          className={`shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition-colors ${activeTab === index ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'}`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
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
