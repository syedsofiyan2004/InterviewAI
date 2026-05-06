'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
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
  Download,
  ArrowRight
} from 'lucide-react';
import Link from 'next/link';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, type ToastType } from '@/components/ui/Toast';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useTour, checkTourStatus } from '@/contexts/TourContext';

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const { startTour } = useTour();
  const startedToursRef = useRef<Set<string>>(new Set());

  const getFriendlyError = (err: string) => {
    if (err.includes('AI_MALFORMED_OUTPUT')) return "The AI had trouble formatting the result. This often happens if the transcript is very messy. Please try clicking 'Retry Analysis'.";
    if (err.includes('JD_RESULT_VALIDATION_FAILED')) return "Job Description Rubric Validation Failed. The AI logic was unable to build a valid evaluation framework from your document. Please verify the JD content.";
    if (err.includes('FINAL_RESULT_VALIDATION_FAILED')) return "Final Evaluation Result Validation Failed. The AI analysis returned a contract mismatch. Please retry or contact support if the issue persists.";
    if (err.includes('JD_EXTRACTION_FAILED')) return "We couldn't read the Job Description. Please ensure it is a valid PDF or Word document.";
    if (err.includes('TRANSCRIPT_EXTRACTION_FAILED')) return "We couldn't read the Interview Transcript. Please ensure the file is not corrupted.";
    return err;
  };

  const formatScore = (score: number | undefined) => {
    if (score === undefined || score === null) return '0.0';
    return score.toFixed(1);
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
    try {
      setLoading(true);
      await api.deleteInterview(id);
      router.push('/interviews');
    } catch (err) {
      setToast({ message: 'Failed to delete interview', type: 'error' });
      setLoading(false);
    } finally {
      setShowDeleteConfirm(false);
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
      setToast({ message: 'Failed to download report', type: 'error' });
    }
  };

  const handleManualAnalyze = async () => {
    try {
      setLoading(true);
      await api.analyzeInterview(id);
      fetchInterview(); 
    } catch (err: any) {
      setToast({ message: err.message || 'Failed to start analysis', type: 'error' });
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
      setToast({ message: 'Failed to restart analysis', type: 'error' });
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

  useEffect(() => {
    if (!interview || loading) return;

    const tourKey = result
      ? 'interviews-view-results'
      : interview.status === 'QUEUED' || interview.status === 'PROCESSING'
        ? 'interviews-view-processing'
        : 'interviews-view-setup';

    if (startedToursRef.current.has(tourKey)) return;
    startedToursRef.current.add(tourKey);

    const timer = setTimeout(async () => {
      const done = await checkTourStatus(tourKey);
      if (done) return;

      if (tourKey === 'interviews-view-results') {
        startTour([
          {
            targetId: 'tour-result-header',
            title: 'Evaluation summary',
            body: 'This area shows the candidate, role, status, and the final score once analysis is complete.',
            position: 'bottom',
          },
          {
            targetId: 'tour-download-report',
            title: 'Download the PDF report',
            body: 'Use this button to download the shareable interview evaluation report.',
            position: 'left',
          },
          {
            targetId: 'tour-dimensions',
            title: 'Dimension breakdown',
            body: 'Each score is based on evidence found in the transcript against the job description.',
            position: 'top',
          },
          {
            targetId: 'tour-evidence',
            title: 'Direct evidence',
            body: 'These quotes explain why the system reached its scoring decisions.',
            position: 'top',
          },
          {
            targetId: 'tour-recommendation',
            title: 'Recommendation panel',
            body: 'Review the final recommendation, fit score, technical depth, confidence, strengths, and risk areas here.',
            position: 'left',
          },
        ], tourKey);
        return;
      }

      if (tourKey === 'interviews-view-processing') {
        startTour([
          {
            targetId: 'tour-processing',
            title: 'Analysis in progress',
            body: 'The evaluation runs in the background. This page refreshes automatically until results are ready.',
            position: 'bottom',
          },
        ], tourKey);
        return;
      }

      startTour([
        {
          targetId: 'tour-document-enrollment',
          title: 'Upload required documents',
          body: 'Upload the job description and interview transcript. Both are required before analysis can start.',
          position: 'bottom',
        },
        {
          targetId: 'tour-jd-upload-view',
          title: 'Job description',
          body: 'This file defines the role, requirements, and scoring rubric for the evaluation.',
          position: 'bottom',
        },
        {
          targetId: 'tour-transcript-upload-view',
          title: 'Interview transcript',
          body: 'Upload the full interview conversation so the evaluation can cite direct evidence.',
          position: 'bottom',
        },
        {
          targetId: 'tour-readiness-gate',
          title: 'Readiness gate',
          body: 'This checklist confirms whether the required documents are present and aligned.',
          position: 'left',
        },
        {
          targetId: 'tour-start-assessment',
          title: 'Start assessment',
          body: 'Once the checklist is ready, start the AI evaluation from here.',
          position: 'top',
        },
      ], tourKey);
    }, 900);

    return () => clearTimeout(timer);
  }, [interview, loading, result, startTour]);

  if (loading && !interview) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="animate-spin text-accent" size={40} />
        <p className="text-text-secondary font-normal tracking-tight">Loading evaluation details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto mt-20 card p-8 text-center space-y-6">
        <div className="w-16 h-16 bg-danger/10 text-danger rounded-full flex items-center justify-center mx-auto">
          <AlertCircle size={32} />
        </div>
        <h3 className="text-xl font-semibold text-text-primary">Failed to load</h3>
        <p className="text-text-secondary">{error}</p>
        <Link href="/interviews" className="inline-block px-6 py-2 bg-accent text-accent-foreground font-semibold rounded-md">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const isInFlight = interview?.status === 'QUEUED' || interview?.status === 'PROCESSING';

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <Link href="/interviews" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-xs font-normal">
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-text-muted">Status</span>
            <StatusBadge status={interview?.status || 'CREATED'} variant="pill" />
          </div>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1.5 rounded-md text-text-muted hover:text-red-500 transition-all border border-border/50 hover:bg-red-50 hover:border-red-100"
            title="Delete Interview"
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <header id="tour-result-header" className="space-y-4">
        <div className="flex items-end justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-text-primary">{interview?.metadata.candidate_name}</h1>
            <p className="text-base text-text-secondary">{interview?.metadata.position}</p>
          </div>
          
          {result && interview?.report_s3_key && (
            <div className="flex items-center gap-4">
              <button
                id="tour-download-report"
                onClick={handleDownloadReport}
                className="flex items-center gap-2 bg-accent text-accent-foreground px-4 py-2 rounded-lg font-semibold text-sm hover:opacity-90 transition-all shadow-lg shadow-accent/20"
              >
                <Download size={18} />
                Download PDF Report
              </button>
              <div className="h-8 w-px bg-border mx-2" />
              <div className="text-right">
                <p className="text-xs font-semibold text-text-muted mb-1">Overall Rating</p>
                <div className="text-4xl font-semibold text-accent leading-none">
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
          <div id="tour-document-enrollment" className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                 <FileText size={20} className="text-accent" />
                 1. Document Enrollment
              </h3>
              {interview?.jd_s3_key && interview?.transcript_s3_key && (
                 <span className="px-2 py-0.5 bg-success/10 text-success text-[10px] font-semibold rounded uppercase">Verified</span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FileUploadSection 
                   id="tour-jd-upload-view"
                   type="jd" 
                   interviewId={id} 
                   isUploaded={!!interview?.jd_s3_key} 
                   onSuccess={fetchInterview} 
                   setToast={setToast}
                />
                <FileUploadSection 
                   id="tour-transcript-upload-view"
                   type="transcript" 
                   interviewId={id} 
                   isUploaded={!!interview?.transcript_s3_key} 
                   onSuccess={fetchInterview} 
                   setToast={setToast}
                />
            </div>
          </div>

          <div id="tour-readiness-gate" className="space-y-6">
            <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
               <ShieldCheck size={20} className="text-accent" />
               2. Readiness Gate
            </h3>
            <div className={cn(
               "card p-6 space-y-6 border-2 transition-all shadow-sm",
               (interview?.is_mismatched && !!interview?.inferred_role) ? "border-danger/30 bg-danger/5" : "border-border bg-surface/50"
            )}>
               <div className="space-y-3">
                  <p className="text-xs font-semibold text-text-muted mb-2">Checklist</p>
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
                          <p className="text-xs font-semibold text-text-muted">Position</p>
                          <p className="text-sm font-semibold text-text-primary">{interview?.metadata.position}</p>
                       </div>
                       <div className="space-y-1">
                          <p className="text-xs font-semibold text-text-muted">Detected Candidate Context</p>
                          <p className="text-sm font-semibold text-accent italic">{interview?.inferred_role || 'Analyzing...'}</p>
                       </div>
                    </div>
                    {interview?.is_mismatched && !!interview?.inferred_role && (
                       <div className="p-3 bg-danger/10 border border-danger/20 rounded text-xs text-danger font-semibold leading-relaxed">
                          Role Mismatch Warning: The detected JD context differs from your target position. Please verify uploads.
                       </div>
                    )}
                  </div>
               )}

               {/* Intelligent Guidance Section */}
               <div className="p-4 rounded-lg bg-accent/5 border border-accent/10 space-y-2">
                  <p className="text-xs font-semibold text-accent flex items-center gap-1.5">
                     <Target size={12} />
                     AI Assistant Guidance
                  </p>
                   <p className="text-xs text-text-secondary leading-relaxed font-normal">
                      {!interview?.jd_s3_key ? "First, upload the Job Description to baseline the evaluation rubric." : 
                       !interview?.transcript_s3_key ? "Great, now upload the Interview Transcript to begin the technical deep-dive." :
                       !interview?.inferred_role ? "AI is currently verifying the document alignment. Please wait a moment..." :
                       interview?.is_mismatched ? `Alignment Blocked: ${(interview as any).alignment_reason || 'JD/Role mismatch detected.'}` :
                       "Everything looks aligned. You can now start the AI evaluation to generate the Bar-Raiser report."}
                   </p>
               </div>

               <button
                  id="tour-start-assessment"
                  onClick={handleManualAnalyze}
                  disabled={!interview?.jd_s3_key || !interview?.transcript_s3_key || loading || (interview as any).is_mismatched}
                  className="w-full py-4 bg-accent text-accent-foreground font-semibold uppercase tracking-widest text-xs rounded-lg hover:opacity-90 disabled:opacity-30 transition-all flex items-center justify-center gap-2 shadow-xl shadow-accent/20"
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
        <div id="tour-processing" className="card p-12 text-center space-y-6">
          <div className="relative w-20 h-20 mx-auto">
             <div className="absolute inset-0 rounded-full border-4 border-accent/20 border-t-accent animate-spin" />
             <div className="absolute inset-0 flex items-center justify-center text-accent">
                <Target size={32} />
             </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-2xl font-semibold text-text-primary tracking-tight">AI Analysis in Progress</h3>
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
            <h3 className="text-lg font-semibold uppercase tracking-tight">Technical Issue Detected</h3>
          </div>
          <p className="text-text-secondary font-normal leading-relaxed">{getFriendlyError(typeof interview?.error === 'string' ? interview.error : (interview?.error?.message || 'Unknown Technical Error'))}</p>
          <div className="pt-4">
             <button 
              onClick={handleRetry}
              className="px-4 py-2 bg-danger text-white rounded font-semibold text-sm hover:bg-danger/90 transition-colors"
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
            <section id="tour-dimensions" className="space-y-4">
              <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <ShieldCheck size={20} className="text-accent" />
                Dimension Breakdown
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {result.dimension_breakdown.map((dim, i) => (
                  <div key={i} className="card p-5 space-y-3 hover:border-accent/20 transition-colors">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold text-text-primary text-sm tracking-tight">{dim.dimension}</h4>
                      <span className={cn(
                        "text-sm font-semibold tracking-tighter",
                        dim.score >= 7.5 ? "text-success" : dim.score >= 5.5 ? "text-accent" : "text-danger"
                      )}>{formatScore(dim.score)}/10</span>
                    </div>
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">{dim.reason}</p>
                    <div className="h-1 w-full bg-border/30 rounded-full overflow-hidden">
                      <div 
                        className={cn(
                           "h-full transition-all duration-1000",
                           dim.score >= 8 ? "bg-success" : "bg-accent"
                        )} 
                        style={{ width: `${dim.score * 10}%` }} 
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Evidence Items */}
            <section id="tour-evidence" className="space-y-4">
              <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <FileText size={20} className="text-accent" />
                Direct Evidence
              </h3>
              <div className="space-y-4">
                {(result as any).evidence_items?.map((item: any, i: number) => (
                  <div key={i} className="card p-6 bg-surface/50 border-l-4 border-l-accent">
                    <p className="italic text-text-primary leading-relaxed relative z-10">&ldquo;{item.quote}&rdquo;</p>
                    <div className="mt-4 flex items-center gap-3">
                      <span className="text-xs font-medium normal-case text-accent bg-accent/5 px-2 py-0.5 rounded border border-accent/10">
                        {item.dimension}
                      </span>
                      <span className="text-xs font-normal text-text-secondary">
                        Context: {item.context}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div id="tour-recommendation" className="space-y-8">
            {/* Recommendation Card */}
            <div className="card p-6 bg-surface-elevated text-text-primary border-2 border-accent space-y-4">
              <div className="flex items-center justify-between">
                 <p className="text-xs font-normal text-text-secondary">Recommendation</p>
                 <TrendingUp size={20} className="text-accent" />
              </div>
              <h3 className="text-2xl font-semibold tracking-tight leading-none">{result.recommendation}</h3>
              <div className="pt-4 border-t border-border space-y-3">
                 <div className="flex justify-between items-center text-xs font-normal">
                    <span className="text-text-secondary">JD Fit Score</span>
                    <span className="font-semibold text-text-primary">{result.jd_fit_score}%</span>
                 </div>
                 <div className="flex justify-between items-center text-xs font-normal">
                    <span className="text-text-secondary">Technical Depth</span>
                    <span className="font-semibold text-text-primary">{result.technical_depth}/10</span>
                 </div>
                 <div className="flex justify-between items-center text-xs font-normal">
                    <span className="text-text-secondary">Analysis Confidence</span>
                    <span className="font-semibold text-text-primary">
                      {result.confidence <= 1 
                        ? (result.confidence * 100).toFixed(0) 
                        : result.confidence.toFixed(0)}%
                    </span>
                 </div>
              </div>
            </div>

            {/* Strengths & Areas for Review */}
            <div className="space-y-6">
              <div className="space-y-3">
                <h4 className="text-xs font-normal text-success flex items-center gap-2">
                  <CheckCircle2 size={14} /> Key Strengths
                </h4>
                <ul className="space-y-2">
                  {result.strengths.map((s, i) => (
                    <li key={i} className="text-sm font-normal text-text-primary flex gap-2">
                      <span className="text-success">•</span> {s}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-normal text-danger flex items-center gap-2">
                  <AlertCircle size={14} /> Areas for Review
                </h4>
                <ul className="space-y-2">
                  {(result as any).areas_for_review?.map((c: string, i: number) => (
                    <li key={i} className="text-sm font-normal text-text-primary flex gap-2">
                      <span className="text-danger">•</span> {c}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card p-6 space-y-3 border-border">
               <h4 className="text-xs font-normal text-text-muted">Executive Summary</h4>
               <p className="text-sm text-text-primary leading-relaxed font-normal">
                 {(result as any).executive_summary}
               </p>
            </div>
            
             <div className="card p-6 space-y-3 border-border bg-blue-50/10">
               <h4 className="text-xs font-normal text-text-muted">Final Note</h4>
               <p className="text-sm text-text-primary italic leading-relaxed">
                 {(result as any).final_recommendation_note}
               </p>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog 
        isOpen={showDeleteConfirm}
        title="Delete Interview"
        description={`Are you sure you want to delete the interview for ${interview?.metadata.candidate_name}?`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />

      {toast && (
        <Toast 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(null)} 
        />
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
      <span className={cn("text-xs font-normal text-text-muted", done ? "text-text-primary" : "text-text-muted")}>
         {label}
      </span>
    </div>
  );
}


function FileUploadSection({ 
  id,
  type, 
  interviewId, 
  isUploaded, 
  onSuccess,
  setToast
}: { 
  id?: string,
  type: 'jd' | 'transcript', 
  interviewId: string, 
  isUploaded: boolean, 
  onSuccess: () => void,
  setToast: (toast: { message: string, type: ToastType } | null) => void
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
      setToast({ message: `Upload failed: ${err.message}`, type: 'error' });
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  };

  return (
    <div id={id} className={cn(
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
        <p className="text-sm font-semibold text-text-primary uppercase tracking-tight">
          {type === 'jd' ? 'Job Description' : 'Interview Transcript'}
        </p>
        <p className="text-[10px] text-text-muted font-normal mt-0.5">
          {isUploaded ? 'File Ready' : 'Awaiting Upload'}
        </p>
      </div>

      <div className="flex flex-col gap-2 w-full mt-2">
        {uploading ? (
          <div className="flex items-center justify-center gap-2 py-2 text-xs font-semibold text-accent animate-pulse">
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
                className="w-full py-2 rounded-md bg-surface border border-success/30 text-success text-[10px] font-semibold uppercase tracking-widest text-center cursor-pointer hover:bg-success hover:text-white transition-all shadow-sm"
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
