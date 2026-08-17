import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../shared/aws';
import {
  QuestionBankItem,
  QuestionBankRole,
  SK_PREFIX,
  keys,
  roleKeyFromTitle,
} from '../../schema/admin.js';
import { ROLE_QUESTION_BANK } from './minfy-role-question-bank.js';
import { RoleBankEntry } from './manual-question-bank.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;

/**
 * Sparse GSI1 partition values. Question bank rows opt into GSI1 so the whole
 * pool (247 seeded questions across 43 roles) is one Query instead of a Scan of
 * the admin table — which also holds the append-only audit log and must never be
 * scanned as it grows.
 */
export const QBANK_GSI1_ROLE = 'QBANK_ROLE';
export const QBANK_GSI1_ITEM = 'QBANK_ITEM';

export type { RoleBankEntry };

/**
 * Stable key for a role. Keka's job id when we have it (two roles can share a
 * title), else a slug of the title so manually created interviews still land in
 * a curatable bucket.
 */
export function roleKeyForJob(input: { kekaJobId?: string; jobTitle?: string }): string {
  const jobId = String(input.kekaJobId || '').trim();
  if (jobId) return jobId;
  return roleKeyFromTitle(String(input.jobTitle || ''));
}

function itemToBankEntry(item: Record<string, any>): RoleBankEntry {
  return {
    id: String(item.question_id || ''),
    department: String(item.department || ''),
    // The selector scores against jobTitle, so the curated role title must ride
    // along on every question or an edited role stops matching its own JD.
    jobTitle: String(item.role_title || ''),
    jobId: String(item.keka_job_id || item.role_key || ''),
    experience: String(item.experience || ''),
    category: String(item.category || 'Core Technical/Functional Skills'),
    topicTag: String(item.topic_tag || ''),
    question: String(item.question || ''),
    followUps: Array.isArray(item.follow_ups) && item.follow_ups.length ? item.follow_ups.map(String) : undefined,
    strongSignals: Array.isArray(item.strong_signals) && item.strong_signals.length ? item.strong_signals.map(String) : undefined,
    redFlags: Array.isArray(item.red_flags) && item.red_flags.length ? item.red_flags.map(String) : undefined,
    competency: item.competency ? String(item.competency) : undefined,
  };
}

// Warm-container cache. Short TTL so an admin's edit shows up on the next
// generation rather than whenever the container recycles.
const POOL_CACHE_TTL_MS = 30_000;
let cachedPool: { value: RoleBankEntry[]; expiresAt: number } | undefined;

/** Clears the warm cache so a write is visible to the very next read. */
export function invalidateRoleBankCache(): void {
  cachedPool = undefined;
}

/**
 * The full role-question pool.
 *
 * Returns the curated DynamoDB pool when it has any rows, otherwise the shipped
 * static array. That fallback is what makes this change safe to deploy before
 * seeding — and safe if seeding is never run at all.
 *
 * Deactivated (soft-deleted) questions are filtered out here, so an admin
 * removing a question removes it everywhere, including from the cross-role fuzzy
 * matches the selector makes for similar titles.
 */
export async function loadRoleBankPool(): Promise<RoleBankEntry[]> {
  if (cachedPool && cachedPool.expiresAt > Date.now()) return cachedPool.value;

  try {
    const rows: Record<string, any>[] = [];
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await ddbDocClient.send(new QueryCommand({
        TableName: ADMIN_TABLE_NAME,
        IndexName: 'GSI1_OrgRecency',
        KeyConditionExpression: 'gsi1_pk = :pk',
        ExpressionAttributeValues: { ':pk': QBANK_GSI1_ITEM },
        ExclusiveStartKey: lastKey,
      }));
      rows.push(...(page.Items || []));
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    const active = rows
      .filter((row) => row.active !== false && row.question)
      .map(itemToBankEntry)
      .filter((entry) => entry.id && entry.question);

    if (active.length) {
      cachedPool = { value: active, expiresAt: Date.now() + POOL_CACHE_TTL_MS };
      return active;
    }
  } catch (err) {
    // A curation-layer outage must never block an interview from being prepared.
    console.warn('Question bank pool unavailable, using the shipped bank:', err);
  }

  cachedPool = { value: ROLE_QUESTION_BANK, expiresAt: Date.now() + POOL_CACHE_TTL_MS };
  return ROLE_QUESTION_BANK;
}

/** One role's META row plus its questions — a single Query on QBANK#<roleKey>. */
export async function loadRoleBank(roleKey: string): Promise<{
  role: QuestionBankRole | null;
  items: QuestionBankItem[];
}> {
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.qbankPk(roleKey) },
  }));

  let role: QuestionBankRole | null = null;
  const items: QuestionBankItem[] = [];
  for (const row of result.Items || []) {
    if (row.SK === keys.qbankMetaSk()) role = row as QuestionBankRole;
    else if (String(row.SK || '').startsWith(SK_PREFIX.QUESTION)) items.push(row as QuestionBankItem);
  }
  items.sort((left, right) => String(left.question_id).localeCompare(String(right.question_id)));
  return { role, items };
}

/**
 * The admin competency override for a role, or null when none is set.
 *
 * This is the top of the competency resolution order — a human correcting a bad
 * AI extraction, without a deploy. Absent or empty means "fall back to AI".
 */
export async function loadRoleCompetencyOverride(roleKey: string): Promise<string[] | null> {
  try {
    const { role } = await loadRoleBank(roleKey);
    const competencies = (role?.competencies || [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    return competencies.length ? competencies : null;
  } catch (err) {
    console.warn('Could not read role competency override:', err);
    return null;
  }
}

/** Every curated role, newest first. One Query on the sparse GSI1 partition. */
export async function listRoleBanks(): Promise<QuestionBankRole[]> {
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    IndexName: 'GSI1_OrgRecency',
    KeyConditionExpression: 'gsi1_pk = :pk',
    ExpressionAttributeValues: { ':pk': QBANK_GSI1_ROLE },
    ScanIndexForward: false,
  }));
  return (result.Items || []) as QuestionBankRole[];
}
