'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

type Step = 'CREATE' | 'UPLOAD' | 'ANALYZE';

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
    } catch (err) {
      alert('Failed to create interview record');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (type: 'transcript' | 'jd', file: File) => {
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

  const handleAnalyze = async () => {
    if (!interviewId) return;
    setLoading(true);
    try {
      await api.analyzeInterview(interviewId);
      router.push(`/interviews/view?id=${interviewId}`);
    } catch (err) {
      alert('Failed to trigger analysis');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <Link href="/" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">New Evaluation</h1>
        <p className="text-text-secondary">Follow the steps to prepare and trigger an automated AI assessment.</p>
      </div>

      {/* Progress Indicator */}
      <div className="flex items-center gap-4 py-4">
        <ProgressStep active={step === 'CREATE'} done={!!interviewId} label="Draft" />
        <div className="h-px flex-1 bg-border" />
        <ProgressStep active={step === 'UPLOAD'} done={uploads.transcript.status === 'DONE' && uploads.jd.status === 'DONE'} label="Uploads" />
        <div className="h-px flex-1 bg-border" />
        <ProgressStep active={step === 'ANALYZE'} done={false} label="Analysis" />
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
            <div>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Candidate Name</label>
              <input 
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.candidate_name}
                onChange={e => setFormData({ ...formData, candidate_name: e.target.value })}
                placeholder="e.g. Sarah Connor"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Position</label>
              <input 
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.position}
                onChange={e => setFormData({ ...formData, position: e.target.value })}
                placeholder="e.g. Senior Software Engineer"
              />
            </div>
             <div>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Interview Date</label>
              <input 
                type="date"
                required
                className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
                value={formData.interview_date}
                onChange={e => setFormData({ ...formData, interview_date: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Assessment Model</label>
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
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Create Interview Record'}
          </button>
        </form>
      )}

      {step === 'UPLOAD' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <UploadCard 
              title="Interview Transcript" 
              description="PDF, DOCX or TXT of the conversation"
              status={uploads.transcript.status}
              onUpload={file => handleFileUpload('transcript', file)}
            />
            <UploadCard 
              title="Job Description" 
              description="Primary requirements and expectations"
              status={uploads.jd.status}
              onUpload={file => handleFileUpload('jd', file)}
            />
          </div>

          <div className="pt-4">
            <button 
              onClick={() => router.push(`/interviews/view?id=${interviewId}`)}
              disabled={uploads.transcript.status !== 'DONE' || uploads.jd.status !== 'DONE'}
              className="w-full py-3 bg-accent text-accent-foreground font-bold rounded-md hover:opacity-90 transition-opacity disabled:opacity-30 flex items-center justify-center gap-2"
            >
              Finish and Go to Readiness Gate
            </button>
          </div>
        </div>
      )}

      {step === 'ANALYZE' && (
        <div className="card p-12 text-center space-y-6">
          <div className="w-16 h-16 bg-accent/10 text-accent rounded-full flex items-center justify-center mx-auto mb-2">
            <FileText size={32} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold text-text-primary">Ready for AI Evaluation</h3>
            <p className="text-text-secondary max-w-sm mx-auto">
              Both documents have been securely processed. Amazon Bedrock is ready to assess the interview against your local rubric.
            </p>
          </div>
          <button 
            onClick={handleAnalyze}
            disabled={loading}
            className="px-8 py-3 bg-accent text-accent-foreground font-bold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 mx-auto disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : 'Trigger AI Analysis'}
          </button>
          <button 
            onClick={() => setStep('UPLOAD')}
            className="block mx-auto text-sm text-text-muted hover:text-text-primary"
          >
            Back to Uploads
          </button>
        </div>
      )}
    </div>
  );
}

function ProgressStep({ active, done, label }: { active: boolean, done: boolean, label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold tracking-tighter transition-all ${
        done ? "bg-green-500 border-green-500 text-white" : 
        active ? "bg-accent border-accent text-accent-foreground ring-4 ring-ring" : 
        "border-border text-text-muted"
      }`}>
        {done ? <CheckCircle2 size={14} /> : active ? "!" : ""}
      </div>
      <span className={`text-xs font-bold uppercase tracking-widest ${active || done ? "text-text-primary" : "text-text-muted"}`}>{label}</span>
    </div>
  );
}

function UploadCard({ title, description, status, onUpload }: { title: string, description: string, status: string, onUpload: (f: File) => void }) {
  return (
    <div className="card p-6 flex flex-col justify-between items-center text-center space-y-4">
      <div className={`p-3 rounded-full ${
        status === 'DONE' ? "bg-green-50 text-green-600 dark:bg-green-900/10" : "bg-surface text-text-muted"
      }`}>
        {status === 'DONE' ? <CheckCircle2 size={24} /> : <Upload size={24} />}
      </div>
      <div>
        <h4 className="text-sm font-bold text-text-primary tracking-tight">{title}</h4>
        <p className="text-xs text-text-muted mt-1">{description}</p>
      </div>
      
      <div className="w-full">
        {status === 'IDLE' && (
          <label className="w-full py-2 bg-surface-elevated border border-border text-xs font-bold text-text-primary rounded cursor-pointer hover:bg-surface transition-colors flex items-center justify-center">
            Browse File
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
          <div className="w-full py-2 flex items-center justify-center gap-2 text-xs font-bold text-accent">
            <Loader2 className="animate-spin" size={14} />
            Uploading...
          </div>
        )}

        {status === 'DONE' && (
          <label className="w-full py-2 bg-green-50/50 border border-green-200 text-xs font-bold text-green-600 rounded cursor-pointer hover:bg-green-50 transition-colors flex items-center justify-center gap-2">
            <CheckCircle2 size={14} />
            File Verified (Change)
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
          <label className="w-full py-2 bg-red-50/50 border border-red-200 text-xs font-bold text-danger rounded cursor-pointer hover:bg-red-50 transition-colors flex items-center justify-center gap-2">
            <AlertCircle size={14} />
            Failed. Retry.
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
