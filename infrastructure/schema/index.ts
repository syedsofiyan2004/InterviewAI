import { z } from 'zod';

export const InterviewStatus = z.enum([
  'CREATED',
  'FILES_UPLOADED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
]);

export type InterviewStatus = z.infer<typeof InterviewStatus>;

export const CreateInterviewSchema = z.object({
  candidate_name: z.string().min(1),
  position: z.string().min(1),
  interview_date: z.string().datetime(),
  model_id: z.string().optional(),
});

export const UploadUrlSchema = z.object({
  file_type: z.enum(['transcript', 'jd']),
  file_name: z.string().min(1),
  content_type: z.string().regex(/^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/),
});

export const ConfirmUploadSchema = z.object({
  file_type: z.enum(['transcript', 'jd']),
  s3_key: z.string().min(1),
});


export const InterviewRecordSchema = z.object({
  interview_id: z.string().uuid(),
  status: InterviewStatus,
  created_at: z.number(),
  updated_at: z.number(),
  metadata: CreateInterviewSchema,
  transcript_s3_key: z.string().optional(),
  jd_s3_key: z.string().optional(),
  result_s3_key: z.string().optional(),
  report_s3_key: z.string().optional(),
  model_id: z.string().optional(),
  overall_score: z.number().optional(),
  recommendation: z.string().optional(),
  confidence: z.number().optional(),
  coverage_percent: z.number().optional(),
  inferred_role: z.string().optional(),
  is_mismatched: z.boolean().optional(),
  alignment_reason: z.string().optional(),
  error_message: z.string().optional(),
});

export type InterviewRecord = z.infer<typeof InterviewRecordSchema>;

export const ErrorCode = z.enum([
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'UPLOAD_ERROR',
  'EVALUATION_FAILED',
  'INTERNAL_ERROR',
  'ACCESS_DENIED',
  'AI_EMPTY_RESPONSE',
  'AI_MALFORMED_OUTPUT',
  'JD_RESULT_VALIDATION_FAILED',
  'FINAL_RESULT_VALIDATION_FAILED'
]);

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.any().optional(),
  }),
});

export const DetailedEvaluationResultSchema = z.object({
  overall_score: z.number().min(0).max(10),
  recommendation: z.enum(['Strong Hire', 'Hire', 'Maybe', 'No Hire', 'Strong No Hire']),
  confidence: z.number().min(0).max(100),
  coverage_percent: z.number().min(0).max(100),
  dimension_breakdown: z.array(z.object({
    dimension: z.string(),
    score: z.number().min(0).max(10),
    reason: z.string(),
    evidence_found: z.boolean(),
  })),
  strengths: z.array(z.string()).max(10),
  areas_for_review: z.array(z.string()).max(10),
  evidence_items: z.array(z.object({
    quote: z.string(),
    context: z.string(),
    dimension: z.string(),
  })).max(10),
  executive_summary: z.string(),
  final_recommendation_note: z.string(),
  technical_depth: z.number().min(0).max(10).optional(),
  jd_fit_score: z.number().min(0).max(100).optional(),
  experience_level: z.string().optional(),
  fit_gap_analysis: z.array(z.object({
    requirement: z.string(),
    fit: z.enum(['Strong', 'Partial', 'Gap']),
    evidence: z.string(),
  })).max(12).optional(),
});

export type DetailedEvaluationResult = z.infer<typeof DetailedEvaluationResultSchema>;

