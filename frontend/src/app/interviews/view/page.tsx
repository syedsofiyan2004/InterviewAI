'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, DetailedInterview, EvaluationResult } from '@/lib/api';
import { 
  ArrowLeft, 
  Loader2, 
  AlertCircle, 
  CheckCircle2, 
  ShieldCheck,
  TrendingUp,
  Target,
  FileText,
  Trash2,
  ArrowRight
} from 'lucide-react';
import Link from 'next/link';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function InterviewDetailsContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') || '';
  const router = useRouter();
  const [interview, setInterview] = useState<DetailedInterview | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const getFriendlyError = (err: string) => {
    if (err.includes('AI_MALFORMED_OUTPUT')) return "The AI had trouble formatting the result. This often happens if the transcript is very messy. Please try clicking 'Retry Analysis'.";
    if (err.includes('JD_EXTRACTION_FAILED')) return "We couldn't read the Job Description. Please ensure it is a valid PDF or Word document.";
    if (err.includes('TRANSCRIPT_EXTRACTION_FAILED')) return "We couldn't read the Interview Transcript. Please ensure the file is not corrupted.";
    if (err.includes('NOT_FOUND')) return "We couldn't find this interview record. It may have been deleted.";
    return err;
  };

  const formatScore = (score: number | undefined) => {
    if (score === undefined || score === null) return '0.0';
    // If score is > 10, it's a legacy /100 score, so we divide by 10.
    const normalized = score > 10 ? score / 10 : score;
    return normalized.toFixed(1);
  };

  const fetchInterview = useCallback(async () => {
    if (!id) return false;
    try {
      const data = await api.getInterview(id);
      setInterview(data);
      
      if (data.status === 'COMPLETED') {
        const fullResult = await api.getEvaluationResult(id);
        setResult(fullResult);
        return true; 
      }
      
      if (data.status === 'FAILED') return true;
      return false;
    } catch (err: any) {
      setError(err.message);
      return true;
    } finally {
      setLoading(false);
    }
  }, [id]);

  const handleDelete = async () => {
    if (!interview) return;
    if (!confirm(`Are you sure you want to delete the interview for ${interview.metadata.candidate_name}?`)) return;
    try {
      setLoading(true);
      await api.deleteInterview(id);
      router.push('/');
    } catch (err) {
      alert('Failed to delete interview');
      setLoading(false);
    }
  };

  const handleDownloadReport = async () => {
    if (!interview) return;
    try {
      const { download_url } = await api.getReportUrl(id);
      const fileName = `${interview.metadata.candidate_name.replace(/\s+/g, '_')}_${interview.metadata.position.replace(/\s+/g, '_')}_Evaluation.pdf`;
      const link = document.createElement('a');
      link.href = download_url;
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      alert('Failed to download report');
    }
  };

  const handleManualAnalyze = async () => {
    try {
      setLoading(true);
      await api.analyzeInterview(id);
      fetchInterview(); 
    } catch (err: any) {
      alert(err.message || 'Failed to start analysis');
      setLoading(false);
    }
  };

  const handleRetry = async () => {
    try {
      setLoading(true);
      await api.analyzeInterview(id);
      setInterview(prev => prev ? { ...prev, status: 'QUEUED', error: null } : null);
      setResult(null);
    } catch (err) {
      alert('Failed to restart analysis');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    let timer: NodeJS.Timeout;
    async function poll() {
      const shouldStop = await fetchInterview();
      if (!shouldStop) timer = setTimeout(poll, 3000);
    }
    poll();
    return () => clearTimeout(timer);
  }, [id, fetchInterview]);

  if (loading && !interview) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="animate-spin text-accent" size={40} />
        <p className="text-text-secondary font-medium tracking-tight">Loading evaluation details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto mt-20 card p-8 text-center space-y-6">
        <div className="w-16 h-16 bg-danger/10 text-danger rounded-full flex items-center justify-center mx-auto">
          <AlertCircle size={32} />
        </div>
        <h3 className="text-xl font-bold text-text-primary">Failed to load</h3>
        <p className="text-text-secondary">{error}</p>
        <Link href="/" className="inline-block px-6 py-2 bg-accent text-accent-foreground font-bold rounded-md">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const isInFlight = interview?.status === 'QUEUED' || interview?.status === 'PROCESSING';

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-bold uppercase tracking-tight">
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Status</span>
            <StatusBadge status={interview?.status || 'CREATED'} />
          </div>
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-md text-text-muted hover:text-red-500 transition-all border border-border/50 hover:bg-red-50 hover:border-red-100"
            title="Delete Interview"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <header className="space-y-4">
        <div className="flex items-end justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-black text-text-primary tracking-tighter">{interview?.metadata.candidate_name}</h1>
            <p className="text-xl text-text-secondary font-medium">{interview?.metadata.position}</p>
          </div>
          
          {result && interview?.report_s3_key && (
            <div className="flex items-center gap-6">
              <button
                onClick={handleDownloadReport}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-surface border border-border text-text-secondary hover:text-accent hover:border-accent transition-all font-bold text-xs uppercase tracking-widest shadow-sm"
              >
                <FileText size={18} />
                Download Report
              </button>
              <div className="text-right">
                <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">Overall Rating</p>
                <div className="text-5xl font-black text-accent tracking-tighter leading-none">
                  {formatScore(result.overall_score)}
                  <span className="text-xl text-text-muted ml-1">/10</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      {!result && !isInFlight && interview?.status !== 'FAILED' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
                 <FileText size={20} className="text-accent" />
                 1. Document Enrollment
              </h3>
              {interview?.jd_s3_key && interview?.transcript_s3_key && (
                 <span className="px-2 py-0.5 bg-success/10 text-success text-[10px] font-bold rounded uppercase">Verified</span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               <FileUploadSection 
                  type="jd" 
                  interviewId={id} 
                  isUploaded={!!interview?.jd_s3_key} 
                  onSuccess={fetchInterview} 
               />
               <FileUploadSection 
                  type="transcript" 
                  interviewId={id} 
                  isUploaded={!!interview?.transcript_s3_key} 
                  onSuccess={fetchInterview} 
               />
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
               <ShieldCheck size={20} className="text-accent" />
               2. Readiness Gate
            </h3>
            <div className={cn(
               "card p-6 space-y-6 border-2 transition-all shadow-sm",
               (interview?.is_mismatched && !!interview?.inferred_role) ? "border-danger/30 bg-danger/5" : "border-border bg-surface/50"
            )}>
               <div className="space-y-3">
                  <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">Checklist</p>
                  <CheckItem label="JD Uploaded" done={!!interview?.jd_s3_key} />
                  <CheckItem label="Transcript Uploaded" done={!!interview?.transcript_s3_key} />
                  <CheckItem 
                    label="Role Match Verified" 
                    done={!!interview?.jd_s3_key && interview?.is_mismatched === false && !!interview?.inferred_role} 
                    warn={interview?.is_mismatched === true && !!interview?.inferred_role} 
                  />
               </div>

               {interview?.jd_s3_key && (
                  <div className="pt-4 border-t border-border space-y-4">
                    <div className="grid grid-cols-1 gap-4">
                       <div className="space-y-1">
                          <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Position</p>
                          <p className="text-sm font-bold text-text-primary">{interview?.metadata.position}</p>
                       </div>
                       <div className="space-y-1">
                          <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest">Detected Candidate Context</p>
                          <p className="text-sm font-bold text-accent italic">{interview?.inferred_role || 'Analyzing...'}</p>
                       </div>
                    </div>
                    {interview?.is_mismatched && !!interview?.inferred_role && (
                       <div className="p-3 bg-danger/10 border border-danger/20 rounded text-xs text-danger font-bold leading-relaxed">
                          Role Mismatch Warning: The detected JD context differs from your target position. Please verify uploads.
                       </div>
                    )}
                  </div>
               )}

               {/* Intelligent Guidance Section */}
               <div className="p-4 rounded-lg bg-accent/5 border border-accent/10 space-y-2">
                  <p className="text-[10px] font-bold text-accent uppercase tracking-widest flex items-center gap-1.5">
                     <Target size={12} />
                     AI Assistant Guidance
                  </p>
                   <p className="text-xs text-text-secondary leading-relaxed font-medium">
                      {!interview?.jd_s3_key ? "First, upload the Job Description to baseline the evaluation rubric." : 
                       !interview?.transcript_s3_key ? "Great, now upload the Interview Transcript to begin the technical deep-dive." :
                       !interview?.inferred_role ? "AI is currently verifying the document alignment. Please wait a moment..." :
                       interview?.is_mismatched ? `Alignment Blocked: ${(interview as any).alignment_reason || 'JD/Role mismatch detected.'}` :
                       "Everything looks aligned. You can now start the AI evaluation to generate the Bar-Raiser report."}
                   </p>
               </div>

               <button
                  onClick={handleManualAnalyze}
                  disabled={!interview?.jd_s3_key || !interview?.transcript_s3_key || loading || (interview as any).is_mismatched}
                  className="w-full py-4 bg-accent text-accent-foreground font-black uppercase tracking-widest text-xs rounded-lg hover:opacity-90 disabled:opacity-30 transition-all flex items-center justify-center gap-2 shadow-xl shadow-accent/20"
               >
                  {loading ? <Loader2 className="animate-spin" size={18} /> : (
                     <>
                        Start Assessment
                        <ArrowRight size={18} />
                     </>
                  )}
               </button>
            </div>
          </div>
        </div>
      )}

      {isInFlight && (
        <div className="card p-12 text-center space-y-6">
          <div className="relative w-20 h-20 mx-auto">
             <div className="absolute inset-0 rounded-full border-4 border-accent/20 border-t-accent animate-spin" />
             <div className="absolute inset-0 flex items-center justify-center text-accent">
                <Target size={32} />
             </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-2xl font-bold text-text-primary tracking-tight">AI Analysis in Progress</h3>
            <p className="text-text-secondary max-w-sm mx-auto">
              Amazon Bedrock is currently evaluating the transcript against the JD rubric. This usually takes 30-45 seconds.
            </p>
          </div>
        </div>
      )}

      {interview?.status === 'FAILED' && (
        <div className="card p-8 border-danger/30 bg-danger/5 space-y-4">
          <div className="flex items-center gap-3 text-danger">
            <AlertCircle size={24} />
            <h3 className="text-lg font-bold uppercase tracking-tight">Technical Issue Detected</h3>
          </div>
          <p className="text-text-secondary font-medium leading-relaxed">{getFriendlyError(typeof interview?.error === 'string' ? interview.error : (interview?.error?.message || 'Unknown Technical Error'))}</p>
          <div className="pt-4">
             <button 
              onClick={handleRetry}
              className="px-4 py-2 bg-danger text-white rounded font-bold text-sm hover:bg-danger/90 transition-colors"
            >
              Retry Analysis
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            {/* Dimension Breakdown */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
                <ShieldCheck size={20} className="text-accent" />
                Dimension Breakdown
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {result.dimension_breakdown.map((dim, i) => (
                  <div key={i} className="card p-5 space-y-3 hover:border-accent/20 transition-colors">
                    <div className="flex justify-between items-start">
                      <h4 className="font-bold text-text-primary text-sm tracking-tight">{dim.dimension}</h4>
                      <span className={cn(
                        "text-sm font-black tracking-tighter",
                        (dim.score > 10 ? dim.score / 10 : dim.score) >= 8 ? "text-success" : (dim.score > 10 ? dim.score / 10 : dim.score) >= 6 ? "text-accent" : "text-danger"
                      )}>{formatScore(dim.score)}/10</span>
                    </div>
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">{dim.reason}</p>
                    <div className="h-1 w-full bg-border/30 rounded-full overflow-hidden">
                      <div 
                        className={cn(
                           "h-full transition-all duration-1000",
                           (dim.score > 10 ? dim.score / 10 : dim.score) >= 8 ? "bg-success" : "bg-accent"
                        )} 
                        style={{ width: `${(dim.score > 10 ? dim.score : dim.score * 10)}%` }} 
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Evidence Items */}
            <section className="space-y-4">
              <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
                <FileText size={20} className="text-accent" />
                Direct Evidence
              </h3>
              <div className="space-y-4">
                {(result as any).evidence_items?.map((item: any, i: number) => (
                  <div key={i} className="card p-6 bg-surface/50 border-l-4 border-l-accent relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-2 opacity-5">
                       <FileText size={64} />
                    </div>
                    <p className="italic text-text-primary leading-relaxed relative z-10">&ldquo;{item.quote}&rdquo;</p>
                    <div className="mt-4 flex items-center gap-3">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-accent bg-accent/5 px-2 py-0.5 rounded border border-accent/10">
                        {item.dimension}
                      </span>
                      <span className="text-[10px] font-medium text-text-muted truncate">
                        Context: {item.context}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="space-y-8">
            {/* Recommendation Card */}
            <div className="card p-6 bg-accent text-accent-foreground space-y-4">
              <div className="flex items-center justify-between">
                 <p className="text-[10px] font-bold uppercase tracking-widest opacity-80">Recommendation</p>
                 <TrendingUp size={20} />
              </div>
              <h3 className="text-3xl font-black tracking-tight leading-none uppercase">{result.recommendation}</h3>
              <div className="pt-4 border-t border-accent-foreground/20 space-y-3">
                 <div className="flex justify-between items-center text-xs font-medium">
                    <span className="opacity-80">JD Fit Score</span>
                    <span className="font-bold">{result.jd_fit_score}%</span>
                 </div>
                 <div className="flex justify-between items-center text-xs font-medium">
                    <span className="opacity-80">Technical Depth</span>
                    <span className="font-bold">{result.technical_depth}/10</span>
                 </div>
                 <div className="flex justify-between items-center text-xs font-medium">
                    <span className="opacity-80">Analysis Confidence</span>
                    <span className="font-bold">{(result.confidence * 100).toFixed(0)}%</span>
                 </div>
              </div>
            </div>

            {/* Strengths & Areas for Review */}
            <div className="space-y-6">
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-success uppercase tracking-widest flex items-center gap-2">
                  <CheckCircle2 size={14} /> Key Strengths
                </h4>
                <ul className="space-y-2">
                  {result.strengths.map((s, i) => (
                    <li key={i} className="text-sm font-medium text-text-primary flex gap-2">
                      <span className="text-success">•</span> {s}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-bold text-danger uppercase tracking-widest flex items-center gap-2">
                  <AlertCircle size={14} /> Areas for Review
                </h4>
                <ul className="space-y-2">
                  {(result as any).areas_for_review?.map((c: string, i: number) => (
                    <li key={i} className="text-sm font-medium text-text-primary flex gap-2">
                      <span className="text-danger">•</span> {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card p-6 space-y-3 border-border">
               <h4 className="text-xs font-bold text-text-muted uppercase tracking-widest">Executive Summary</h4>
               <p className="text-sm text-text-primary leading-relaxed font-medium">
                 {(result as any).executive_summary}
               </p>
            </div>
            
             <div className="card p-6 space-y-3 border-border bg-blue-50/10">
               <h4 className="text-xs font-bold text-text-muted uppercase tracking-widest">Final Note</h4>
               <p className="text-sm text-text-primary italic leading-relaxed">
                 {(result as any).final_recommendation_note}
               </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CheckItem({ label, done, warn }: { label: string, done: boolean, warn?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className={cn(
         "w-4 h-4 rounded-full flex items-center justify-center shrink-0",
         done ? "bg-success text-white" : warn ? "bg-danger text-white" : "border-2 border-border"
      )}>
         {done ? <CheckCircle2 size={10} /> : warn ? <AlertCircle size={10} /> : null}
      </div>
      <span className={cn("text-xs font-semibold uppercase tracking-tight", done ? "text-text-primary" : "text-text-muted")}>
         {label}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: any = {
    CREATED: "text-text-muted border-border bg-surface/30",
    FILES_UPLOADED: "text-blue-600 bg-blue-50/50 border-blue-100 dark:text-blue-400 dark:bg-blue-900/10 dark:border-blue-900/30",
    QUEUED: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30",
    PROCESSING: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30 animate-pulse",
    COMPLETED: "text-green-600 bg-green-50/50 border-green-100 dark:text-green-400 dark:bg-green-900/10 dark:border-green-900/30",
    FAILED: "text-red-600 bg-red-50/50 border-red-100 dark:text-red-400 dark:bg-red-900/10 dark:border-red-900/30",
  };

  return (
    <span className={cn(
      "px-3 py-1 rounded text-[10px] font-bold border uppercase tracking-widest",
      styles[status]
    )}>
      {status.replace('_', ' ')}
    </span>
  );
}

function FileUploadSection({ 
  type, 
  interviewId, 
  isUploaded, 
  onSuccess 
}: { 
  type: 'jd' | 'transcript', 
  interviewId: string, 
  isUploaded: boolean, 
  onSuccess: () => void 
}) {
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      
      // Get Presigned URL
      const { upload_url, s3_key } = await api.getUploadUrl(
        interviewId, 
        type, 
        file.name.split('.').pop() || 'txt',
        file.type
      );

      // Upload to S3
      await fetch(upload_url, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type }
      });

      // Confirm with Backend
      await api.confirmUpload(interviewId, type, s3_key);
      
      // Reset input value so same file can be uploaded again if needed
      e.target.value = '';
      
      onSuccess();
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`);
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={cn(
      "card p-5 border-dashed flex flex-col items-center justify-center gap-3 transition-all",
      isUploaded ? "bg-success/5 border-success/30 shadow-inner" : "bg-surface/50 border-border hover:border-accent/40"
    )}>
      <div className={cn(
        "p-3 rounded-full shrink-0",
        isUploaded ? "bg-success/10 text-success" : "bg-accent/5 text-accent"
      )}>
        {isUploaded ? <CheckCircle2 size={24} /> : <FileText size={24} />}
      </div>
      
      <div className="text-center">
        <p className="text-sm font-bold text-text-primary uppercase tracking-tight">
          {type === 'jd' ? 'Job Description' : 'Interview Transcript'}
        </p>
        <p className="text-[10px] text-text-muted font-medium mt-0.5">
          {isUploaded ? 'File Ready' : 'Awaiting Upload'}
        </p>
      </div>

      <div className="flex flex-col gap-2 w-full mt-2">
        {uploading ? (
          <div className="flex items-center justify-center gap-2 py-2 text-xs font-bold text-accent animate-pulse">
            <Loader2 size={14} className="animate-spin" />
            Uploading...
          </div>
        ) : (
          <>
            <input 
              type="file" 
              id={`file-${type}`} 
              className="hidden" 
              onChange={handleFileChange}
              accept=".txt,.pdf,.docx"
            />
            {isUploaded ? (
              <label 
                htmlFor={`file-${type}`}
                className="w-full py-2 rounded-md bg-surface border border-success/30 text-success text-[10px] font-bold uppercase tracking-widest text-center cursor-pointer hover:bg-success hover:text-white transition-all shadow-sm"
              >
                Replace File
              </label>
            ) : (
              <label 
                htmlFor={`file-${type}`}
                className="w-full py-2 rounded-md bg-accent text-accent-foreground text-[10px] font-bold uppercase tracking-widest text-center cursor-pointer hover:translate-y-[-1px] transition-all shadow"
              >
                Upload File
              </label>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function InterviewDetails() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="animate-spin text-accent" size={40} /></div>}>
      <InterviewDetailsContent />
    </Suspense>
  );
}
