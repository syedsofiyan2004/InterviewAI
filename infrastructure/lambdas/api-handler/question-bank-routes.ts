import { APIGatewayProxyEvent } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { ddbDocClient } from '../shared/aws';
import { successResponse, errorResponse } from '../shared/responses';
import { getCallerContext, requireAdminTier } from './authz.js';
import { writeAuditLog } from './audit.js';
import {
  keys,
  QuestionBankRole,
  QuestionBankItem,
  UpdateQuestionBankRoleSchema,
  CreateQuestionBankItemSchema,
  UpdateQuestionBankItemSchema,
} from '../../schema/admin.js';
import {
  loadRoleBank,
  listRoleBanks,
  invalidateRoleBankCache,
  QBANK_GSI1_ROLE,
  QBANK_GSI1_ITEM,
} from './question-bank-store.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

/**
 * The question bank is org-wide interview configuration, gated at `OWNER` — the
 * top tier — because a bad edit steers every generated guide for a role. Reads
 * are gated too (the bank is not public) but not audited; only mutations are, so
 * the audit trail stays a log of *changes*, not of every admin who opened a page.
 *
 * Every write invalidates the warm pool cache in question-bank-store so an edit
 * is visible to the very next generation, and stamps a QBANK_UPDATE/QBANK_DELETE
 * audit row. Deletes are soft (`active: false`) — a removed question stays for
 * audit but is never selected again.
 */

/** GET /admin/question-bank — every curated role, newest first. One GSI query. */
export async function listQuestionBankRoles(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;

  const roles = await listRoleBanks();
  const items = roles.map((role) => ({
    role_key: role.role_key,
    role_title: role.role_title,
    department: role.department,
    experience: role.experience,
    keka_job_id: role.keka_job_id,
    competencies: role.competencies || [],
    updated_at: role.updated_at,
    updated_by: role.updated_by,
  }));
  return successResponse({ items, count: items.length });
}

/**
 * GET /admin/question-bank/{roleKey} — one role's META (title, competencies) and
 * every question, active or soft-deleted, so the admin can see and reactivate
 * removed questions. A role with no rows yet is a 404, not an empty shell — the
 * static bank must be seeded (or the role created via PATCH) before it is
 * editable, and a 404 says exactly that.
 */
export async function getQuestionBankRole(roleKey: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!roleKey) return errorResponse(400, 'VALIDATION_ERROR', 'Missing roleKey');

  const { role, items } = await loadRoleBank(roleKey);
  if (!role && items.length === 0) {
    return errorResponse(404, 'NOT_FOUND', 'This role is not in the question bank yet. Seed the bank or create the role first.');
  }
  return successResponse({ role, items, count: items.length });
}

/**
 * PATCH /admin/question-bank/{roleKey} — update a role's meta and, crucially, its
 * `competencies[]` override, which wins over AI extraction for every interview
 * generated against this role (the fix for "1500+ VM Migrations" surfacing as a
 * skill). Upserts: editing a role that only lived in the static bank, or a brand
 * new role, creates its META row.
 */
export async function updateQuestionBankRole(roleKey: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!roleKey) return errorResponse(400, 'VALIDATION_ERROR', 'Missing roleKey');

  const parsed = UpdateQuestionBankRoleSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid role payload', parsed.error.flatten());
  }

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.qbankPk(roleKey), SK: keys.qbankMetaSk() },
  }));
  const prev = existing.Item as QuestionBankRole | undefined;

  const ts = Date.now();
  const role: QuestionBankRole = {
    PK: keys.qbankPk(roleKey),
    SK: keys.qbankMetaSk(),
    entity_type: 'QUESTION_BANK_ROLE',
    role_key: roleKey,
    // A fresh role has no title to fall back on but the slug — the admin can
    // correct it in the same form.
    role_title: parsed.data.role_title ?? prev?.role_title ?? roleKey,
    department: parsed.data.department ?? prev?.department,
    experience: parsed.data.experience ?? prev?.experience,
    keka_job_id: prev?.keka_job_id,
    competencies: parsed.data.competencies ?? prev?.competencies ?? [],
    created_at: prev?.created_at ?? ts,
    updated_at: ts,
    updated_by: caller!.userId,
    gsi1_pk: QBANK_GSI1_ROLE,
    gsi1_sk: ts,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: role }));
  invalidateRoleBankCache();

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'QBANK_UPDATE',
    targetType: 'question_bank_role',
    targetId: roleKey,
    detail: parsed.data.competencies
      ? `competencies set (${parsed.data.competencies.length})`
      : 'role meta updated',
  });

  return successResponse({ role });
}

/**
 * POST /admin/question-bank/{roleKey}/questions — add a question to a role. The
 * role META must exist first, because `role_title` (and `keka_job_id`) are
 * denormalised onto every item so the selector, which scores by role title, can
 * match the question to its own JD without a second read.
 */
export async function createQuestionBankItem(roleKey: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!roleKey) return errorResponse(400, 'VALIDATION_ERROR', 'Missing roleKey');

  const parsed = CreateQuestionBankItemSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid question payload', parsed.error.flatten());
  }

  const metaRes = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.qbankPk(roleKey), SK: keys.qbankMetaSk() },
  }));
  const meta = metaRes.Item as QuestionBankRole | undefined;
  if (!meta) {
    return errorResponse(409, 'VALIDATION_ERROR', 'Create the role (set its title and competencies) before adding questions.');
  }

  const ts = Date.now();
  const questionId = uuidv4();
  const item: QuestionBankItem = {
    PK: keys.qbankPk(roleKey),
    SK: keys.qbankItemSk(questionId),
    entity_type: 'QUESTION_BANK_ITEM',
    role_key: roleKey,
    role_title: meta.role_title,
    keka_job_id: meta.keka_job_id,
    question_id: questionId,
    category: parsed.data.category,
    topic_tag: parsed.data.topic_tag,
    competency: parsed.data.competency,
    question: parsed.data.question,
    follow_ups: parsed.data.follow_ups ?? [],
    strong_signals: parsed.data.strong_signals ?? [],
    red_flags: parsed.data.red_flags ?? [],
    active: true,
    source: 'ADMIN',
    created_at: ts,
    updated_at: ts,
    updated_by: caller!.userId,
    gsi1_pk: QBANK_GSI1_ITEM,
    gsi1_sk: ts,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));
  invalidateRoleBankCache();

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'QBANK_UPDATE',
    targetType: 'question_bank_item',
    targetId: `${roleKey}/${questionId}`,
    detail: 'question created',
  });

  return successResponse({ item });
}

/**
 * PATCH /admin/question-bank/{roleKey}/questions/{questionId} — edit a question.
 * Also the reactivation path: `active: true` un-deletes a soft-deleted question.
 * PK/SK/question_id/source/role_title are preserved (spread of the prior row).
 */
export async function updateQuestionBankItem(
  roleKey: string | undefined,
  questionId: string | undefined,
  event: APIGatewayProxyEvent,
) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!roleKey || !questionId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing roleKey or questionId');

  const parsed = UpdateQuestionBankItemSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid question payload', parsed.error.flatten());
  }

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.qbankPk(roleKey), SK: keys.qbankItemSk(questionId) },
  }));
  const prev = existing.Item as QuestionBankItem | undefined;
  if (!prev) return errorResponse(404, 'NOT_FOUND', 'Question not found');

  const ts = Date.now();
  const item: QuestionBankItem = {
    ...prev,
    category: parsed.data.category ?? prev.category,
    topic_tag: parsed.data.topic_tag ?? prev.topic_tag,
    competency: parsed.data.competency ?? prev.competency,
    question: parsed.data.question ?? prev.question,
    follow_ups: parsed.data.follow_ups ?? prev.follow_ups,
    strong_signals: parsed.data.strong_signals ?? prev.strong_signals,
    red_flags: parsed.data.red_flags ?? prev.red_flags,
    active: parsed.data.active ?? prev.active,
    updated_at: ts,
    updated_by: caller!.userId,
    // A pre-existing row may predate the sparse GSI; keep it discoverable.
    gsi1_pk: QBANK_GSI1_ITEM,
    gsi1_sk: prev.gsi1_sk ?? ts,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));
  invalidateRoleBankCache();

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'QBANK_UPDATE',
    targetType: 'question_bank_item',
    targetId: `${roleKey}/${questionId}`,
    detail: parsed.data.active === false ? 'question deactivated' : 'question updated',
  });

  return successResponse({ item });
}

/**
 * DELETE /admin/question-bank/{roleKey}/questions/{questionId} — soft delete.
 * The row stays (audit) with `active: false`, so it is never selected again but
 * can be reactivated via PATCH. Idempotent: deleting an already-inactive or
 * missing question is not an error the caller should have to handle specially,
 * but a genuinely absent row is a 404 so a typo'd id is visible.
 */
export async function deleteQuestionBankItem(
  roleKey: string | undefined,
  questionId: string | undefined,
  event: APIGatewayProxyEvent,
) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  if (!roleKey || !questionId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing roleKey or questionId');

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: keys.qbankPk(roleKey), SK: keys.qbankItemSk(questionId) },
  }));
  const prev = existing.Item as QuestionBankItem | undefined;
  if (!prev) return errorResponse(404, 'NOT_FOUND', 'Question not found');

  const ts = Date.now();
  const item: QuestionBankItem = {
    ...prev,
    active: false,
    updated_at: ts,
    updated_by: caller!.userId,
    gsi1_pk: QBANK_GSI1_ITEM,
    gsi1_sk: prev.gsi1_sk ?? ts,
  };
  await ddbDocClient.send(new PutCommand({ TableName: ADMIN_TABLE_NAME, Item: item }));
  invalidateRoleBankCache();

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'QBANK_DELETE',
    targetType: 'question_bank_item',
    targetId: `${roleKey}/${questionId}`,
    detail: 'question soft-deleted',
  });

  return successResponse({ success: true, question_id: questionId });
}
