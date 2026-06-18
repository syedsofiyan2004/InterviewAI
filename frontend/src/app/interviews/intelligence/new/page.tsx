'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ArrowLeft, Plus, Trash2, Wand2 } from 'lucide-react';

type PanelMember = {
  name: string;
  email: string;
  role: string;
  focusArea: string;
};

export default function NewInterviewIntelligencePage() {
  const router = useRouter();
  const [mode, setMode] = useState<'manual' | 'mock_keka'>('manual');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState({
    title: '',
    seniority: '',
    description: '',
    requiredSkills: '',
    preferredSkills: '',
  });
  const [candidate, setCandidate] = useState({
    name: '',
    email: '',
    resumeText: '',
    experienceSummary: '',
  });
  const [meetingUrl, setMeetingUrl] = useState('');
  const [panel, setPanel] = useState<PanelMember[]>([
    { name: '', email: '', role: '', focusArea: '' },
  ]);

  const updatePanel = (index: number, key: keyof PanelMember, value: string) => {
    setPanel((current) => current.map((member, i) => i === index ? { ...member, [key]: value } : member));
  };

  const addPanelist = () => {
    setPanel((current) => [...current, { name: '', email: '', role: '', focusArea: '' }]);
  };

  const removePanelist = (index: number) => {
    setPanel((current) => current.length === 1 ? current : current.filter((_, i) => i !== index));
  };

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const payload = mode === 'mock_keka'
        ? { source_mode: 'mock_keka' as const }
        : {
            source_mode: 'manual' as const,
            job: {
              ...job,
              requiredSkills: job.requiredSkills,
              preferredSkills: job.preferredSkills,
            },
            candidate,
            meetingUrl,
            panel: panel
              .filter((member) => member.name.trim())
              .map((member, index) => ({
                interviewerId: `panel-${index + 1}`,
                ...member,
              })),
          };
      const created = await api.createIntelligenceInterview(payload);
      router.push(`/interviews/intelligence/view?id=${created.intelligence_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create intelligence interview');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-10">
      <Link href="/interviews/intelligence" className="inline-flex items-center gap-2 pt-2 text-sm font-semibold text-text-secondary hover:text-accent">
        <ArrowLeft size={16} />
        Back to intelligence interviews
      </Link>

      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Create intelligence interview</p>
        <h1 className="text-xl font-semibold text-text-primary">Prepare before the interview</h1>
        <p className="mt-1 text-sm leading-6 text-text-secondary">
          Add JD, resume, panel, and Teams meeting details now. Questions are generated before the interview; evaluation happens only after transcript and scores are added.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <button
          type="button"
          onClick={() => setMode('manual')}
          className={`rounded-2xl border p-5 text-left ${mode === 'manual' ? 'border-accent bg-accent/5' : 'border-border bg-surface-elevated'}`}
        >
          <p className="text-sm font-semibold text-text-primary">Manual mode</p>
          <p className="mt-1 text-xs leading-5 text-text-muted">Paste JD, resume, candidate, panel, and optional Teams link manually.</p>
        </button>
        <button
          type="button"
          onClick={() => setMode('mock_keka')}
          className={`rounded-2xl border p-5 text-left ${mode === 'mock_keka' ? 'border-accent bg-accent/5' : 'border-border bg-surface-elevated'}`}
        >
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary"><Wand2 size={16} /> Mock Keka mode</p>
          <p className="mt-1 text-xs leading-5 text-text-muted">Create a complete sample record using mock Keka interview, JD, resume, panel, and Teams link.</p>
        </button>
      </div>

      {mode === 'manual' && (
        <div className="space-y-6">
          <Section title="Job details">
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Job title" value={job.title} onChange={(value) => setJob({ ...job, title: value })} placeholder="Senior AWS Platform Engineer" />
              <Input label="Seniority" value={job.seniority} onChange={(value) => setJob({ ...job, seniority: value })} placeholder="Senior" />
            </div>
            <Textarea label="Job description" value={job.description} onChange={(value) => setJob({ ...job, description: value })} placeholder="Paste the JD here..." />
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Required skills" value={job.requiredSkills} onChange={(value) => setJob({ ...job, requiredSkills: value })} placeholder="AWS, Terraform, IAM" />
              <Input label="Preferred skills" value={job.preferredSkills} onChange={(value) => setJob({ ...job, preferredSkills: value })} placeholder="Kubernetes, Python" />
            </div>
          </Section>

          <Section title="Candidate">
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Candidate name" value={candidate.name} onChange={(value) => setCandidate({ ...candidate, name: value })} placeholder="Candidate name" />
              <Input label="Candidate email" value={candidate.email} onChange={(value) => setCandidate({ ...candidate, email: value })} placeholder="candidate@company.com" />
            </div>
            <Textarea label="Resume text" value={candidate.resumeText} onChange={(value) => setCandidate({ ...candidate, resumeText: value })} placeholder="Paste resume text here..." />
            <Textarea label="Experience summary" value={candidate.experienceSummary} onChange={(value) => setCandidate({ ...candidate, experienceSummary: value })} placeholder="Optional short summary..." />
          </Section>

          <Section title="Interview panel">
            <div className="space-y-4">
              {panel.map((member, index) => (
                <div key={index} className="rounded-xl border border-border bg-surface p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-text-primary">Interviewer {index + 1}</p>
                    <button type="button" onClick={() => removePanelist(index)} className="text-text-muted hover:text-danger" disabled={panel.length === 1}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input label="Name" value={member.name} onChange={(value) => updatePanel(index, 'name', value)} placeholder="Interviewer name" />
                    <Input label="Email" value={member.email} onChange={(value) => updatePanel(index, 'email', value)} placeholder="interviewer@company.com" />
                    <Input label="Role" value={member.role} onChange={(value) => updatePanel(index, 'role', value)} placeholder="Cloud Architect" />
                    <Input label="Focus area" value={member.focusArea} onChange={(value) => updatePanel(index, 'focusArea', value)} placeholder="AWS architecture" />
                  </div>
                </div>
              ))}
              <button type="button" onClick={addPanelist} className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-text-primary">
                <Plus size={15} />
                Add interviewer
              </button>
            </div>
          </Section>

          <Section title="Teams meeting">
            <Input label="Teams meeting URL optional" value={meetingUrl} onChange={setMeetingUrl} placeholder="https://teams.microsoft.com/..." />
          </Section>
        </div>
      )}

      {error && <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}

      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={loading} className="btn-primary inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold disabled:opacity-50">
          {loading ? 'Creating...' : mode === 'mock_keka' ? 'Create from mock Keka data' : 'Create intelligence interview'}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface-elevated p-5">
      <h2 className="mb-4 text-sm font-semibold text-text-primary">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Input({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
    </label>
  );
}

function Textarea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={5} className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm leading-6 text-text-primary outline-none focus:border-accent" />
    </label>
  );
}
