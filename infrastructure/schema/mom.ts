import { z } from 'zod';

export const MomStatus = z.enum([
  'CREATED',
  'PROCESSING',
  'COMPLETED',
  'FAILED'
]);

export type MomStatus = z.infer<typeof MomStatus>;

export const CreateMomProjectSchema = z.object({
  project_title: z.string().trim().min(1).max(120),
});

export const CreateMomSchema = z.object({
  title: z.string().trim().min(1).max(160),
  project_id: z.string().uuid().optional(),
  project_title: z.string().trim().min(1).max(120).optional(),
  source_type: z.enum(['file', 'text']),
  source_file_name: z.string().trim().min(1).max(240).optional(),
  source_last_modified: z.number().int().positive().optional(),
});

export const MomUploadUrlSchema = z.object({
  file_type: z.literal('transcript'),
  file_name: z.string().min(1),
  content_type: z.string().regex(/^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/),
});

export const ConfirmMomUploadSchema = z.object({
  file_type: z.literal('transcript'),
  s3_key: z.string().min(1),
});

export const MomRecordSchema = z.object({
  mom_id: z.string().uuid(),
  owner_user_id: z.string(),
  status: MomStatus,
  created_at: z.number(),
  updated_at: z.number(),
  title: z.string(),
  project_title: z.string(),
  source_type: z.enum(['file', 'text']),
  source_file_name: z.string().optional(),
  source_last_modified: z.number().optional(),
  meeting_date: z.string().optional(),
  meeting_date_sort: z.number().nullable().optional(),
  transcript_s3_key: z.string().optional(),
  result_s3_key: z.string().optional(),
  report_s3_key: z.string().optional(),
  error_message: z.string().optional(),
});

export type MomRecord = z.infer<typeof MomRecordSchema>;

export const MomResultSchema = z.object({
  title: z.string(),
  date: z.string(),
  attendees: z.array(z.string()),
  agenda_items: z.array(z.string()),
  discussion_points: z.array(z.object({
    topic: z.string(),
    summary: z.string(),
    decisions: z.array(z.string()),
    action_items: z.array(z.object({
      owner: z.string(),
      task: z.string(),
      due_date: z.string(),
    })),
  })),
  risks: z.array(z.string()),
  next_steps: z.array(z.string()),
  overall_summary: z.string(),
});

export type MomResult = z.infer<typeof MomResultSchema>;
