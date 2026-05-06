'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useTour, checkTourStatus } from '@/contexts/TourContext';
import { api } from '@/lib/api';
import { 
  ArrowLeft, 
  Upload, 
  FileText, 
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
                title: 'Role being evaluated',
                body: 'Enter the exact job title. This calibrates the AI scoring rubric against the right seniority level.',
                position: 'right',
              },
              {
                targetId: 'tour-model',
                title: 'AI evaluation model',
                body: 'Claude 3.7 Sonnet gives the most accurate evaluation. Nova Pro is faster but less nuanced. Recommended: Claude 3.7 Sonnet.',
                position: 'right',
              },
            ], 'interviews-new-details');
          }, 1000);
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
                targetId: 'tour-transcript-upload',
                title: 'Interview transcript (required)',
                body: 'Upload the full interview transcript as PDF, DOCX or TXT. The more complete it is, the more accurate the evaluation.',
                position: 'bottom',
              },
              {
                targetId: 'tour-jd-upload',
                title: 'Job description (required)',
                body: 'Upload the exact JD the candidate was interviewed against. The AI uses this to build a custom scoring rubric.',
                position: 'bottom',
              },
              {
                targetId: 'tour-resume-upload',
                title: 'Candidate resume (optional)',
                body: 'If provided, the AI cross-checks transcript claims against the resume. This significantly improves accuracy.',
                position: 'bottom',
              },
              {
                targetId: 'tour-submit-btn',
                title: 'Submit for analysis',
                body: 'Once transcript and JD are uploaded, click here. Analysis takes 60–90 seconds. You will be redirected automatically.',
                position: 'top',
              },
            ], 'interviews-new-upload');
          }, 800);
        }
      });
    }
  }, [step, startTour]);
  
  // Form State
  const [formData, setFormData] = useState({
    candidate_name: '',
    position: '',
    interview_date: new Date().toISOString().split('T')[0],
    model_id: 'claude-3-sonnet',
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

    // Gibberish Check
    if (checkGibberish(formData.candidate_name) || checkGibberish(formData.position)) {
      setError("Please provide a valid candidate name and professional position. Real context is required for a high-quality analysis.");
      return;
    }

    setLoading(true);
    try {
      const { interview_id } = await api.createInterview({
        ...formData,
        interview_date: new Date(formData.interview_date).toISOString(),
      });
      setInterviewId(interview_id);
      setStep('UPLOAD');
    } catch (err: any) {
      setError(err.message || 'Failed to create interview record');
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


  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <Link href="/interviews" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">New Evaluation</h1>
        <p className="text-text-secondary">Follow the steps to prepare and trigger an automated AI assessment.</p>
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-center gap-4 py-8 max-w-sm mx-auto">
        <ProgressStep step={1} active={step === 'CREATE'} done={!!interviewId} label="Details" />
        <div className={cn("h-px flex-1 transition-colors duration-500", !!interviewId ? "bg-success" : "bg-border")} />
        <ProgressStep step={2} active={step === 'UPLOAD'} done={uploads.transcript.status === 'DONE' && uploads.jd.status === 'DONE'} label="Documents" />
      </div>

      {error && (
        <div className="card p-4 border-danger/30 bg-danger/5 text-danger font-bold text-sm mb-6 flex items-center gap-3 animate-head-shake">
          <AlertCircle size={20} />
          {error}
        </div>
      )}

      {step === 'CREATE' && (
        <form onSubmit={handleCreate} className="card p-8 space-y-6">
          <div className="space-y-4">
            <div id="tour-candidate-name">
              <label className="block text-xs font-semibold text-text-muted mb-2">Candidate Name</label>
              <input 
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.candidate_name}
                onChange={e => setFormData({ ...formData, candidate_name: e.target.value })}
                placeholder="e.g. Sarah Connor"
              />
            </div>
            <div id="tour-position">
              <label className="block text-xs font-semibold text-text-muted mb-2">Position</label>
              <input 
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.position}
                onChange={e => setFormData({ ...formData, position: e.target.value })}
                placeholder="e.g. Senior Software Engineer"
              />
            </div>
             <div>
              <label className="block text-xs font-semibold text-text-muted mb-2">Interview Date</label>
              <input 
                type="date"
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.interview_date}
                onChange={e => setFormData({ ...formData, interview_date: e.target.value })}
              />
            </div>
            <div id="tour-model">
              <label className="block text-xs font-semibold text-text-muted mb-2">Assessment Model</label>
              <select
                id="model_id"
                name="model_id"
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all appearance-none"
                value={formData.model_id}
                onChange={e => setFormData({ ...formData, model_id: e.target.value })}
              >
                <option value="claude-3-sonnet">Claude 3.7 Sonnet (Professional Intelligence)</option>
                <option value="nova-pro">Amazon Nova Pro</option>
              </select>
            </div>
          </div>
          <button 
            type="submit" 
            disabled={loading}
            className="w-full py-3 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Continue to document upload'}
          </button>
        </form>
      )}

      {step === 'UPLOAD' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div id="tour-transcript-upload" className="flex flex-col h-full">
              <UploadCard 
                title="Interview Transcript" 
                description="PDF, DOCX or TXT of the conversation"
                status={uploads.transcript.status}
                fileName={uploads.transcript.file?.name}
                onUpload={file => handleFileUpload('transcript', file)}
              />
            </div>
            <div id="tour-jd-upload" className="flex flex-col h-full">
              <UploadCard 
                title="Job Description" 
                description="Primary requirements and expectations"
                status={uploads.jd.status}
                fileName={uploads.jd.file?.name}
                onUpload={file => handleFileUpload('jd', file)}
              />
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
              disabled={uploads.transcript.status !== 'DONE' || uploads.jd.status !== 'DONE'}
              className="w-full py-3 bg-accent text-accent-foreground font-bold rounded-md hover:opacity-90 transition-opacity disabled:opacity-30 flex items-center justify-center gap-2"
            >
              Submit for analysis
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
        "card p-6 flex flex-col justify-between items-center text-center space-y-4 transition-all duration-300",
        status === 'IDLE' ? (isDragging ? 'bg-accent/5 border-accent ring-2 ring-accent/20' : 'bg-surface/50 border-dashed hover:border-accent/40') : 
        status === 'DONE' ? 'bg-success/5 border-success/30' : ''
      )}
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
          <label className="w-full py-2 bg-surface-elevated border border-border text-xs font-semibold text-text-primary rounded-md cursor-pointer hover:bg-surface transition-colors flex items-center justify-center">
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
          <label className="w-full py-2 bg-success/10 border border-success/20 text-xs font-semibold text-success rounded-md cursor-pointer hover:bg-success/20 transition-colors flex items-center justify-center gap-2">
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
          <label className="w-full py-2 bg-danger/10 border border-danger/20 text-xs font-semibold text-danger rounded-md cursor-pointer hover:bg-danger/20 transition-colors flex items-center justify-center gap-2">
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
