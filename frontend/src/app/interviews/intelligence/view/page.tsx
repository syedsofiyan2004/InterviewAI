'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { api, InterviewIntelligenceRecord } from '@/lib/api';
import { ArrowLeft, BrainCircuit, CheckCircle2, ClipboardCheck, FileText, MessageSquareText, RefreshCw, ShieldCheck, Users } from 'lucide-react';

const steps = [
  'Interview Data',
  'Pre-Interview Questions',
  'Transcript',
  'Human Scores',
  'AI Analysis',
  'Final Report',
];

export default function InterviewIntelligenceViewPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') || '';
  const [record, setRecord] = useState<InterviewIntelligenceRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [scores, setScores] = useState<Record<string, { score: string; feedback: string; opinion: 'proceed' | 'hold' | 'reject' | 'needs_review' }>>({});
  const [approvalNotes, setApprovalNotes] = useState('');

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
    let mounted = true;
    async function load() {
      if (!id) return;
      try {
        const data = await api.getIntelligenceInterview(id);
        if (!mounted) return;
        setRecord(data);
        setTranscriptText(data.transcript?.rawText || '');
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
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-sm text-text-muted">Loading interview intelligence record...</div>;
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

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-10">
      <Link href="/interviews/intelligence" className="inline-flex items-center gap-2 pt-2 text-sm font-semibold text-text-secondary hover:text-accent">
        <ArrowLeft size={16} />
        Back to intelligence interviews
      </Link>

      <div className="rounded-2xl border border-border bg-surface-elevated p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Interview Intelligence Mode</p>
            <h1 className="text-xl font-semibold text-text-primary">{record.candidate.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">{record.job.title}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill>Keka: {record.keka.mode}</Pill>
            <Pill>Teams: {record.teams.mode}</Pill>
            <Pill muted>{record.status.replace(/_/g, ' ')}</Pill>
          </div>
        </div>

        <div className="mt-6 grid gap-2 md:grid-cols-6">
          {steps.map((step, index) => (
            <div key={step} className={`rounded-xl border px-3 py-3 ${index <= activeStep ? 'border-accent/30 bg-accent/5' : 'border-border bg-surface'}`}>
              <p className="font-mono text-[10px] font-semibold text-accent">0{index + 1}</p>
              <p className="mt-1 text-xs font-semibold text-text-primary">{step}</p>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}

      <Section icon={Users} title="1. Interview Data">
        <div className="grid gap-4 md:grid-cols-2">
          <Info label="Candidate" value={record.candidate.name} />
          <Info label="Email" value={record.candidate.email || 'Not provided'} />
          <Info label="Role" value={record.job.title} />
          <Info label="Teams link" value={record.teams.meetingUrl || 'Not provided'} />
        </div>
        <div className="mt-4 rounded-xl border border-border bg-surface p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">JD summary source</p>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{record.job.description}</p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {record.panel.map((member) => (
            <div key={member.interviewerId} className="rounded-xl border border-border bg-surface p-4">
              <p className="text-sm font-semibold text-text-primary">{member.name}</p>
              <p className="mt-1 text-xs text-text-muted">{member.role || 'Panel member'} · {member.focusArea || 'Focus assigned by AI'}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={ClipboardCheck} title="2. Pre-Interview Questions">
        {!record.questionPlan ? (
          <ActionBlock
            title="Questions must be generated before the interview"
            body="The system will read the JD, resume, candidate context, and dynamic panel. For one interviewer it creates a full guide; for multiple interviewers it divides focus areas."
            button="Generate questions"
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
                  <p className="text-sm font-semibold text-text-primary">{member?.name || 'Interviewer'} · {plan.focusArea}</p>
                  <div className="mt-4 space-y-4">
                    {plan.questions.map((question, index) => (
                      <div key={`${plan.interviewerId}-${index}`} className="rounded-xl border border-border bg-surface-elevated p-4">
                        <p className="text-sm font-semibold text-text-primary">{index + 1}. {question.question}</p>
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
          </div>
        )}
      </Section>

      <Section icon={MessageSquareText} title="3. Transcript">
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
            Load mock Teams transcript
          </button>
        </div>
      </Section>

      <Section icon={Users} title="4. Human Scores">
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

      <Section icon={BrainCircuit} title="5. AI Analysis">
        {!record.aiEvaluation ? (
          <ActionBlock
            title="Run post-interview analysis"
            body="Analysis uses JD, resume, generated questions, transcript, and human panel scores. It does not replace human hiring judgment."
            button="Analyze interview"
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
                  <List title="Outliers" items={record.aiEvaluation.panelCalibration.outliers.map((item) => `${item.name}: ${item.score}/10 · ${item.reason}`)} danger />
                )}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section icon={FileText} title="6. Final Report">
        {record.aiEvaluation ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-surface p-4">
              <pre className="whitespace-pre-wrap text-sm leading-6 text-text-secondary">{record.aiEvaluation.finalReport}</pre>
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
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof BrainCircuit; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface-elevated p-5">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={17} className="text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Pill({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${muted ? 'border-border bg-surface text-text-muted' : 'border-accent/20 bg-accent/10 text-accent'}`}>{children}</span>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-2 text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function ActionBlock({ title, body, button, loading, onClick }: { title: string; body: string; button: string; loading: boolean; onClick: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
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
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-sm font-semibold text-text-primary">{title}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-text-secondary">
        {items.length ? items.map((item) => <li key={item}>{item}</li>) : <li>No items recorded.</li>}
      </ul>
    </div>
  );
}
