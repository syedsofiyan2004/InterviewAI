import { z } from 'zod';

/**
 * Admin Portal & Collaborative Workspace data model.
 *
 * All seven entities live in one dedicated DynamoDB table with a generic
 * `PK`/`SK` layout, matching the existing InterviewsTable convention (which
 * already colocates `INTERVIEW#…` and `USER#…/PREFERENCES` rows).
 *
 * Two independent authorization layers — never collapsed into one flag:
 *   Layer 1  Membership.base_role   MEMBER | ADMIN  (gates the Admin shell)
 *   Layer 2  AdminGrant.tier        VIEWER<REVIEWER<APPROVER<OWNER
 *                                    (only meaningful when base_role === 'ADMIN')
 *
 * Becoming ADMIN never implicitly creates an AdminGrant. No grant row means no
 * admin access of any kind — fail closed, never "default to viewer".
 */

// The single org this deployment serves. Fixed by design (no cross-org support).
export const DEFAULT_ORG_ID = 'minfy';

// ---------------------------------------------------------------------------
// Enums + tier ordering
// ---------------------------------------------------------------------------

export const BaseRole = z.enum(['MEMBER', 'ADMIN']);
export type BaseRole = z.infer<typeof BaseRole>;

export const AdminTier = z.enum(['VIEWER', 'REVIEWER', 'APPROVER', 'OWNER']);
export type AdminTier = z.infer<typeof AdminTier>;

/**
 * Ordered, cumulative tier ranks. This is the ONLY place ranks are defined;
 * `requireAdminTier` in authz.ts is the ONLY place they are compared.
 */
export const TIER_RANK = {
  VIEWER: 1,
  REVIEWER: 2,
  APPROVER: 3,
  OWNER: 4,
} as const satisfies Record<z.infer<typeof AdminTier>, number>;

export const SharePermission = z.enum(['VIEWER', 'COMMENTER']);
export type SharePermission = z.infer<typeof SharePermission>;

export const WorkspaceStatus = z.enum(['OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const DecisionType = z.enum(['APPROVED', 'REJECTED']);
export type DecisionType = z.infer<typeof DecisionType>;

// Kinds of records a CandidateWorkspace can group/link together.
export const LinkedRecordType = z.enum(['interview', 'mom', 'intelligence']);
export type LinkedRecordType = z.infer<typeof LinkedRecordType>;

// Audited actions. Extend here (not inline) so the audit vocabulary stays reviewable.
export const AuditAction = z.enum([
  'READ_INTERVIEW',
  'READ_MOM',
  'READ_INTELLIGENCE',
  'READ_REPORT',
  'DOWNLOAD_REPORT',
  'READ_WORKSPACE',
  'READ_AUDIT_LOG',
  'SEARCH',
  'SOFT_DELETE',
  'UPDATE_RECORD',
  'GRANT_TIER',
  'REVOKE_TIER',
  'CHANGE_BASE_ROLE',
  'APPROVE',
  'REJECT',
  'SHARE_ADD',
  'SHARE_REMOVE',
  'LIST_COGNITO_USERS',
  // Question bank curation — changes what every future interview asks, so each
  // edit is attributable.
  'QBANK_UPDATE',
  'QBANK_DELETE',
  // Keka schedule sync and the composite (multi-round) synthesis.
  'KEKA_SYNC',
  'COMPOSITE_ANALYSIS',
]);
export type AuditAction = z.infer<typeof AuditAction>;

// ---------------------------------------------------------------------------
// Sparse generic GSI attributes
// ---------------------------------------------------------------------------
//
// The admin table carries four sparse GSIs. Rows only appear in an index when
// they set that index's attributes, so each entity opts in explicitly rather
// than indexing directly on org_id/email (which both Membership and
// CandidateWorkspace carry and would otherwise pollute one another's indexes).
//
//   GSI1_OrgRecency     gsi1_pk = org_id            gsi1_sk = updated_at
//   GSI2_SharedWithUser gsi2_pk = shared_user_id    gsi2_sk = shared_at
//   GSI3_AuditActor     gsi3_pk = actor_user_id     gsi3_sk = ts
//   GSI4_MemberEmail    gsi4_pk = email             (no sort key)

const GsiAttributes = z.object({
  gsi1_pk: z.string().optional(),
  gsi1_sk: z.union([z.string(), z.number()]).optional(),
  gsi2_pk: z.string().optional(),
  gsi2_sk: z.union([z.string(), z.number()]).optional(),
  gsi3_pk: z.string().optional(),
  gsi3_sk: z.union([z.string(), z.number()]).optional(),
  gsi4_pk: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Entity: Membership   PK=ORG#minfy   SK=MEMBER#<userId>
// ---------------------------------------------------------------------------

export const MembershipSchema = z.object({
  PK: z.string(),                 // ORG#<orgId>
  SK: z.string(),                 // MEMBER#<userId>
  entity_type: z.literal('MEMBERSHIP'),
  org_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  base_role: BaseRole,
  created_at: z.number(),
  updated_at: z.number(),
  // GSI4 (email -> membership) is populated for every member.
  gsi4_pk: z.string().optional(),
}).and(GsiAttributes);
export type Membership = z.infer<typeof MembershipSchema>;

// ---------------------------------------------------------------------------
// Entity: AdminGrant   PK=USER#<userId>   SK=GRANT#<ts>   (append-only)
// ---------------------------------------------------------------------------
// Newest row with no revoked_at wins. Grants and revokes both append a row —
// never a silent field overwrite.

export const AdminGrantSchema = z.object({
  PK: z.string(),                 // USER#<userId>
  SK: z.string(),                 // GRANT#<ts>
  entity_type: z.literal('ADMIN_GRANT'),
  user_id: z.string(),
  email: z.string(),
  tier: AdminTier,
  granted_by: z.string(),         // userId of the granting OWNER, or 'SYSTEM_SEED'
  granted_at: z.number(),
  revoked_at: z.number().optional(),
  revoked_by: z.string().optional(),
  note: z.string().optional(),
}).and(GsiAttributes);
export type AdminGrant = z.infer<typeof AdminGrantSchema>;

// ---------------------------------------------------------------------------
// Entity: CandidateWorkspace   PK=WS#<wsId>   SK=META
// ---------------------------------------------------------------------------

export const LinkedRecordSchema = z.object({
  record_type: LinkedRecordType,
  record_id: z.string(),
  label: z.string().optional(),   // cached display label (candidate/position)
  linked_at: z.number(),
  linked_by: z.string(),
});
export type LinkedRecord = z.infer<typeof LinkedRecordSchema>;

export const CandidateWorkspaceSchema = z.object({
  PK: z.string(),                 // WS#<wsId>
  SK: z.literal('META'),
  entity_type: z.literal('CANDIDATE_WORKSPACE'),
  workspace_id: z.string(),
  org_id: z.string(),
  title: z.string().min(1),
  candidate_name: z.string().optional(),
  position: z.string().optional(),
  status: WorkspaceStatus,
  owner_user_id: z.string(),
  owner_email: z.string().optional(),
  linked_records: z.array(LinkedRecordSchema).default([]),
  created_at: z.number(),
  updated_at: z.number(),
  deleted_at: z.number().optional(),
  // GSI1 (org recency): gsi1_pk = org_id, gsi1_sk = updated_at
  gsi1_pk: z.string().optional(),
  gsi1_sk: z.union([z.string(), z.number()]).optional(),
}).and(GsiAttributes);
export type CandidateWorkspace = z.infer<typeof CandidateWorkspaceSchema>;

// ---------------------------------------------------------------------------
// Entity: WorkspaceShare   PK=WS#<wsId>   SK=SHARE#<userId>
// ---------------------------------------------------------------------------

export const WorkspaceShareSchema = z.object({
  PK: z.string(),                 // WS#<wsId>
  SK: z.string(),                 // SHARE#<userId>
  entity_type: z.literal('WORKSPACE_SHARE'),
  workspace_id: z.string(),
  shared_user_id: z.string(),
  shared_email: z.string().optional(),
  permission: SharePermission,
  shared_by: z.string(),
  shared_at: z.number(),
  // GSI2 (shared-with-me): gsi2_pk = shared_user_id, gsi2_sk = shared_at
  gsi2_pk: z.string().optional(),
  gsi2_sk: z.union([z.string(), z.number()]).optional(),
}).and(GsiAttributes);
export type WorkspaceShare = z.infer<typeof WorkspaceShareSchema>;

// ---------------------------------------------------------------------------
// Entity: Comment   PK=WS#<wsId>   SK=COMMENT#<ts>#<id>
// ---------------------------------------------------------------------------

export const CommentSchema = z.object({
  PK: z.string(),                 // WS#<wsId>
  SK: z.string(),                 // COMMENT#<ts>#<commentId>
  entity_type: z.literal('COMMENT'),
  workspace_id: z.string(),
  comment_id: z.string(),
  author_user_id: z.string(),
  author_email: z.string().optional(),
  body: z.string().min(1).max(5000),
  resolved: z.boolean().default(false),
  resolved_by: z.string().optional(),
  resolved_at: z.number().optional(),
  created_at: z.number(),
}).and(GsiAttributes);
export type Comment = z.infer<typeof CommentSchema>;

// ---------------------------------------------------------------------------
// Entity: ApprovalDecision   PK=WS#<wsId>   SK=DECISION#<ts>   (append-only)
// ---------------------------------------------------------------------------
// Full history — not last-write-wins. CandidateWorkspace.status mirrors the
// newest decision so list/filter queries stay cheap.

export const ApprovalDecisionSchema = z.object({
  PK: z.string(),                 // WS#<wsId>
  SK: z.string(),                 // DECISION#<ts>
  entity_type: z.literal('APPROVAL_DECISION'),
  workspace_id: z.string(),
  decision: DecisionType,
  decided_by: z.string(),
  decided_by_email: z.string().optional(),
  decided_at: z.number(),
  note: z.string().max(5000).optional(),
}).and(GsiAttributes);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// ---------------------------------------------------------------------------
// Entity: AuditLogEntry   PK=AUDIT#<yyyy-mm-dd>   SK=<ts>#<auditId>
// ---------------------------------------------------------------------------
// Append-only, date-partitioned, OWNER-read only.

export const AuditLogEntrySchema = z.object({
  PK: z.string(),                 // AUDIT#<yyyy-mm-dd>
  SK: z.string(),                 // <ts>#<auditId>
  entity_type: z.literal('AUDIT_LOG'),
  audit_id: z.string(),
  ts: z.number(),
  actor_user_id: z.string(),
  actor_email: z.string().optional(),
  action: AuditAction,
  target_type: z.string().optional(),   // 'interview' | 'mom' | 'intelligence' | 'workspace' | 'member'
  target_id: z.string().optional(),
  target_owner_user_id: z.string().optional(),
  detail: z.string().optional(),
  // GSI3 (actor -> actions): gsi3_pk = actor_user_id, gsi3_sk = ts
  gsi3_pk: z.string().optional(),
  gsi3_sk: z.union([z.string(), z.number()]).optional(),
}).and(GsiAttributes);
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ---------------------------------------------------------------------------
// Entity: ScheduledInterview
//   PK=SCHED#<panelist_email_lower>   SK=<paddedScheduledAt>#<kekaInterviewId>
// ---------------------------------------------------------------------------
//
// One row PER PANEL MEMBER per interview. That duplication is deliberate: it
// makes "the interviews scheduled for me" a single Query on one partition,
// already in time order, with no GSI and no Scan.
//
// The sort key pads the epoch-ms timestamp to a fixed width so string ordering
// matches chronological ordering (an unpadded number sorts "9…" after "10…").

/** Fixed sort-key width for epoch-ms timestamps. 14 digits covers year 5138. */
export const SCHED_TS_WIDTH = 14;

export const ScheduledPanelistSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  interviewerId: z.string().optional(),
});
export type ScheduledPanelist = z.infer<typeof ScheduledPanelistSchema>;

export const ScheduledInterviewSchema = z.object({
  PK: z.string(),                 // SCHED#<email>
  SK: z.string(),                 // <paddedTs>#<kekaInterviewId>
  entity_type: z.literal('SCHEDULED_INTERVIEW'),
  org_id: z.string(),
  /** Lower-cased email of the panel member this row belongs to. */
  panelist_email: z.string(),
  keka_interview_id: z.string(),
  keka_job_id: z.string(),
  keka_candidate_id: z.string(),
  job_title: z.string(),
  department: z.string().optional(),
  candidate_name: z.string(),
  candidate_email: z.string().optional(),
  /** Interview start, epoch ms. Rendered dd-MM-yyyy in the UI. */
  scheduled_at: z.number(),
  title: z.string().optional(),   // Keka's own meeting title for the round
  panel: z.array(ScheduledPanelistSchema).default([]),
  meeting_url: z.string().optional(),
  meeting_id: z.string().optional(),
  organizer_email: z.string().optional(),
  organizer_user_id: z.string().optional(),
  keka_status: z.string().optional(),
  synced_at: z.number(),
  /**
   * Set when the interview no longer comes back from Keka. The row is kept, not
   * deleted, so an interviewer with the page open sees "cancelled" rather than a
   * round silently disappearing.
   */
  cancelled_at: z.number().optional(),
  /** Stamped once this round has been provisioned into the evaluation pipeline. */
  intelligence_id: z.string().optional(),
  workspace_id: z.string().optional(),
  provisioned_at: z.number().optional(),
  provisioned_by: z.string().optional(),
  /** Short-lived idempotency lease held while an open request provisions this round. */
  provisioning_token: z.string().optional(),
  provisioning_expires_at: z.number().optional(),
  provisioning_by: z.string().optional(),
  provisioning_intelligence_id: z.string().optional(),
  /** Sweep identifier from the last Keka sync that observed this interview. */
  last_seen_sync_id: z.string().optional(),
}).and(GsiAttributes);
export type ScheduledInterview = z.infer<typeof ScheduledInterviewSchema>;

// ---------------------------------------------------------------------------
// Entity: SyncState   PK=SYNC#<source>   SK=STATE
// ---------------------------------------------------------------------------
// Checkpoint for the Keka sweep, so an interrupted run resumes at the job it
// stopped on instead of starting over.

export const SyncStateSchema = z.object({
  PK: z.string(),                 // SYNC#keka
  SK: z.literal('STATE'),
  entity_type: z.literal('SYNC_STATE'),
  source: z.string(),
  started_at: z.number().optional(),
  finished_at: z.number().optional(),
  /** Index into the job list the last run completed through. */
  cursor_job_index: z.number().optional(),
  last_error: z.string().optional(),
  jobs_total: z.number().optional(),
  interviews_indexed: z.number().optional(),
  rows_written: z.number().optional(),
  triggered_by: z.string().optional(),
  /** Current sweep id, reused by resumed runs until the sweep completes. */
  sync_run_id: z.string().optional(),
}).and(GsiAttributes);
export type SyncState = z.infer<typeof SyncStateSchema>;

// ---------------------------------------------------------------------------
// Entity: QuestionBankRole   PK=QBANK#<roleKey>   SK=META
// Entity: QuestionBankItem   PK=QBANK#<roleKey>   SK=Q#<questionId>
// ---------------------------------------------------------------------------
//
// Colocated so one Query returns a role's competency override and every question
// for it together. `roleKey` is the Keka job id when known, else a slug of the
// job title.
//
// `competencies` on the META row is the ADMIN OVERRIDE for JD competency
// extraction — when present it always wins over the AI-extracted list. This is
// what lets a human correct a bad extraction without a deploy.

export const QuestionBankRoleSchema = z.object({
  PK: z.string(),                 // QBANK#<roleKey>
  SK: z.literal('META'),
  entity_type: z.literal('QUESTION_BANK_ROLE'),
  role_key: z.string(),
  role_title: z.string(),
  department: z.string().optional(),
  experience: z.string().optional(),
  keka_job_id: z.string().optional(),
  /** Admin override for role competencies. Empty/absent = fall back to AI. */
  competencies: z.array(z.string()).default([]),
  created_at: z.number(),
  updated_at: z.number(),
  updated_by: z.string().optional(),
  // GSI1 (org recency) so the admin role list is a Query, not a Scan.
  gsi1_pk: z.string().optional(),
  gsi1_sk: z.union([z.string(), z.number()]).optional(),
}).and(GsiAttributes);
export type QuestionBankRole = z.infer<typeof QuestionBankRoleSchema>;

export const QuestionBankItemSchema = z.object({
  PK: z.string(),                 // QBANK#<roleKey>
  SK: z.string(),                 // Q#<questionId>
  entity_type: z.literal('QUESTION_BANK_ITEM'),
  role_key: z.string(),
  /**
   * Denormalized onto every item so the selector — which scores questions by
   * role title (scoreRoleQuestion) — keeps matching a role's own JD without a
   * second read of the META row. keka_job_id rides along for the same reason.
   */
  role_title: z.string().optional(),
  keka_job_id: z.string().optional(),
  /** Stable across edits and seeds — the seed preserves the original IDs. */
  question_id: z.string(),
  category: z.string(),
  topic_tag: z.string().optional(),
  /** Competency this question evidences. Free text so admins are not boxed in. */
  competency: z.string().optional(),
  question: z.string().min(1),
  follow_ups: z.array(z.string()).default([]),
  strong_signals: z.array(z.string()).default([]),
  red_flags: z.array(z.string()).default([]),
  /** Soft delete. Inactive questions stay for audit but are never selected. */
  active: z.boolean().default(true),
  source: z.enum(['SEED', 'ADMIN']).default('ADMIN'),
  created_at: z.number(),
  updated_at: z.number(),
  updated_by: z.string().optional(),
}).and(GsiAttributes);
export type QuestionBankItem = z.infer<typeof QuestionBankItemSchema>;

// ---------------------------------------------------------------------------
// Key builders — one place per entity so PK/SK strings are never hand-spliced
// at call sites.
// ---------------------------------------------------------------------------

/** Slug used as a roleKey when a role has no Keka job id. */
export function roleKeyFromTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unspecified-role';
}

export const keys = {
  membershipPk: (orgId: string = DEFAULT_ORG_ID) => `ORG#${orgId}`,
  membershipSk: (userId: string) => `MEMBER#${userId}`,

  grantPk: (userId: string) => `USER#${userId}`,
  grantSk: (ts: number) => `GRANT#${ts}`,

  workspacePk: (workspaceId: string) => `WS#${workspaceId}`,
  workspaceMetaSk: () => 'META' as const,
  shareSk: (userId: string) => `SHARE#${userId}`,
  commentSk: (ts: number, commentId: string) => `COMMENT#${ts}#${commentId}`,
  decisionSk: (ts: number) => `DECISION#${ts}`,

  auditPk: (isoDate: string) => `AUDIT#${isoDate}`, // isoDate = yyyy-mm-dd
  auditSk: (ts: number, auditId: string) => `${ts}#${auditId}`,

  schedPk: (email: string) => `SCHED#${String(email || '').trim().toLowerCase()}`,
  schedSk: (scheduledAt: number, kekaInterviewId: string) =>
    `${String(Math.max(0, Math.floor(scheduledAt))).padStart(SCHED_TS_WIDTH, '0')}#${kekaInterviewId}`,

  syncPk: (source: string) => `SYNC#${source}`,
  syncStateSk: () => 'STATE' as const,

  qbankPk: (roleKey: string) => `QBANK#${roleKey}`,
  qbankMetaSk: () => 'META' as const,
  qbankItemSk: (questionId: string) => `Q#${questionId}`,
} as const;

// Prefix constants for begins_with Query conditions.
export const SK_PREFIX = {
  SHARE: 'SHARE#',
  COMMENT: 'COMMENT#',
  DECISION: 'DECISION#',
  GRANT: 'GRANT#',
  MEMBER: 'MEMBER#',
  QUESTION: 'Q#',
} as const;

// ---------------------------------------------------------------------------
// API input schemas (request bodies). Role/tier is NEVER read from these —
// the server re-fetches Membership + AdminGrant from the Cognito identity.
// ---------------------------------------------------------------------------

export const GrantTierSchema = z.object({
  tier: AdminTier,
  note: z.string().max(5000).optional(),
});

export const ChangeBaseRoleSchema = z.object({
  base_role: BaseRole,
  email: z.string().email().optional(),
});

export const CreateWorkspaceSchema = z.object({
  title: z.string().min(1).max(200),
  candidate_name: z.string().max(200).optional(),
  position: z.string().max(200).optional(),
});

export const UpdateWorkspaceSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  candidate_name: z.string().max(200).optional(),
  position: z.string().max(200).optional(),
  status: WorkspaceStatus.optional(),
});

export const AddShareSchema = z.object({
  shared_user_id: z.string().min(1),
  shared_email: z.string().optional(),
  permission: SharePermission,
});

export const CreateCommentSchema = z.object({
  body: z.string().min(1).max(5000),
});

export const LinkRecordSchema = z.object({
  record_type: LinkedRecordType,
  record_id: z.string().min(1),
  label: z.string().max(200).optional(),
});

export const DecisionSchema = z.object({
  decision: DecisionType,
  note: z.string().max(5000).optional(),
});

// Question bank editing. `competencies` here is the admin override that wins
// over AI extraction for every interview generated against this role.
export const UpdateQuestionBankRoleSchema = z.object({
  role_title: z.string().min(1).max(200).optional(),
  department: z.string().max(200).optional(),
  experience: z.string().max(100).optional(),
  competencies: z.array(z.string().min(1).max(120)).max(30).optional(),
});

export const CreateQuestionBankItemSchema = z.object({
  category: z.string().min(1).max(120),
  topic_tag: z.string().max(120).optional(),
  competency: z.string().max(120).optional(),
  question: z.string().min(1).max(4000),
  follow_ups: z.array(z.string().max(1000)).max(10).optional(),
  strong_signals: z.array(z.string().max(1000)).max(10).optional(),
  red_flags: z.array(z.string().max(1000)).max(10).optional(),
});

export const UpdateQuestionBankItemSchema = CreateQuestionBankItemSchema
  .partial()
  .extend({ active: z.boolean().optional() });

// The identity payload returned by GET /me. Derived entirely server-side.
export const MeResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  baseRole: BaseRole,
  tier: AdminTier.nullable(),
  isAdmin: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
