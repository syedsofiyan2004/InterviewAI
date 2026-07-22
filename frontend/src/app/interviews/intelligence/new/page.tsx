'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, IntegrationStatus, MinfyCareerJob } from '@/lib/api';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Link2,
  RefreshCw,
  ShieldCheck,
  Video,
} from 'lucide-react';

export default function NewInterviewIntelligencePage() {
  const router = useRouter();
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTeamsPilot, setShowTeamsPilot] = useState(false);
  const [careerJobs, setCareerJobs] = useState<MinfyCareerJob[]>([]);
  const [careerLoading, setCareerLoading] = useState(false);
  const [careerError, setCareerError] = useState<string | null>(null);
  const [selectedCareerDepartment, setSelectedCareerDepartment] = useState('');
  const [selectedCareerJobId, setSelectedCareerJobId] = useState('');
  const [teamsPilot, setTeamsPilot] = useState({
    candidateName: '',
    candidateEmail: '',
    panelName: '',
    meetingUrl: '',
    organizerEmail: '',
  });

  useEffect(() => {
    let mounted = true;
    api.getIntegrationStatus()
      .then((data) => {
        if (mounted) setStatus(data);
      })
      .catch((err) => {
        if (mounted) setError(err instanceof Error ? err.message : 'Could not check the automatic connections');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => { mounted = false; };
  }, []);

  const automaticReady = !!status?.keka.configured && !!status?.teams.configured;

  const loadCareerJobs = async () => {
    setCareerError(null);
    setCareerLoading(true);
    try {
      const response = await api.getMinfyCareerJobs();
      setCareerJobs(response.jobs);
    } catch (err) {
      setCareerError(err instanceof Error ? err.message : 'Could not load the published Minfy roles.');
    } finally {
      setCareerLoading(false);
    }
  };

  useEffect(() => {
    void loadCareerJobs();
  }, []);

  const careerDepartments = useMemo(() => Array.from(new Set(
    careerJobs.map((job) => job.department?.trim() || 'Other roles'),
  )).sort((left, right) => left.localeCompare(right)), [careerJobs]);

  const rolesForSelectedDepartment = useMemo(() => careerJobs
    .filter((job) => (job.department?.trim() || 'Other roles') === selectedCareerDepartment)
    .sort((left, right) => left.title.localeCompare(right.title)), [careerJobs, selectedCareerDepartment]);

  const createWorkspace = async () => {
    setError(null);
    setCreating(true);
    try {
      const created = await api.createIntelligenceInterview({ source_mode: 'keka_live' });
      router.push(`/interviews/intelligence/view?id=${created.intelligence_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The automatic interview sync could not start');
    } finally {
      setCreating(false);
    }
  };

  const createTeamsPilot = async () => {
    const required = [selectedCareerJobId, teamsPilot.candidateName, teamsPilot.meetingUrl, teamsPilot.organizerEmail]
      .every((value) => value.trim());
    if (!required) {
      setError('Choose a published Minfy role, then add the candidate, Teams meeting link, and meeting organiser email to continue.');
      return;
    }

    setError(null);
    setCreating(true);
    try {
      const { job } = await api.getMinfyCareerJob(selectedCareerJobId);
      const created = await api.createIntelligenceInterview({
        source_mode: 'teams_live',
        job: { title: job.title, description: job.description },
        candidate: { name: teamsPilot.candidateName.trim(), email: teamsPilot.candidateEmail.trim() || undefined },
        panel: [{ interviewerId: 'panel-1', name: teamsPilot.panelName.trim() || 'Interview panel' }],
        meetingUrl: teamsPilot.meetingUrl.trim(),
        organizerEmail: teamsPilot.organizerEmail.trim(),
      });
      router.push(`/interviews/intelligence/view?id=${created.intelligence_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Teams-connected workspace could not be created');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-7 pb-10">
      <Link href="/interviews/intelligence" className="inline-flex items-center gap-2 pt-2 text-sm font-semibold text-text-secondary hover:text-accent">
        <ArrowLeft size={16} />
        Back to Intelligence
      </Link>

      <section className="intelligence-create-hero">
        <div className="min-w-0">
            <p className="page-kicker">Interview workspace</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-text-primary md:text-4xl">
            Create a connected interview workspace.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
            Prepare the candidate and role context, then retrieve the Teams transcript after the interview. Additional HR-system data will appear automatically when it is available.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface-elevated p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">What happens here</p>
          <div className="mt-4 space-y-3">
            <FlowRow number="01" title="Interview context" detail="Role, candidate, resume, and panel" />
            <FlowRow number="02" title="Meeting transcript" detail="Retrieved once the interview ends" />
            <FlowRow number="03" title="Decision support" detail="Guide, review, and report" />
          </div>
        </div>
      </section>

      <section className="intelligence-card p-5 md:p-6">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="page-kicker">Workspace availability</p>
            <h2 className="mt-1 text-xl font-semibold text-text-primary">Set up your interview workspace</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
              The workspace uses the approved interview and meeting sources as they become available.
            </p>
          </div>
          <span className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${automaticReady ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
            {automaticReady ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
            {loading ? 'Checking availability' : automaticReady ? 'Ready to create' : 'Partially available'}
          </span>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <ConnectionCard
            icon={<Link2 size={18} />}
            name="Interview details"
            detail="Role, candidate, resume, interview schedule, and panel."
            connected={!!status?.keka.configured}
            state={loading ? 'Checking' : status?.keka.configured ? 'Available' : 'In setup'}
          />
          <ConnectionCard
            icon={<Video size={18} />}
            name="Meeting transcript"
            detail="The completed meeting transcript used for evidence review."
            connected={!!status?.teams.configured}
            state={loading ? 'Checking' : status?.teams.configured ? 'Available' : 'In setup'}
          />
        </div>

        {!loading && !automaticReady && (
          <div className="mt-5 rounded-2xl border border-warning/30 bg-warning/5 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="text-sm font-semibold text-text-primary">Some interview details will be added later</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  You can create a connected meeting workspace now. The remaining interview details will be added automatically once that source is available.
                </p>
              </div>
            </div>
          </div>
        )}

        {error && <div className="mt-5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>}

        <div className="mt-6 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-text-muted">Once Keka is connected, this screen creates the complete interview workspace automatically.</p>
          <button
            type="button"
            onClick={createWorkspace}
            disabled={loading || !automaticReady || creating}
            className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? <RefreshCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {creating ? 'Syncing interview...' : 'Sync interview automatically'}
          </button>
        </div>
      </section>

      {!loading && status?.teams.configured && !status.keka.configured && (
        <section className="intelligence-card p-5 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="page-kicker">Connected meeting workspace</p>
              <h2 className="mt-1 text-xl font-semibold text-text-primary">Create an interview workspace with transcript sync.</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                Choose the role and candidate context now. After the meeting ends, the workspace will retrieve the completed transcript for review.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowTeamsPilot((current) => !current)}
              className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
            >
              <Video size={16} />
              {showTeamsPilot ? 'Close setup' : 'Create workspace'}
            </button>
          </div>

          {showTeamsPilot && (
            <div className="mt-6 border-t border-border pt-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block md:col-span-2">
                  <span className="text-sm font-semibold text-text-primary">Minfy role and job description</span>
                  <span className="mt-1 block text-xs leading-5 text-text-muted">Choose the department and role. The official JD is fetched directly from Minfy Careers when the workspace is created.</span>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <select
                      value={selectedCareerDepartment}
                      disabled={careerLoading || !careerDepartments.length}
                      onChange={(event) => {
                        setSelectedCareerDepartment(event.target.value);
                        setSelectedCareerJobId('');
                      }}
                      className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-50"
                    >
                      <option value="">{careerLoading ? 'Loading departments...' : 'Select a department'}</option>
                      {careerDepartments.map((department) => <option key={department} value={department}>{department}</option>)}
                    </select>
                    <select
                      value={selectedCareerJobId}
                      disabled={!selectedCareerDepartment || careerLoading || !rolesForSelectedDepartment.length}
                      onChange={(event) => setSelectedCareerJobId(event.target.value)}
                      className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent disabled:opacity-50"
                    >
                      <option value="">{!selectedCareerDepartment ? 'Choose a department first' : 'Select a published role'}</option>
                      {rolesForSelectedDepartment.map((job) => <option key={job.id} value={job.id}>{job.title}</option>)}
                    </select>
                  </div>
                  {careerError && (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-danger/25 bg-danger/5 px-3 py-2">
                      <span className="text-xs text-danger">{careerError}</span>
                      <button type="button" onClick={loadCareerJobs} className="shrink-0 text-xs font-semibold text-accent">Try again</button>
                    </div>
                  )}
                </label>
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Candidate name</span>
                  <input value={teamsPilot.candidateName} onChange={(event) => setTeamsPilot({ ...teamsPilot, candidateName: event.target.value })} placeholder="Candidate name" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Candidate email</span>
                  <input type="email" value={teamsPilot.candidateEmail} onChange={(event) => setTeamsPilot({ ...teamsPilot, candidateEmail: event.target.value })} placeholder="candidate@email.com" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                <label className="block">
                  <span className="text-sm font-semibold text-text-primary">Panel lead</span>
                  <input value={teamsPilot.panelName} onChange={(event) => setTeamsPilot({ ...teamsPilot, panelName: event.target.value })} placeholder="Optional" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                <label className="block md:col-span-2">
                  <span className="text-sm font-semibold text-text-primary">Teams meeting link</span>
                  <input value={teamsPilot.meetingUrl} onChange={(event) => setTeamsPilot({ ...teamsPilot, meetingUrl: event.target.value })} placeholder="https://teams.microsoft.com/l/meetup-join/..." className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                </label>
                <label className="block md:col-span-2">
                  <span className="text-sm font-semibold text-text-primary">Meeting organiser email</span>
                  <input value={teamsPilot.organizerEmail} onChange={(event) => setTeamsPilot({ ...teamsPilot, organizerEmail: event.target.value })} placeholder="organiser@minfytech.com" className="mt-2 w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-primary outline-none focus:border-accent" />
                  <span className="mt-2 block text-xs leading-5 text-text-muted">This must be the organiser who has been granted the Teams Application Access Policy.</span>
                </label>
              </div>
              <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-text-muted">After the meeting, open this workspace and select "Sync Teams transcript".</p>
                <button type="button" onClick={createTeamsPilot} disabled={creating} className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold disabled:opacity-50">
                  {creating ? <RefreshCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
                  {creating ? 'Creating Teams workspace...' : 'Create Teams workspace'}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function FlowRow({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 font-mono text-xs font-semibold text-accent">{number}</span>
      <div>
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="text-xs text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function ConnectionCard({ icon, name, detail, connected, state }: { icon: React.ReactNode; name: string; detail: string; connected: boolean; state: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">{icon}</span>
          <div>
            <p className="text-sm font-semibold text-text-primary">{name}</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">{detail}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${connected ? 'bg-success/10 text-success' : 'bg-surface-elevated text-text-muted'}`}>{state}</span>
      </div>
    </div>
  );
}
