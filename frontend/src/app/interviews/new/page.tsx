'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTour, checkTourStatus } from '@/contexts/TourContext';
import { api, MinfyCareerJob } from '@/lib/api';
import { 
  ArrowLeft, 
  Upload, 
  CheckCircle2, 
  Loader2,
  AlertCircle
} from 'lucide-react';
import Link from 'next/link';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Step = 'CREATE' | 'UPLOAD';

export default function NewInterview() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('CREATE');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkGibberish = (str: string): boolean => {
    if (!str || str.length < 3) return false;
    // Basic entropy check: many non-vowel consonants in a row or random character patterns
    const consonants = str.match(/[^aeiou\s\d]/gi) || [];
    const vowels = str.match(/[aeiou]/gi) || [];
    const hasVowels = vowels.length > 0;
    const tooManyConsonants = consonants.length > 5 && (consonants.length / str.length) > 0.8;
    const isRepeated = /(.)\1{4,}/.test(str);
    return tooManyConsonants || isRepeated || !hasVowels;
  };
  const [interviewId, setInterviewId] = useState<string | null>(null);
  const [careerJobs, setCareerJobs] = useState<MinfyCareerJob[]>([]);
  const [careerLoading, setCareerLoading] = useState(false);
  const [careerError, setCareerError] = useState<string | null>(null);
  const [selectedCareerDepartment, setSelectedCareerDepartment] = useState('');
  const [selectedCareerJobId, setSelectedCareerJobId] = useState('');

  const { startTour } = useTour();

  useEffect(() => {
    if (step === 'CREATE') {
      checkTourStatus('interviews-new-details').then(done => {
        if (!done) {
          setTimeout(() => {
            startTour([
              {
                targetId: 'tour-candidate-name',
                title: 'Candidate full name',
                body: "Enter the candidate's full name exactly as it appears on their resume. This will appear in the generated PDF report.",
                position: 'right',
              },
              {
                targetId: 'tour-position',
                title: 'Choose the published role',
                body: 'Select the Minfy role being evaluated. Its official job description is fetched and attached automatically.',
                position: 'right',
              },
              {
                targetId: 'tour-model',
                title: 'AI evaluation model',
                body: 'Claude 3.7 Sonnet stays the default recommendation for most interviews. Claude Sonnet 4.6 is also available if you want the newest model.',
                position: 'right',
              },
            ], 'interviews-new-details');
          }, 300);
        }
      });
    }
  }, [step, startTour]);

  useEffect(() => {
    if (step === 'UPLOAD') {
      checkTourStatus('interviews-new-upload').then(done => {
        if (!done) {
          setTimeout(() => {
            startTour([
              {
                targetId: 'tour-jd-upload',
                title: 'Official JD attached',
                body: 'The selected Minfy Careers job description is already part of this evaluation. No JD file upload is needed.',
                position: 'bottom',
              },
              {
                targetId: 'tour-resume-upload',
                title: 'Candidate resume (optional)',
                body: 'Add the resume before preparing the guide so the interviewer can focus on the candidate’s actual experience. This remains optional.',
                position: 'bottom',
              },
              {
                targetId: 'tour-submit-btn',
                title: 'Prepare the interview workspace',
                body: 'Continue to prepare the scenario-based question guide. The interview transcript is added afterward.',
                position: 'top',
              },
            ], 'interviews-new-upload');
          }, 300);
        }
      });
    }
  }, [step, startTour]);
  
  // Form State
  const [formData, setFormData] = useState({
    candidate_name: '',
    position: '',
    interview_date: new Date().toISOString().split('T')[0],
    model_id: 'claude-sonnet-5',
  });

  // Upload State
  const [uploads, setUploads] = useState({
    transcript: { file: null as File | null, status: 'IDLE' as 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR' },
    jd: { file: null as File | null, status: 'IDLE' as 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR' },
    resume: { file: null as File | null, status: 'IDLE' as 'IDLE' | 'UPLOADING' | 'DONE' | 'ERROR' },
  });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedCareerJobId) {
      setError('Select a published Minfy role before creating the evaluation.');
      return;
    }

    // Gibberish Check
    if (checkGibberish(formData.candidate_name) || checkGibberish(formData.position)) {
      setError("Please provide a valid candidate name and professional position. Real context is required for a high-quality analysis.");
      return;
    }

    setLoading(true);
    let createdInterviewId: string | null = null;
    try {
      const { interview_id } = await api.createInterview({
        ...formData,
        interview_date: new Date(formData.interview_date).toISOString(),
      });
      createdInterviewId = interview_id;
      const response = await api.attachMinfyCareerJobDescription(interview_id, selectedCareerJobId);
      setUploads((current) => ({
        ...current,
        jd: {
          file: new File([], `Minfy Careers - ${response.job.title}.txt`, { type: 'text/plain' }),
          status: 'DONE',
        },
      }));
      setInterviewId(interview_id);
      setStep('UPLOAD');
    } catch (err: any) {
      if (createdInterviewId) {
        await api.deleteInterview(createdInterviewId).catch(() => undefined);
      }
      setError(err.message || 'Failed to prepare the evaluation from the selected Minfy role.');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (type: 'transcript' | 'jd' | 'resume', file: File) => {
    if (!interviewId) return;
    
    setUploads(prev => ({ ...prev, [type]: { ...prev[type], status: 'UPLOADING' } }));
    
    try {
      // 1. Get presigned URL
      const { upload_url, s3_key } = await api.getUploadUrl(interviewId, type, file.name, file.type);
      
      // 2. Upload to S3
      const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      
      if (!uploadRes.ok) throw new Error('S3 upload failed');
      
      // 3. Confirm with backend
      await api.confirmUpload(interviewId, type, s3_key);
      
      setUploads(prev => ({ ...prev, [type]: { file, status: 'DONE' } }));
    } catch (err) {
      console.error(err);
      setUploads(prev => ({ ...prev, [type]: { ...prev[type], status: 'ERROR' } }));
    }
  };

  const loadCareerJobs = async () => {
    setCareerError(null);
    setCareerLoading(true);
    try {
      const response = await api.getMinfyCareerJobs();
      setCareerJobs(response.jobs);
    } catch (err) {
      setCareerError(err instanceof Error ? err.message : 'Could not load the Minfy Careers roles.');
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

  return (
    <div className="space-y-8">
      <Link href="/interviews" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">Interview evaluator</p>
        <h1 className="text-2xl font-semibold text-text-primary">New evaluation</h1>
        <p className="text-sm leading-6 text-text-secondary">Choose the candidate and published role first. The interview workspace will then guide you through the remaining documents.</p>
      </div>

      {/* Progress Steps */}
      <div className="mx-auto flex max-w-md items-center justify-center gap-4 py-8">
        <ProgressStep step={1} active={step === 'CREATE'} done={!!interviewId} label="Details" />
        <div className={cn("h-px flex-1 transition-colors duration-500", !!interviewId ? "bg-success" : "bg-border")} />
        <ProgressStep step={2} active={step === 'UPLOAD'} done={uploads.jd.status === 'DONE'} label="Review & resume" />
      </div>

      {error && (
        <div className="card mb-6 flex items-center gap-3 border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger" role="alert" aria-live="assertive">
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      {step === 'CREATE' && (
        <form onSubmit={handleCreate} className="card p-8 space-y-6">
          <div className="border-b border-border pb-5">
            <h2 className="text-lg font-semibold text-text-primary">Candidate and role</h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">The selected Minfy Careers description becomes the scoring context for this evaluation.</p>
          </div>
          <div className="space-y-5">
            {/* Two short fields share a row: on the full page measure a lone name
                input stretched across the card reads worse than a paired one. */}
            <div className="grid gap-5 lg:grid-cols-2">
              <div id="tour-candidate-name">
                <label className="block text-xs font-semibold text-text-muted mb-2">Candidate Name</label>
                <input
                  required
                  className="premium-input w-full px-4 text-sm"
                  value={formData.candidate_name}
                  onChange={e => setFormData({ ...formData, candidate_name: e.target.value })}
                  placeholder="e.g. Sarah Connor"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-text-muted mb-2">Interview Date</label>
                <input
                  type="date"
                  required
                  className="premium-input w-full px-4 text-sm"
                  value={formData.interview_date}
                  onChange={e => setFormData({ ...formData, interview_date: e.target.value })}
                />
              </div>
            </div>
            <div id="tour-position">
              <div className="mb-2 flex items-center justify-between gap-3">
                <label className="block text-xs font-semibold text-text-muted">Minfy role and job description</label>
                {careerLoading && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                    <Loader2 size={12} className="animate-spin" />
                    Loading roles
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className="mb-2 block text-xs font-medium text-text-secondary">Department</span>
                  <select
                    required
                    className="premium-input w-full px-4 text-sm appearance-none"
                    value={selectedCareerDepartment}
                    disabled={careerLoading || !careerDepartments.length}
                    onChange={(event) => {
                      setSelectedCareerDepartment(event.target.value);
                      setSelectedCareerJobId('');
                      setFormData((current) => ({ ...current, position: '' }));
                    }}
                  >
                    <option value="">{careerLoading ? 'Loading departments...' : 'Select a department'}</option>
                    {careerDepartments.map((department) => (
                      <option key={department} value={department}>{department}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="mb-2 block text-xs font-medium text-text-secondary">Role</span>
                  <select
                    required
                    className="premium-input w-full px-4 text-sm appearance-none"
                    value={selectedCareerJobId}
                    disabled={!selectedCareerDepartment || careerLoading || !rolesForSelectedDepartment.length}
                    onChange={(event) => {
                      const jobId = event.target.value;
                      const selectedJob = careerJobs.find((job) => job.id === jobId);
                      setSelectedCareerJobId(jobId);
                      setFormData((current) => ({ ...current, position: selectedJob?.title || '' }));
                    }}
                  >
                    <option value="">
                      {!selectedCareerDepartment ? 'Choose a department first' : 'Select a published role'}
                    </option>
                    {rolesForSelectedDepartment.map((job) => (
                      <option key={job.id} value={job.id}>{job.title}</option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-xs leading-5 text-text-muted">
                Choose the team first, then the role. The official JD is fetched from Minfy Careers and attached when you continue.
              </p>
              {careerError && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2">
                  <span className="text-xs text-danger">{careerError}</span>
                  <button type="button" onClick={loadCareerJobs} className="shrink-0 text-xs font-semibold text-accent">Try again</button>
                </div>
              )}
              {selectedCareerJobId && (
                <div className="mt-3 rounded-lg border border-success/25 bg-success/5 px-3 py-2" role="status" aria-live="polite">
                  <p className="text-xs font-semibold text-success">Official role selected</p>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">The published Minfy Careers job description will be attached automatically when you continue.</p>
                </div>
              )}
            </div>
            <div id="tour-model" className="lg:max-w-lg">
              <label className="block text-xs font-semibold text-text-muted mb-2">Assessment Model</label>
              <select
                id="model_id"
                name="model_id"
                className="premium-input w-full px-4 text-sm appearance-none"
                value={formData.model_id}
                onChange={e => setFormData({ ...formData, model_id: e.target.value })}
              >
                <option value="claude-sonnet-5">Claude Sonnet 5 (Best quality)</option>
                <option value="claude-3-sonnet">Claude 3.7 Sonnet</option>
                <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                <option value="nova-pro">Amazon Nova Pro</option>
              </select>
            </div>
          </div>
          <div className="flex justify-center border-t border-border pt-6">
            <button
              type="submit"
              disabled={loading || careerLoading || !selectedCareerJobId}
              className="btn-primary flex w-full items-center justify-center gap-2 px-10 py-3 font-semibold disabled:opacity-50 sm:w-auto"
            >
              {loading ? <Loader2 className="animate-spin" size={20} /> : 'Create evaluation with this JD'}
            </button>
          </div>
        </form>
      )}

      {step === 'UPLOAD' && (
        <div className="space-y-6">
          <div className="card border-accent/20 bg-accent/5 p-5">
            <p className="text-sm font-semibold text-text-primary">The official job description is ready</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              The selected Minfy Careers JD is attached. Add a resume only if it is available, then prepare the scenario-based question guide before uploading the interview transcript.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div id="tour-jd-upload" className="card flex min-h-44 flex-col justify-between border-success/25 bg-success/5 p-5">
              <div>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success">
                  <CheckCircle2 size={20} />
                </span>
                <p className="mt-4 text-sm font-semibold text-text-primary">{formData.position}</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">Official Minfy Careers JD attached automatically</p>
              </div>
              <span className="mt-4 text-xs font-semibold text-success">Ready for question preparation</span>
            </div>
            <div id="tour-resume-upload" className="flex flex-col h-full">
              <UploadCard 
                title="Candidate Resume" 
                description="Optional: For deep experience verification"
                status={uploads.resume.status}
                fileName={uploads.resume.file?.name}
                onUpload={file => handleFileUpload('resume', file)}
              />
            </div>
          </div>

          <div className="pt-4">
            <button
              id="tour-submit-btn"
              onClick={() => router.push(`/interviews/view?id=${interviewId}`)}
              disabled={uploads.jd.status !== 'DONE'}
              className="btn-primary mx-auto flex w-full items-center justify-center gap-2 px-10 py-3 font-bold disabled:opacity-30 sm:w-auto"
            >
              Continue to interview workspace
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

function ProgressStep({ step, active, done, label }: { step?: number, active: boolean, done: boolean, label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={cn(
        "w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all duration-300",
        done ? "bg-success border-success text-white" :
        active ? "bg-accent border-accent text-accent-foreground shadow-lg shadow-accent/20" :
        "bg-surface border-border text-text-muted"
      )}>
        {done ? <CheckCircle2 size={20} /> : step || (active ? "!" : "?")}
      </div>
      <span className={cn(
        "text-xs font-semibold whitespace-nowrap",
        active || done ? "text-text-primary" : "text-text-muted"
      )}>
        {label}
      </span>
    </div>
  );
}

function UploadCard({ title, description, status, fileName, onUpload }: { title: string, description: string, status: string, fileName?: string, onUpload: (f: File) => void }) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setIsDragging(true);
    else if (e.type === 'dragleave') setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div 
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      className={cn(
        "card upload-zone p-6 flex flex-col justify-between items-center text-center space-y-4 transition-all duration-300",
        status === 'IDLE' ? (isDragging ? 'bg-accent/5 border-accent ring-2 ring-accent/20' : 'bg-surface/50 border-dashed hover:border-accent/40') : 
        status === 'DONE' ? 'bg-success/5 border-success/30' : ''
      )}
      aria-live="polite"
    >
      <div className="w-full h-4" />
      <div className={`p-3 rounded-full transition-transform duration-300 ${isDragging ? 'scale-110' : ''} ${
        status === 'DONE' ? "bg-success/10 text-success" : "bg-surface text-text-muted"
      }`}>
        {status === 'DONE' ? <CheckCircle2 size={24} /> : <Upload size={24} className={isDragging ? 'text-accent' : ''} />}
      </div>
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-text-primary tracking-tight">{title}</h4>
        <p className={cn(
          "text-xs mt-1",
          status === 'DONE' ? "text-success font-medium" : "text-text-muted"
        )}>
          {status === 'DONE' && fileName ? fileName : description}
        </p>
      </div>
      
      <div className="w-full">
        {status === 'IDLE' && (
          <label className="btn-secondary w-full py-2 text-xs font-semibold cursor-pointer flex items-center justify-center">
            {isDragging ? 'Drop to Upload' : 'Browse File'}
            <input 
              type="file" 
              className="hidden" 
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  onUpload(file);
                  e.target.value = '';
                }
              }}
            />
          </label>
        )}
        
        {status === 'UPLOADING' && (
          <div className="w-full py-2 flex items-center justify-center gap-2 text-xs font-semibold text-accent">
            <Loader2 className="animate-spin" size={14} />
            Uploading...
          </div>
        )}

        {status === 'DONE' && (
          <label className="w-full py-2 bg-success/10 border border-success/20 text-xs font-semibold text-success rounded-lg cursor-pointer hover:bg-success/20 transition-colors flex items-center justify-center gap-2">
            Change File
            <input 
              type="file" 
              className="hidden" 
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  onUpload(file);
                  e.target.value = '';
                }
              }}
            />
          </label>
        )}

        {status === 'ERROR' && (
          <label className="w-full py-2 bg-danger/10 border border-danger/20 text-xs font-semibold text-danger rounded-lg cursor-pointer hover:bg-danger/20 transition-colors flex items-center justify-center gap-2">
            <AlertCircle size={14} />
            Retry Upload
            <input 
              type="file" 
              className="hidden" 
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  onUpload(file);
                  e.target.value = '';
                }
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}
