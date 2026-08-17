import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/**
 * READ-ONLY probe for Keka Hire's candidate-status vocabulary (Part A, step 1).
 *
 * The schedule-sync worker filters candidates by status so the sweep costs a few
 * hundred Keka calls instead of jobs × candidates (~40,000). Which status values
 * mean "has an interview coming up" cannot be known from the code — it must be
 * observed against the live tenant. This script observes it, and NOTHING else:
 * it only issues GET requests (plus the OAuth token POST, which is auth, not a
 * write). It creates, updates and deletes nothing in Keka or AWS.
 *
 * It is deliberately SELF-CONTAINED — it does not import the Lambda integration
 * module. That module pulls in schema types via `.js`-suffixed specifiers, which
 * fail to resolve under ts-node's CommonJS loader (see the note in
 * seed-question-bank.ts). Instead the few pieces of logic below are copied
 * verbatim from infrastructure/lambdas/api-handler/intelligence-integrations.ts
 * so the reported values match production exactly:
 *   - getRequiredString            (line 409)
 *   - asRecord                     (line 452)
 *   - firstString                  (line 456)
 *   - listFromKekaPage             (line 475)
 *   - credential resolution        (getKekaCredentials, line 649)
 *   - OAuth token request          (getAccessToken, line 1077)
 *   - authorized GET               (get, line 1110)
 *   - candidate.status extraction  (toKekaCandidate, line 604/617)
 *   - jobs/candidates endpoints    (listJobs/listCandidates, line 1131/1136)
 * If that file's normalizer changes, re-copy these.
 *
 * ── Credentials (same resolution order as the Lambda) ────────────────────────
 * Either point at the deployed secret (needs AWS creds for the dev account):
 *
 *   AWS_REGION=ap-south-1 \
 *   KEKA_SECRET_ARN=<arn of the Keka secret> \
 *   npx ts-node scripts/probe-keka-status.ts
 *
 * …or pass the raw values directly (no AWS creds needed):
 *
 *   KEKA_BASE_URL=https://<company>.keka.com \
 *   KEKA_CLIENT_ID=... KEKA_CLIENT_SECRET=... KEKA_API_KEY=... \
 *   [KEKA_SCOPE=kekaapi] \
 *   npx ts-node scripts/probe-keka-status.ts
 *
 * ── Optional tuning (env) ────────────────────────────────────────────────────
 *   MAX_JOBS=40     how many jobs to sample for candidate statuses (default 40;
 *                   set MAX_JOBS=0 to sample every job on page 1, up to 200).
 *   DUMP_RAW=true   also print one raw candidate object per job (PII fields
 *                   name/email/phone are redacted). Off by default.
 *
 * Secrets are never printed — only the base URL and the credential source.
 */

type KekaRecord = Record<string, unknown>;

// ── verbatim from intelligence-integrations.ts ──────────────────────────────
function getRequiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): KekaRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as KekaRecord) : undefined;
}

function firstString(record: KekaRecord | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    const value = getRequiredString(raw);
    if (value) return value;
  }
  return undefined;
}

function listFromKekaPage(payload: unknown): KekaRecord[] {
  const record = asRecord(payload);
  const entries = record?.data ?? record?.items ?? record?.value;
  return Array.isArray(entries) ? entries.map(asRecord).filter((item): item is KekaRecord => !!item) : [];
}

/** Mirrors toKekaCandidate's status resolution (line 604-618). */
function candidateStatusOf(record: KekaRecord): string | undefined {
  const candidate = asRecord(record.candidate) ?? asRecord(record.candidateDetails) ?? asRecord(record.candidateData) ?? record;
  return firstString(candidate, ['status', 'candidateStatus']) ?? firstString(record, ['candidateStatus', 'status']);
}
// ────────────────────────────────────────────────────────────────────────────

type KekaCredentials = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  scope: string;
};

const region = process.env.AWS_REGION || 'ap-south-1';
const secretsClient = new SecretsManagerClient({ region });

function normalizeKekaBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/i.test(trimmed)) {
    throw new Error('Keka base URL must look like https://company.keka.com (got: ' + JSON.stringify(value) + ')');
  }
  return trimmed;
}

/** Mirrors getKekaCredentials (line 649): secret first, then env fallback. */
async function resolveCredentials(): Promise<{ creds: KekaCredentials; source: string }> {
  let payload: KekaRecord = {};
  let source = 'env vars';
  const secretId = getRequiredString(process.env.KEKA_SECRET_ARN);
  if (secretId) {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    payload = JSON.parse(response.SecretString || '{}') as KekaRecord;
    source = `AWS Secrets Manager (${secretId})`;
  }

  const creds: KekaCredentials = {
    baseUrl: getRequiredString(payload.baseUrl || payload.KEKA_BASE_URL || process.env.KEKA_BASE_URL),
    clientId: getRequiredString(payload.clientId || payload.KEKA_CLIENT_ID || process.env.KEKA_CLIENT_ID),
    clientSecret: getRequiredString(payload.clientSecret || payload.KEKA_CLIENT_SECRET || process.env.KEKA_CLIENT_SECRET),
    apiKey: getRequiredString(payload.apiKey || payload.KEKA_API_KEY || process.env.KEKA_API_KEY),
    scope: getRequiredString(payload.scope || payload.KEKA_SCOPE || process.env.KEKA_SCOPE) || 'kekaapi',
  };
  creds.baseUrl = normalizeKekaBaseUrl(creds.baseUrl);
  if (!creds.clientId || !creds.clientSecret || !creds.apiKey) {
    throw new Error('Keka credentials must include clientId, clientSecret and apiKey (from the secret or KEKA_* env vars).');
  }
  return { creds, source };
}

/** Mirrors getAccessToken (line 1077). */
async function getAccessToken(creds: KekaCredentials): Promise<string> {
  const form = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    api_key: creds.apiKey,
    scope: creds.scope,
    grant_type: 'kekaapi',
  });
  const response = await fetch('https://login.keka.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!response.ok) {
    throw new Error(`Keka rejected the credentials (HTTP ${response.status}). Verify clientId/secret/apiKey and Hire privileges.`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error('Keka authentication did not return an access token.');
  return payload.access_token;
}

/** Mirrors the authorized GET (line 1110). Read-only. */
async function kekaGet(creds: KekaCredentials, token: string, path: string): Promise<unknown> {
  const response = await fetch(`${creds.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`GET ${path} -> HTTP ${response.status}`);
  return response.json();
}

const STATUS_LIKE = /stat|stage|phase|pipeline|disposition|outcome|result/i;
const PII_LIKE = /name|email|phone|mobile|contact|dob|address/i;

function redactValue(key: string, value: unknown): unknown {
  if (PII_LIKE.test(key) && typeof value === 'string' && value) return '«redacted»';
  if (typeof value === 'string') return value.length > 80 ? value.slice(0, 80) + '…' : value;
  if (value && typeof value === 'object') return Array.isArray(value) ? `[array:${value.length}]` : '{object}';
  return value;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function addValue(map: Map<string, Set<string>>, field: string, value: string): void {
  if (!map.has(field)) map.set(field, new Set());
  const set = map.get(field)!;
  if (set.size < 40) set.add(value); // cap distinct values per field
}

async function run(): Promise<void> {
  const maxJobsRaw = process.env.MAX_JOBS;
  const maxJobs = maxJobsRaw === undefined ? 40 : Math.max(0, Number.parseInt(maxJobsRaw, 10) || 0);
  const dumpRaw = process.env.DUMP_RAW === 'true';

  console.log('=== Keka candidate-status probe (READ-ONLY: GET requests only) ===');
  const { creds, source } = await resolveCredentials();
  console.log(`Credential source : ${source}`);
  console.log(`Base URL          : ${creds.baseUrl}`);
  console.log(`Region            : ${region}`);
  console.log('Authenticating…');
  const token = await getAccessToken(creds);
  console.log('Authenticated.\n');

  // Page 1 of jobs (matches the Lambda: pageSize=200, single page).
  const jobRows = listFromKekaPage(await kekaGet(creds, token, '/api/v1/hire/jobs?pageNumber=1&pageSize=200'));
  console.log(`Jobs on page 1: ${jobRows.length}`);
  const sampleJobs = maxJobs > 0 ? jobRows.slice(0, maxJobs) : jobRows;
  if (maxJobs > 0 && jobRows.length > maxJobs) {
    console.log(`Sampling first ${maxJobs} (set MAX_JOBS=0 to sample all ${jobRows.length}).`);
  }
  console.log('');

  const normalizedDist = new Map<string, number>(); // candidate.status (prod's view) -> count
  const rawStatusFields = new Map<string, Set<string>>(); // any status/stage-like raw field -> distinct values
  const topLevelKeys = new Set<string>();
  let candidatesSeen = 0;
  let jobsErrored = 0;

  for (let i = 0; i < sampleJobs.length; i++) {
    const job = sampleJobs[i];
    const jobId = firstString(job, ['id', 'jobId']);
    const jobTitle = firstString(job, ['title', 'jobTitle', 'name']) || '(untitled)';
    if (!jobId) continue;
    try {
      const rows = listFromKekaPage(
        await kekaGet(creds, token, `/api/v1/hire/jobs/${encodeURIComponent(jobId)}/candidates?pageNumber=1&pageSize=200`),
      );
      for (const row of rows) {
        candidatesSeen++;
        // Prod's normalized view of status:
        bump(normalizedDist, candidateStatusOf(row) || '(none)');
        // Raw recon: the candidate object may be nested or flat.
        const candidate = asRecord(row.candidate) ?? asRecord(row.candidateDetails) ?? asRecord(row.candidateData) ?? row;
        for (const [key, value] of Object.entries(candidate)) {
          topLevelKeys.add(key);
          if (STATUS_LIKE.test(key)) {
            if (typeof value === 'string' && value.trim()) addValue(rawStatusFields, key, value.trim());
            else if (typeof value === 'number' && Number.isFinite(value)) addValue(rawStatusFields, key, String(value));
            else if (value && typeof value === 'object') {
              // e.g. { status: { name: "Interview" } }
              const label = firstString(asRecord(value), ['name', 'label', 'title', 'text', 'value']);
              if (label) addValue(rawStatusFields, `${key}.name`, label);
            }
          }
        }
      }
      if (dumpRaw && rows.length) {
        const candidate = asRecord(rows[0].candidate) ?? asRecord(rows[0].candidateDetails) ?? asRecord(rows[0].candidateData) ?? rows[0];
        const redacted: KekaRecord = {};
        for (const [key, value] of Object.entries(candidate)) redacted[key] = redactValue(key, value);
        console.log(`  raw sample [${jobTitle}]: ${JSON.stringify(redacted)}`);
      }
      console.log(`  ${String(i + 1).padStart(3)}/${sampleJobs.length}  ${jobTitle.slice(0, 48).padEnd(48)}  ${rows.length} candidate(s)`);
    } catch (err: any) {
      jobsErrored++;
      console.log(`  ${String(i + 1).padStart(3)}/${sampleJobs.length}  ${jobTitle.slice(0, 48).padEnd(48)}  ERROR: ${err?.message || err}`);
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const sortDesc = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]);

  console.log(`\n=== Normalized candidate.status (what the sweep filter will see) ===`);
  console.log(`(candidates seen: ${candidatesSeen}, jobs sampled: ${sampleJobs.length}, jobs errored: ${jobsErrored})`);
  for (const [status, count] of sortDesc(normalizedDist)) {
    console.log(`  ${String(count).padStart(6)}  ${status}`);
  }

  console.log(`\n=== Raw status/stage-like fields discovered (alternate signals) ===`);
  if (rawStatusFields.size === 0) {
    console.log('  (none found by name — the status field, if any, is not named status/stage/phase/pipeline)');
  } else {
    for (const [field, values] of rawStatusFields) {
      console.log(`  ${field}: ${Array.from(values).map((v) => JSON.stringify(v)).join(', ')}`);
    }
  }

  console.log(`\n=== Candidate object keys seen (structure) ===`);
  console.log('  ' + Array.from(topLevelKeys).sort().join(', '));

  // ── Recommendation ────────────────────────────────────────────────────────
  const noneCount = normalizedDist.get('(none)') || 0;
  const nonePct = candidatesSeen ? noneCount / candidatesSeen : 1;
  const distinctNonNone = Array.from(normalizedDist.keys()).filter((k) => k !== '(none)').length;
  let recommendation: string;
  if (candidatesSeen === 0) {
    recommendation = 'No candidates returned — check credentials/privileges, or that these jobs have candidates.';
  } else if (nonePct < 0.2 && distinctNonNone >= 2 && distinctNonNone <= 20) {
    recommendation = 'candidate.status is well-populated with a small vocabulary — use the values above to build the interview-active filter for the sync worker.';
  } else if (nonePct >= 0.5) {
    recommendation = 'candidate.status is mostly empty — the real signal is likely one of the raw status/stage-like fields above; widen toKekaCandidate\'s key list before filtering on it, else use the plan\'s fallback (any interview activity in the window + lower sync frequency).';
  } else {
    recommendation = 'Mixed result — review both sections; consider the fallback (interview activity in the window) if no single status cleanly means "interview scheduled".';
  }
  console.log(`\n=== Recommendation ===\n  ${recommendation}`);

  // ── Machine-readable summary to paste back ─────────────────────────────────
  const pasteback = {
    baseUrl: creds.baseUrl,
    candidatesSeen,
    jobsSampled: sampleJobs.length,
    jobsErrored,
    normalizedStatusDistribution: Object.fromEntries(sortDesc(normalizedDist)),
    rawStatusLikeFields: Object.fromEntries(
      Array.from(rawStatusFields.entries()).map(([k, v]) => [k, Array.from(v)] as [string, string[]]),
    ),
    candidateKeys: Array.from(topLevelKeys).sort(),
    recommendation,
  };
  console.log('\n=== PASTE THIS BACK TO CLAUDE ===');
  console.log(JSON.stringify(pasteback, null, 2));
}

run().catch((err) => {
  console.error('\nProbe failed:', err?.message || err);
  process.exit(1);
});
