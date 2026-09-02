'use client';

import { useState, useEffect, useCallback, Suspense, useRef, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, DetailedInterview, EvaluationResult, InterviewQuestionGuide } from '@/lib/api';
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
  ArrowRight,
  BookOpenCheck,
  ChevronDown,
  RefreshCw,
  ClipboardList,
  MessageSquareText,
  Sparkles
} from 'lucide-react';
import Link from 'next/link';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, type ToastType } from '@/components/ui/Toast';
import { ContextChat } from '@/components/chat/ContextChat';
import { LiveProgressBanner } from '@/components/ui/LiveProgressBanner';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EvidenceCard } from '@/components/ui/EvidenceCard';
import { HeroNumber } from '@/components/ui/HeroNumber';
import { useTour, checkTourStatus } from '@/contexts/TourContext';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type EvaluationView = 'overview' | 'guide' | 'analysis' | 'report';

function InterviewDetailsContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') || '';
  const router = useRouter();
  const [interview, setInterview] = useState<DetailedInterview | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [guideLoading, setGuideLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const [selectedView, setSelectedView] = useState<EvaluationView | null>(null);
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
        setReportLoading(true);
        try {
          const fullResult = await api.getEvaluationResult(id);
          setResult(fullResult);
        } finally {
          setReportLoading(false);
        }
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

  const handlePrepareQuestionGuide = async () => {
    if (!interview?.jd_s3_key) return;
    try {
      setGuideLoading(true);
      const guide = await api.generateInterviewQuestionGuide(id);
      setInterview((current) => current ? { ...current, question_guide: guide } : current);
      setToast({
        message: guide.optimization_status === 'optimized'
          ? 'Interview guide prepared from the approved question bank and calibrated to the JD.'
          : 'Interview guide prepared from the approved question bank.',
        type: 'success',
      });
    } catch (err) {
      // The guide endpoint writes to DynamoDB before returning. If a browser or
      // gateway response is interrupted after that write, verify the record so
      // users never see a false failure beside a successfully prepared guide.
      try {
        const latest = await api.getInterview(id);
        if (latest.question_guide) {
          setInterview(latest);
          setToast({ message: 'Interview guide prepared successfully.', type: 'success' });
          return;
        }
      } catch {
        // Preserve the original request error when the verification request also fails.
      }
      setToast({ message: err instanceof Error ? err.message : 'Failed to prepare the interview guide', type: 'error' });
    } finally {
      setGuideLoading(false);
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
          body: 'Start with the job description. Add the resume if available, prepare the guide, then upload the transcript after the interview.',
          position: 'bottom',
        },
        {
          targetId: 'tour-jd-upload-view',
          title: 'Job description',
          body: 'This file defines the role, requirements, and scoring rubric for the evaluation.',
          position: 'bottom',
        },
        {
          targetId: 'tour-question-guide',
          title: 'Recommended interview guide',
          body: 'Prepare approved questions transformed into fair, scenario-based prompts for this role.',
          position: 'top',
        },
        {
          targetId: 'tour-transcript-upload-view',
          title: 'Interview transcript',
          body: 'Once the guide is ready, upload the full interview conversation so the evaluation can cite direct evidence.',
          position: 'bottom',
        },
        {
          targetId: 'tour-readiness-gate',
          title: 'Readiness gate',
          body: 'This checklist confirms that the guide, transcript, and role alignment are ready for evaluation.',
          position: 'left',
        },
        {
          targetId: 'tour-start-assessment',
          title: 'Start assessment',
          body: 'Once the checklist is ready, start the AI evaluation from here.',
          position: 'top',
        },
      ], tourKey);
    }, 300);

    return () => clearTimeout(timer);
  }, [interview, loading, result, startTour]);

  if (loading && !interview) {
    return (
      <InterviewDetailsSkeleton label="Loading evaluation details..." />
    );
  }

  if (reportLoading && interview?.status === 'COMPLETED') {
    return <InterviewDetailsSkeleton label="Loading the completed report..." />;
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
  const activeView: EvaluationView = selectedView ?? (
    result || isInFlight || interview?.status === 'FAILED' ? 'analysis' : 'overview'
  );
  const hasReport = !!result && !!interview?.report_s3_key;
  
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <BackButton defaultHref="/interviews" defaultLabel="Evaluations" />
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

      <header id="tour-result-header" className="card overflow-hidden">
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Interview evaluation</p>
            <h1 className="text-2xl font-semibold text-text-primary">{interview?.metadata.candidate_name}</h1>
            <p className="text-sm text-text-secondary">{interview?.metadata.position}</p>
          </div>
          
          {result && interview?.report_s3_key && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <button
                id="tour-download-report"
                onClick={handleDownloadReport}
                className="btn-primary inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
              >
                <Download size={18} />
                Download PDF Report
              </button>
              <HeroNumber value={formatScore(result.overall_score)} suffix="/10" label="Overall rating" />
            </div>
          )}
        </div>
      </header>

      <EvaluationViewTabs activeView={activeView} onChange={setSelectedView} />

      {activeView === 'overview' && (
        <div className="space-y-8" role="tabpanel" id="evaluation-overview-panel" aria-labelledby="evaluation-overview-tab">
          <InterviewWorkflowRail interview={interview} result={result} isInFlight={isInFlight} />

          {!isInFlight && interview && (
            <section id="tour-question-guide" className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <BookOpenCheck size={20} />
                </span>
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Interview guide</h2>
                  <p className="mt-1 text-sm leading-6 text-text-secondary">
                    {interview.question_guide
                      ? 'The approved question guide is ready for review before the interview.'
                      : 'Prepare the guide after adding the job description. It is not needed to upload a resume.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedView('guide')}
                className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
              >
                {interview.question_guide ? 'View guide' : 'Prepare guide'}
                <ArrowRight size={16} />
              </button>
            </section>
          )}

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
                   id="tour-resume-upload-view"
                   type="resume"
                   interviewId={id}
                   isUploaded={!!interview?.resume_s3_key}
                   onSuccess={fetchInterview}
                   setToast={setToast}
                />
                <FileUploadSection 
                   id="tour-transcript-upload-view"
                   type="transcript" 
                   interviewId={id} 
                   isUploaded={!!interview?.transcript_s3_key} 
                   disabled={!interview?.question_guide}
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
                  <CheckItem label="Question Guide Prepared" done={!!interview?.question_guide} />
                  <CheckItem label="Transcript Uploaded" done={!!interview?.transcript_s3_key} warn={!interview?.question_guide && !!interview?.transcript_s3_key} />
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
                      {!interview?.jd_s3_key ? "First, upload the Job Description to prepare the interview guide." :
                       !interview?.question_guide ? "The JD is ready. Prepare the approved question guide before adding the transcript." :
                       !interview?.transcript_s3_key ? "The guide is ready. Upload the interview transcript to begin the evaluation." :
                       !interview?.inferred_role ? "AI is currently verifying the document alignment. Please wait a moment..." :
                       interview?.is_mismatched ? `Alignment Blocked: ${(interview as any).alignment_reason || 'JD/Role mismatch detected.'}` :
                       "Everything looks aligned. You can now start the AI evaluation to generate the Bar-Raiser report."}
                   </p>
               </div>

               <button
                  id="tour-start-assessment"
                  onClick={handleManualAnalyze}
                  disabled={!interview?.jd_s3_key || !interview?.question_guide || !interview?.transcript_s3_key || loading || (interview as any).is_mismatched}
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

          {(result || isInFlight || interview?.status === 'FAILED') && (
            <EvaluationEmptyState
              icon={<ClipboardList size={20} />}
              title="Evaluation workspace"
              detail="Use the analysis view to follow the evaluation and open the report view when the PDF is available."
              actionLabel="Open analysis"
              onAction={() => setSelectedView('analysis')}
            />
          )}
        </div>
      )}

      {activeView === 'guide' && (
        <div className="space-y-6" role="tabpanel" id="evaluation-guide-panel" aria-labelledby="evaluation-guide-tab">
          {!isInFlight && interview ? (
            <QuestionGuideSection
              guide={interview.question_guide || null}
              canGenerate={!!interview.jd_s3_key}
              canRefresh={!interview.transcript_s3_key && !result}
              loading={guideLoading}
              onGenerate={handlePrepareQuestionGuide}
            />
          ) : (
            <EvaluationEmptyState
              icon={<BookOpenCheck size={20} />}
              title="Interview guide is locked"
              detail="The guide remains available once the current analysis finishes."
              actionLabel="View analysis"
              onAction={() => setSelectedView('analysis')}
            />
          )}
        </div>
      )}

      {activeView === 'analysis' && (
        <div className="space-y-8" role="tabpanel" id="evaluation-analysis-panel" aria-labelledby="evaluation-analysis-tab">
      {isInFlight && (
        <div id="tour-processing">
          <LiveProgressBanner
            taskType="analysis"
            title="AI Interview Analysis in Progress"
            subtitle="Amazon Bedrock is evaluating the candidate transcript against the job description and scoring rubric..."
            startTime={interview?.analysis_started_at}
            progressMessage={interview?.progress_message}
            progressStage={interview?.progress_stage}
            progressEvents={interview?.progress_events}
          />
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
            <InterviewExecutionSection execution={result.interview_execution} />
            {/* Dimension Breakdown */}
            <section id="tour-dimensions" className="space-y-4">
              <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                <ShieldCheck size={20} className="text-accent" />
                Dimension Breakdown
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {result.dimension_breakdown.map((dim, i) => (
                  <div key={i} className="metric-card p-5 space-y-3 hover:border-accent/40 transition-colors">
                    <div className="flex justify-between items-start">
                      <h4 className="font-semibold text-text-primary text-sm tracking-tight">{dim.dimension}</h4>
                      <span className={cn(
                        "text-sm font-semibold tracking-tighter",
                        dim.score >= 7.5 ? "text-success" : dim.score >= 5.5 ? "text-accent" : "text-danger"
                      )}>{formatScore(dim.score)}/10</span>
                    </div>
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">{dim.reason}</p>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/40">
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
                  <EvidenceCard
                    key={i}
                    title={item.dimension}
                    excerpt={item.quote}
                    source={item.context ? `Context: ${item.context}` : undefined}
                  />
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
            
             <div className="card p-6 space-y-3 border-border bg-accent/5">
               <h4 className="text-xs font-normal text-text-muted">Final Note</h4>
               <p className="text-sm text-text-primary italic leading-relaxed">
                 {(result as any).final_recommendation_note}
               </p>
            </div>
          </div>
        </div>
      )}

      {!result && !isInFlight && interview?.status !== 'FAILED' && (
        <EvaluationEmptyState
          icon={<Target size={20} />}
          title="Assessment is not ready yet"
          detail="Complete the document checklist and start the assessment from the overview when the interview transcript is ready."
          actionLabel="Open overview"
          onAction={() => setSelectedView('overview')}
        />
      )}
        </div>
      )}

      {activeView === 'report' && (
        <div role="tabpanel" id="evaluation-report-panel" aria-labelledby="evaluation-report-tab">
          {hasReport ? (
            <section className="card overflow-hidden">
              <div className="border-b border-border bg-surface px-6 py-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Shareable outcome</p>
                <h2 className="mt-1 text-xl font-semibold text-text-primary">Interview evaluation report</h2>
              </div>
              <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div>
                  <p className="text-sm leading-6 text-text-secondary">
                    The completed PDF includes the scorecard, recommendation, direct transcript evidence, strengths, and areas for review.
                  </p>
                  <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted">Candidate</dt>
                      <dd className="mt-1 text-sm font-semibold text-text-primary">{interview?.metadata.candidate_name}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-text-muted">Overall rating</dt>
                      <dd className="mt-1 text-sm font-semibold text-text-primary">{formatScore(result?.overall_score)} / 10</dd>
                    </div>
                  </dl>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadReport}
                  className="btn-primary inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold"
                >
                  <Download size={18} />
                  Download PDF report
                </button>
              </div>
            </section>
          ) : (
            <EvaluationEmptyState
              icon={<Download size={20} />}
              title="Report will appear here"
              detail={isInFlight
                ? 'The PDF becomes available as soon as the current analysis is complete.'
                : 'Complete the assessment first. The report is generated automatically from the final evaluation.'}
              actionLabel={isInFlight ? 'View analysis' : 'Open overview'}
              onAction={() => setSelectedView(isInFlight ? 'analysis' : 'overview')}
            />
          )}
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

      {/* Read-only by design — an evaluation is evidence, so the chat explains a score
          and has no tool to change one. See EVALUATION_RULES in the chat prompt. */}
      {id && interview?.status === 'COMPLETED' && (
        <ContextChat
          app="interview"
          entityId={id}
          title={interview?.metadata.candidate_name}
        />
      )}
    </div>
  );
}

function InterviewDetailsSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-8" aria-live="polite" aria-busy="true">
      <div className="h-4 w-36 animate-pulse rounded bg-surface-elevated" />
      <div className="space-y-3">
        <div className="h-8 w-72 animate-pulse rounded bg-surface-elevated" />
        <div className="h-4 w-52 animate-pulse rounded bg-surface-elevated" />
      </div>
      <div className="card p-5">
        <div className="flex items-center gap-3 text-sm font-semibold text-text-secondary">
          <Loader2 className="animate-spin text-accent" size={18} />
          {label}
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-16 animate-pulse rounded-lg bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}

function EvaluationViewTabs({
  activeView,
  onChange,
}: {
  activeView: EvaluationView;
  onChange: (view: EvaluationView) => void;
}) {
  const views: Array<{ id: EvaluationView; label: string; detail: string; icon: typeof ClipboardList }> = [
    { id: 'overview', label: 'Overview', detail: 'Files and readiness', icon: ClipboardList },
    { id: 'guide', label: 'Interview guide', detail: 'Questions and cues', icon: BookOpenCheck },
    { id: 'analysis', label: 'Analysis', detail: 'Evidence and decision', icon: Target },
    { id: 'report', label: 'Report', detail: 'Downloadable PDF', icon: Download },
  ];

  return (
    <nav className="card overflow-x-auto p-2" aria-label="Evaluation sections" role="tablist">
      <div className="flex min-w-max gap-1">
        {views.map((view) => {
          const Icon = view.icon;
          const selected = activeView === view.id;
          return (
            <button
              key={view.id}
              id={`evaluation-${view.id}-tab`}
              type="button"
              role="tab"
              aria-controls={`evaluation-${view.id}-panel`}
              aria-selected={selected}
              onClick={() => onChange(view.id)}
              className={cn(
                'flex min-w-[150px] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                selected
                  ? 'bg-accent text-accent-foreground'
                  : 'text-text-secondary hover:bg-surface hover:text-text-primary',
              )}
            >
              <Icon size={17} className={selected ? 'text-accent-foreground' : 'text-accent'} />
              <span>
                <span className="block text-sm font-semibold">{view.label}</span>
                <span className={cn('mt-0.5 block text-[11px]', selected ? 'text-accent-foreground/80' : 'text-text-muted')}>
                  {view.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function EvaluationEmptyState({
  icon,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <section className="card flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface text-accent">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-text-secondary">{detail}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onAction}
        className="btn-secondary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"
      >
        {actionLabel}
        <ArrowRight size={16} />
      </button>
    </section>
  );
}

function InterviewWorkflowRail({
  interview,
  result,
  isInFlight,
}: {
  interview: DetailedInterview | null;
  result: EvaluationResult | null;
  isInFlight: boolean;
}) {
  const steps = [
    {
      label: 'Context',
      detail: 'JD and resume',
      done: !!interview?.jd_s3_key,
      icon: ClipboardList,
    },
    {
      label: 'Guide',
      detail: 'Scenario questions',
      done: !!interview?.question_guide,
      icon: BookOpenCheck,
    },
    {
      label: 'Transcript',
      detail: 'Interview conversation',
      done: !!interview?.transcript_s3_key,
      icon: MessageSquareText,
    },
    {
      label: 'Review',
      detail: isInFlight ? 'Analysis in progress' : 'Evidence and report',
      done: !!result,
      icon: Sparkles,
    },
  ];

  const activeIndex = result
    ? 3
    : isInFlight
      ? 3
      : !interview?.jd_s3_key
        ? 0
        : !interview.question_guide
          ? 1
          : !interview.transcript_s3_key
            ? 2
            : 3;

  return (
    <section className="card p-3 sm:p-4" aria-label="Interview workflow progress">
      <div className="grid gap-2 sm:grid-cols-4">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const isActive = index === activeIndex;
          return (
            <div
              key={step.label}
              className={cn(
                'relative flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
                isActive ? 'bg-accent/10' : 'bg-surface/60',
              )}
            >
              <span className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                step.done ? 'bg-success/15 text-success' : isActive ? 'bg-accent text-accent-foreground' : 'bg-surface-elevated text-text-muted',
              )}>
                {step.done ? <CheckCircle2 size={16} /> : <Icon size={16} />}
              </span>
              <span className="min-w-0">
                <span className={cn('block truncate text-xs font-semibold', isActive ? 'text-text-primary' : 'text-text-secondary')}>
                  {step.label}
                </span>
                <span className="block truncate text-[11px] text-text-muted">{step.detail}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function QuestionGuideSection({
  guide,
  canGenerate,
  canRefresh,
  loading,
  onGenerate,
}: {
  guide: InterviewQuestionGuide | null;
  canGenerate: boolean;
  canRefresh: boolean;
  loading: boolean;
  onGenerate: () => void;
}) {
  const questionGroups = guide?.questions.reduce<Record<string, InterviewQuestionGuide['questions']>>((groups, question) => {
    const category = question.category || 'Interview questions';
    (groups[category] ||= []).push(question);
    return groups;
  }, {}) || {};

  return (
    <section id="tour-question-guide" className="card overflow-hidden">
      <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <BookOpenCheck size={20} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary">Recommended Interview Guide</h2>
              <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                Approved question bank
              </span>
              {/* Provenance, not decoration. `bank_only` means the model call that
                  calibrates the wording to this JD did not complete, so what is
                  shown is the bank's own text. The backend already reports which
                  one happened; without showing it, a fallback guide is
                  indistinguishable from a tailored one. */}
              {guide && (
                <span
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                    guide.optimization_status === 'optimized'
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-warning/30 bg-warning/10 text-warning'
                  }`}
                  title={
                    guide.optimization_status === 'optimized'
                      ? 'Question wording was calibrated to this job description by the AI.'
                      : 'The AI calibration step did not complete, so these are the approved bank questions as written. Regenerate to try again.'
                  }
                >
                  {guide.optimization_status === 'optimized' ? 'JD-calibrated' : 'Bank wording only'}
                </span>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-text-secondary">
              A structured guide built from the approved question bank, tailored to the role, level, job description, and optional resume. Each prompt is written to sound natural in a live interview.
            </p>
          </div>
        </div>

        {(!guide || canRefresh) && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canGenerate || loading}
            className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <RefreshCw size={16} className="animate-spin" /> : <BookOpenCheck size={16} />}
            {loading ? 'Preparing guide...' : guide ? 'Refresh interview guide' : 'Prepare interview guide'}
          </button>
        )}
      </div>

      {!guide && (
        <div className="border-t border-border bg-surface px-6 py-4">
          <p className="text-xs leading-5 text-text-muted">
            {canGenerate
              ? 'The role profile is ready. Prepare the guide to review scenario prompts, follow-ups, and the evidence to listen for.'
              : 'Add the job description first. A transcript is not needed to prepare the interview guide.'}
          </p>
        </div>
      )}

      {guide && (
        <div className="border-t border-border">
          <div className="grid gap-4 bg-surface px-6 py-4 sm:grid-cols-3">
            <GuideMetric label="Expected level" value={guide.detected_level} />
            <GuideMetric label="Questions selected" value={String(guide.questions.length)} />
            <GuideMetric
              label="Guide style"
              value="Interview-ready scenarios"
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-border px-6 py-4">
            {guide.focus_areas.map((area) => (
              <span key={area} className="rounded-full bg-accent/8 px-3 py-1 text-xs font-medium text-accent">
                {area}
              </span>
            ))}
          </div>

          <div className="space-y-6 border-t border-border px-6 py-6">
            {Object.entries(questionGroups).map(([category, questions]) => (
              <section key={category} className="overflow-hidden rounded-xl border border-border bg-surface-elevated">
                <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">{category}</p>
                    <p className="mt-0.5 text-xs text-text-muted">{questions.length} interview-ready {questions.length === 1 ? 'prompt' : 'prompts'}</p>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  {questions.map((item) => (
              <details key={item.id} className="group px-4 py-1">
                <summary className="flex cursor-pointer list-none items-start gap-4 py-4">
                  <span className="mt-0.5 font-mono text-xs font-semibold text-accent">{item.id}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                      {/*
                      Scenario question · {item.category} / {item.focus_area}
                      */}
                      Scenario prompt - {item.focus_area}
                    </p>
                    <p className="mt-1 text-sm font-semibold leading-6 text-text-primary">{item.question}</p>
                  </div>
                  <ChevronDown size={17} className="mt-1 shrink-0 text-text-muted transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-4 pb-5 pl-12">
                  <div className="rounded-lg border border-border bg-surface px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">Question purpose</p>
                    <p className="mt-1 text-xs leading-5 text-text-secondary">{item.source_question}</p>
                  </div>
                  <div className="grid gap-5 md:grid-cols-2">
                  <GuideList title="Suggested follow-ups" items={item.follow_ups} />
                  <GuideList title="What to listen for" items={item.what_to_listen_for} />
                  </div>
                </div>
              </details>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function InterviewExecutionSection({ execution }: { execution: EvaluationResult['interview_execution'] }) {
  if (!execution) return null;

  const qualityLabel = execution.panel_assessment.follow_up_quality.replace(/_/g, ' ');
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <ClipboardList size={20} className="text-accent" />
        <h3 className="text-lg font-semibold text-text-primary">Interview Execution Review</h3>
      </div>
      <div className="card p-5">
        <p className="text-sm leading-6 text-text-secondary">{execution.summary}</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <ExecutionMetric label="Panel quality" value={`${execution.panel_assessment.score.toFixed(1)} / 10`} />
          <ExecutionMetric label="Guide coverage" value={`${execution.panel_assessment.planned_question_coverage_percent}%`} />
          <ExecutionMetric label="Follow-ups" value={qualityLabel} />
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <ExecutionList title="What went well" items={execution.panel_assessment.observations} />
          <ExecutionList title="Areas to improve" items={execution.panel_assessment.missed_areas} muted />
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated">
        <table className="w-full min-w-[680px] text-left">
          <thead className="border-b border-border bg-surface">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Interviewer</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Questions</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Guide coverage</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Follow-up quality</th>
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Review note</th>
            </tr>
          </thead>
          <tbody>
            {execution.interviewer_evaluations.map((interviewer, index) => (
              <tr key={`${interviewer.name}-${index}`} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3 text-sm font-semibold text-text-primary">{interviewer.name}</td>
                <td className="px-4 py-3 text-sm text-text-secondary">{interviewer.questions_asked_count}</td>
                <td className="px-4 py-3 text-sm text-text-secondary">{interviewer.planned_question_coverage_percent}%</td>
                <td className="px-4 py-3 text-sm capitalize text-text-secondary">{interviewer.follow_up_quality.replace(/_/g, ' ')}</td>
                <td className="px-4 py-3 text-sm leading-6 text-text-secondary">{interviewer.observations[0] || 'No additional observation recorded.'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ExecutionMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold capitalize text-text-primary">{value}</p>
    </div>
  );
}

function ExecutionList({ title, items, muted = false }: { title: string; items: string[]; muted?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
      {items.length ? (
        <ul className="mt-2 space-y-2">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-sm leading-6 text-text-secondary">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${muted ? 'bg-text-muted' : 'bg-success'}`} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm leading-6 text-text-muted">No concerns were identified from the available transcript evidence.</p>
      )}
    </div>
  );
}

function GuideMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold capitalize text-text-primary">{value}</p>
    </div>
  );
}

function GuideList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold text-text-primary">{title}</p>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-xs leading-5 text-text-secondary">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
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
  disabled = false,
  onSuccess,
  setToast
}: { 
  id?: string,
  type: 'jd' | 'transcript' | 'resume',
  interviewId: string, 
  isUploaded: boolean, 
  disabled?: boolean,
  onSuccess: () => void,
  setToast: (toast: { message: string, type: ToastType } | null) => void
}) {
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || disabled) return;

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
      disabled ? "bg-surface/50 border-border opacity-60" :
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
          {type === 'jd' ? 'Job Description' : type === 'resume' ? 'Candidate Resume' : 'Interview Transcript'}
        </p>
        <p className="text-[10px] text-text-muted font-normal mt-0.5">
          {isUploaded ? 'File Ready' : 'Awaiting Upload'}
        </p>
      </div>

      <div className="flex flex-col gap-2 w-full mt-2">
        {disabled ? (
          <p className="py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-text-muted">
            Prepare the question guide first
          </p>
        ) : uploading ? (
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
