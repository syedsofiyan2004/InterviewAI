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

const AttendeeSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  organisation: z.string().optional(),
});

const AttendeeInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const dashMatch = value.match(/^(.+?)\s+-\s+(.+)$/);
  if (!dashMatch) return { name: value, role: undefined, organisation: undefined };
  const [, name, roleAndOrg] = dashMatch;
  const parts = roleAndOrg.split('/').map(part => part.trim()).filter(Boolean);
  return { name: name.trim(), role: parts[0], organisation: parts.slice(1).join(' / ') || undefined };
}, AttendeeSchema);

const DecisionSchema = z.object({
  decision: z.string(),
  rationale: z.string().optional(),
  decided_by: z.string().optional(),
});

const DecisionInputSchema = z.preprocess((value) => (
  typeof value === 'string' ? { decision: value } : value
), DecisionSchema);

const ActionItemSchema = z.object({
  owner: z.string(),
  task: z.string(),
  due_date: z.string(),
  priority: z.enum(['High', 'Medium', 'Low']).default('Medium'),
});

const RiskSchema = z.object({
  description: z.string(),
  likelihood: z.enum(['H', 'M', 'L']).default('M'),
  impact: z.enum(['H', 'M', 'L']).default('M'),
  owner: z.string().optional(),
  mitigation: z.string().optional(),
  category: z.string().optional(),
});

const RiskInputSchema = z.preprocess((value) => (
  typeof value === 'string'
    ? { description: value, likelihood: 'M', impact: 'M', mitigation: 'To be determined' }
    : value
), RiskSchema);

const DiscussionPointSchema = z.object({
  topic: z.string(),
  raised_by: z.string().optional(),
  summary: z.string(),
  decisions: z.array(DecisionInputSchema).default([]),
  action_items: z.array(ActionItemSchema).default([]),
});

const NextMeetingSchema = z.object({
  date: z.string().optional(),
  purpose: z.string().optional(),
  proposed_agenda: z.string().optional(),
  prep_required: z.string().optional(),
});

const PreviousActionSchema = z.object({
  ref: z.string().optional(),
  action: z.string(),
  owner: z.string().optional(),
  status: z.string().optional(),
});

export const MomResultSchema = z.object({
  title: z.string(),
  date: z.string(),
  overall_summary: z.string(),
  attendees: z.array(AttendeeInputSchema),
  agenda_items: z.array(z.string()),
  discussion_points: z.array(DiscussionPointSchema),
  risks: z.array(RiskInputSchema),
  next_steps: z.array(z.string()),
  reference_no: z.string().optional(),
  report_type: z.string().optional(),
  platform: z.string().optional(),
  duration: z.string().optional(),
  workstream: z.string().optional(),
  facilitator: z.string().optional(),
  scribe: z.string().optional(),
  distribution: z.string().optional(),
  issued_date: z.string().optional(),
  next_meeting: NextMeetingSchema.optional(),
  previous_actions: z.array(PreviousActionSchema).default([]),
});

export type MomResult = z.infer<typeof MomResultSchema>;
