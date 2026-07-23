'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, IntegrationStatus, KekaCandidateOption, KekaInterviewOption, KekaJobOption, MinfyCareerJob } from '@/lib/api';
import {
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  ShieldCheck,
  UserRound,
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
  const [kekaJobs, setKekaJobs] = useState<KekaJobOption[]>([]);
  const [kekaCandidates, setKekaCandidates] = useState<KekaCandidateOption[]>([]);
  const [kekaInterviews, setKekaInterviews] = useState<KekaInterviewOption[]>([]);
  const [selectedKekaJobId, setSelectedKekaJobId] = useState('');
  const [selectedKekaCandidateId, setSelectedKekaCandidateId] = useState('');
  const [selectedKekaInterviewId, setSelectedKekaInterviewId] = useState('');
  const [selectedKekaDepartment, setSelectedKekaDepartment] = useState('');
  const [kekaRoleSearch, setKekaRoleSearch] = useState('');
  const [kekaLoading, setKekaLoading] = useState(false);

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

  const loadKekaJobs = async () => {
    setKekaLoading(true);
    try {
      const response = await api.getKekaJobs();
      setKekaJobs(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load roles from Keka Hire.');
    } finally {
      setKekaLoading(false);
    }
  };

  const selectKekaJob = async (jobId: string) => {
    setSelectedKekaJobId(jobId);
    setSelectedKekaCandidateId('');
    setSelectedKekaInterviewId('');
    setKekaCandidates([]);
    setKekaInterviews([]);
    if (!jobId) return;
    setError(null);
    setKekaLoading(true);
    try {
      const response = await api.getKekaCandidates(jobId);
      setKekaCandidates(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load candidates from Keka Hire.');
    } finally {
      setKekaLoading(false);
    }
  };

  const selectKekaCandidate = async (candidateId: string) => {
    setSelectedKekaCandidateId(candidateId);
    setSelectedKekaInterviewId('');
    setKekaInterviews([]);
    if (!candidateId || !selectedKekaJobId) return;
    setError(null);
    setKekaLoading(true);
    try {
      const response = await api.getKekaInterviews(selectedKekaJobId, candidateId);
      setKekaInterviews(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load scheduled interviews from Keka Hire.');
    } finally {
      setKekaLoading(false);
    }
  };

  useEffect(() => {
    if (status?.keka.configured) void loadKekaJobs();
  }, [status?.keka.configured]);

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

  const kekaDepartments = useMemo(() => Array.from(new Set(
    kekaJobs.map((job) => job.department?.trim() || 'Other roles'),
  )).sort((left, right) => left.localeCompare(right)), [kekaJobs]);

  const visibleKekaJobs = useMemo(() => {
    const query = kekaRoleSearch.trim().toLowerCase();
    return kekaJobs.filter((job) => {
      const department = job.department?.trim() || 'Other roles';
      return (!selectedKekaDepartment || department === selectedKekaDepartment)
        && (!query || `${job.title} ${department}`.toLowerCase().includes(query));
    });
  }, [kekaJobs, kekaRoleSearch, selectedKekaDepartment]);

  const createWorkspace = async () => {
    setError(null);
    setCreating(true);
    try {
      if (!selectedKekaJobId || !selectedKekaCandidateId || !selectedKekaInterviewId) {
        setError('Choose the role, candidate, and scheduled interview before creating the workspace.');
        return;
      }
      const created = await api.createIntelligenceInterview({
        source_mode: 'keka_live',
        jobId: selectedKekaJobId,
        candidateId: selectedKekaCandidateId,
        interviewId: selectedKekaInterviewId,
      });
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
          <p className="page-kicker">Interview intelligence</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-text-primary md:text-4xl">
            Start with the interview, not the paperwork.
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-text-secondary">
            Select a scheduled interview. MiMo brings together the role, candidate, panel, and meeting context in one review workspace.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Workspace includes</p>
          <div className="mt-4 space-y-3">
            <FlowRow number="01" title="Interview brief" detail="Role, candidate, resume, and panel" />
            <FlowRow number="02" title="Panel guide" detail="Structured questions and evidence signals" />
            <FlowRow number="03" title="Final review" detail="Transcript analysis and shareable report" />
          </div>
        </div>
      </section>

      <section className="intelligence-card overflow-hidden">
        <div className="border-b border-border px-5 py-5 md:px-7 md:py-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="page-kicker">Create workspace</p>
              <h2 className="mt-1 text-xl font-semibold text-text-primary">Select the scheduled interview</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
                Choose the role first, then the candidate and their scheduled interview. The workspace is created with the right context already attached.
              </p>
            </div>
            <span role="status" aria-live="polite" className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${automaticReady ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
              {automaticReady ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
              {loading ? 'Checking connections' : automaticReady ? 'Connections ready' : 'Connection needs attention'}
            </span>
          </div>
        </div>

        {status?.keka.configured && (
          <div className="p-5 md:p-7">
            <div className="grid gap-3 md:grid-cols-3">
              <SelectionStep number="1" icon={<BriefcaseBusiness size={17} />} title="Open role" complete={!!selectedKekaJobId}>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
                  <input
                    value={kekaRoleSearch}
                    onChange={(event) => setKekaRoleSearch(event.target.value)}
                    placeholder="Search roles"
                    aria-label="Search Keka roles"
                    className="premium-input w-full px-3 py-2.5 text-sm"
                  />
                  <select
                    value={selectedKekaDepartment}
                    onChange={(event) => {
                      setSelectedKekaDepartment(event.target.value);
                      void selectKekaJob('');
                    }}
                    disabled={kekaLoading || !kekaDepartments.length}
                    aria-label="Filter roles by department"
                    className="premium-input w-full px-3 py-2.5 text-sm disabled:opacity-50"
                  >
                    <option value="">All departments</option>
                    {kekaDepartments.map((department) => <option key={department} value={department}>{department}</option>)}
                  </select>
                </div>
                <select value={selectedKekaJobId} onChange={(event) => void selectKekaJob(event.target.value)} disabled={kekaLoading || !visibleKekaJobs.length} className="premium-input mt-2 w-full px-3 py-3 text-sm disabled:opacity-50">
                  <option value="">{visibleKekaJobs.length ? 'Choose a role' : 'No matching roles'}</option>
                  {visibleKekaJobs.map((job) => <option key={job.id} value={job.id}>{job.title}{job.department ? ` - ${job.department}` : ''}</option>)}
                </select>
              </SelectionStep>
              <SelectionStep number="2" icon={<UserRound size={17} />} title="Candidate" complete={!!selectedKekaCandidateId} muted={!selectedKekaJobId}>
                <select value={selectedKekaCandidateId} onChange={(event) => void selectKekaCandidate(event.target.value)} disabled={kekaLoading || !selectedKekaJobId || !kekaCandidates.length} className="premium-input mt-3 w-full px-3 py-3 text-sm disabled:opacity-50">
                  <option value="">{!selectedKekaJobId ? 'Choose a role first' : kekaCandidates.length ? 'Choose a candidate' : 'No candidates available'}</option>
                  {kekaCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.email ? ` - ${candidate.email}` : ''}</option>)}
                </select>
              </SelectionStep>
              <SelectionStep number="3" icon={<Video size={17} />} title="Scheduled interview" complete={!!selectedKekaInterviewId} muted={!selectedKekaCandidateId}>
                <select value={selectedKekaInterviewId} onChange={(event) => setSelectedKekaInterviewId(event.target.value)} disabled={kekaLoading || !selectedKekaCandidateId || !kekaInterviews.length} className="premium-input mt-3 w-full px-3 py-3 text-sm disabled:opacity-50">
                  <option value="">{!selectedKekaCandidateId ? 'Choose a candidate first' : kekaInterviews.length ? 'Choose an interview' : 'No scheduled interviews'}</option>
                  {kekaInterviews.map((interview) => <option key={interview.id} value={interview.id}>{interview.scheduledAt || 'Scheduled interview'}{interview.status ? ` - ${interview.status}` : ''}</option>)}
                </select>
              </SelectionStep>
            </div>
            {kekaLoading && <div className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-text-muted"><RefreshCw size={14} className="animate-spin" /> Updating interview options</div>}
          </div>
        )}

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

        {error && <div className="mt-5 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger" role="alert" aria-live="assertive">{error}</div>}

        <div className="flex flex-col gap-3 border-t border-border bg-surface px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
          <p className="text-xs leading-5 text-text-muted">{selectedKekaInterviewId ? 'Everything is selected. Create the workspace to prepare the panel guide.' : 'Complete the three selections above to prepare the interview workspace.'}</p>
          <button
            type="button"
            onClick={createWorkspace}
            disabled={loading || !automaticReady || creating || !selectedKekaInterviewId}
            className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? <RefreshCw size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            {creating ? 'Creating workspace...' : 'Create workspace'}
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
              aria-expanded={showTeamsPilot}
              aria-controls="teams-workspace-form"
              className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
            >
              <Video size={16} />
              {showTeamsPilot ? 'Close setup' : 'Create workspace'}
            </button>
          </div>

          {showTeamsPilot && (
            <div id="teams-workspace-form" className="mt-6 border-t border-border pt-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block md:col-span-2">
                  <span className="text-sm font-semibold text-text-primary">Minfy role and job description</span>
                  <span className="mt-1 block text-xs leading-5 text-text-muted">Choose the department and role. The official JD is fetched directly from Minfy Careers when the workspace is created.</span>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <select
                      aria-label="Department"
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
                      aria-label="Published Minfy role"
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

function SelectionStep({
  number,
  icon,
  title,
  complete,
  muted = false,
  children,
}: {
  number: string;
  icon: React.ReactNode;
  title: string;
  complete: boolean;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-2xl border p-4 transition-colors ${complete ? 'border-success/35 bg-success/5' : muted ? 'border-border bg-surface opacity-75' : 'border-border bg-surface-elevated'}`}>
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-semibold ${complete ? 'bg-success text-white' : 'bg-accent/10 text-accent'}`}>
          {complete ? <CheckCircle2 size={18} /> : icon}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Step {number}</p>
          <p className="mt-0.5 text-sm font-semibold text-text-primary">{title}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
