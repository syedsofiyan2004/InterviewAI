import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import type {
  CalculationRecord,
  CalculationResource,
  CalculationResult,
} from '../../schema/calculator';
import type {
  EstimatePlanRevision,
  EstimateScenarioRequest,
  ExecutionManifest,
  ResourcePreflight,
  RequirementCheck,
  RequirementConstraint,
} from '../../schema/estimate-plan';
import type { WorkbookInsights } from '../../schema/calculator';
import type { CanonicalRow, CanonicalWorkbook } from '../shared/canonical-workbook';
import type { CalculatorGateway } from './mcp-client';
import {
  HOURS_PER_MONTH,
  lookupPrice,
  monthlyFromGbMonth,
  monthlyFromHourly,
  resetPriceCache,
  type PriceTerm,
} from './aws-pricing';
import {
  INSTANCE_UNIT,
  reconcile,
  type CanonicalUnit,
  type UnitMatch,
} from '../shared/unit-contract';
import {
  commitmentFromRequest,
  describeRequest,
  resolvePricing,
  summariseScenario,
  type CommitmentRequest,
  type PricingDecision,
  type ScenarioLine,
  type ScenarioSummary,
} from '../shared/pricing-models';
import { sqlLicensing } from '../shared/sql-licence';
import { countOf, groupResources, type ResourceGroup } from './prompt';
import { calculatorModelId, type CalculatorModelTier } from './model-router';
import { ADAPTER_REGISTRY_VERSION, compileWithCalculatorAdapter } from './service-adapters';
import { parseServiceCatalog, resolveConfigAgainstCatalog, validateConfigAgainstCatalog } from './calculator-catalog';
import {
  createExecutionManifest,
  parseSavedEstimateSnapshot,
  validateSavedEstimate,
  type SavedEstimateSnapshot,
} from './calculator-validation';

/**
 * The Cost Calculator estimate pipeline.
 *
 * This replaces an agentic tool-use loop, and it is worth being explicit about why,
 * because the loop was not badly written — it was the wrong shape for the job.
 *
 * Four consecutive live runs of the real COSEC workbook (110 machines) failed, each for
 * a different reason, and every reason was structural rather than a bug in the code:
 *
 *  1. 24 turns, 8 add_service calls, out of clock. The model asked for one tool per
 *     turn; the system prompt told it not to, twice, and it did anyway.
 *  2. Same again after the prompt was rewritten. Asking a model to change its output
 *     shape is not a mechanism you can rely on.
 *  3. Batching finally worked — and the run died at turn 9 with 477 of 660 seconds
 *     unspent, because a batch is thousands of output tokens and output generation is
 *     the wall clock. Along the way the model created a SECOND estimate at turn 20,
 *     orphaning everything it had added to the first.
 *  4. AI_OUTPUT_TRUNCATED: one generation carrying a line item per group, with its
 *     arithmetic spelled out, exceeded 16k output tokens. Unparseable, so the whole
 *     run was lost.
 *
 * The common thread: every one of those failures is a consequence of asking a model to
 * emit, token by token, work that is not a language problem. Grouping 110 rows is a
 * hash. Multiplying a rate by hours by a count is arithmetic. Neither benefits from
 * being generated, and generation is precisely what costs the minutes and what
 * truncates. So the model is left with the one job it is actually needed for — reading
 * a human's messy spreadsheet wording and saying what AWS service it means — and code
 * does the rest.
 *
 * What that buys, concretely:
 *  - No turn ceiling, so "ran out of turns" cannot happen.
 *  - Pricing is parallel instead of serial: 25 groups take one round trip, not 25.
 *  - Nothing can create a second estimate: build_estimate is called once, by code.
 *  - The classifier's output is bounded per call and the calls are chunked, so no
 *    single generation can hit max_tokens.
 *  - Every model call is optional. Each has a deterministic fallback, so a Bedrock
 *    failure degrades the narrative — never the priced estimate.
 *
 * And the one capability given up, stated plainly: the loop could react to a failed
 * price lookup by rethinking its filters. That is replaced by a narrower, cheaper
 * mechanism — a single repair call listing only the groups that came back unpriced
 * (see repairMisses) — which handles the same case without putting a model in the
 * critical path of the 95% that resolve first time.
 */

const REGION = process.env.AWS_REGION || 'ap-south-1';
const MCP_PACKAGE_VERSION = 'sample-aws-pricing-calculator-mcp@1.2.9';

/**
 * How many price lookups are in flight at once.
 *
 * Four, not eight. The Price List API throttles, and on the live 110-machine run eight in
 * flight produced a "Rate exceeded" that dropped a machine out of the estimate. Retries
 * and the per-run cache both cover for that now, but the cheapest fix is not to provoke it:
 * with duplicates collapsed there are far fewer distinct lookups to make, so four is no
 * slower in practice and is materially less likely to be rate-limited.
 */
const PRICE_CONCURRENCY = 4;

/**
 * Groups per classifier call.
 *
 * The bound that makes AI_OUTPUT_TRUNCATED structurally impossible: each call emits one
 * small JSON object per group, so 12 groups is well inside a 4k ceiling however verbose
 * the model is. Chunks run concurrently, which is the speed win a serial loop could not
 * have — twelve chunks cost one round trip, not twelve.
 */
const CLASSIFY_CHUNK = 12;

/** Output ceiling for a classifier chunk. Generous for 12 small objects. */
const CLASSIFY_MAX_TOKENS = 4_000;

/** Output ceiling for the narrative. Prose only: no line items, no arithmetic. */
const NARRATE_MAX_TOKENS = 4_000;

/** Per-Bedrock-call ceiling. Bounded output means bounded time; this is a backstop. */
const MODEL_CALL_TIMEOUT_MS = 120_000;

/** The sidecar's save call gets its own budget: it talks to the live calculator API. */
const SAVE_TIMEOUT_MS = 180_000;

/** Whole-pipeline budget, inside the orchestrator Lambda's own timeout. */
const PIPELINE_DEADLINE_MS = 11 * 60 * 1000;

/** Line items the report will carry. Beyond this the tail is summarised, not dropped. */
const MAX_LINE_ITEMS = 400;

/**
 * Ceiling on per-server rows carried on the result.
 *
 * The whole result is stored on a DynamoDB item capped at 400KB, and a landscape of a few
 * thousand machines would not fit -- the write would fail and take a fully priced estimate
 * down with it. Above this the rows are dropped as a set rather than truncated, because a
 * workbook listing the first 400 of 3,000 servers under a correct grand total is a document
 * that silently disagrees with itself. The Excel export then lists priced groups instead,
 * which is complete, and an assumption says so.
 */
const MAX_SERVER_ROWS = 400;

export interface PipelineProgress {
  (update: { stage: string; message: string }): Promise<void> | void;
}

export interface PipelineOutcome {
  result: CalculationResult;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  /** Bedrock calls made. Named `iterations` to match what the record already stores. */
  iterations: number;
  /** Every priced lookup and sidecar call, for the diagnostics counter. */
  toolCalls: { name: string; isError: boolean }[];
}

/**
 * What one group needs in order to be priced and added to an estimate.
 *
 * Derived by code where the sheet is clear (an instance type is a strong signal), and by
 * the model only where it is not. `basis` records which, because a report that cannot say
 * where a mapping came from cannot be audited.
 */
export interface GroupPlan {
  /** Price List service code, e.g. AmazonEC2. */
  serviceCode: string;
  /** TERM_MATCH filters for the compute rate. */
  filters: Record<string, string>;
  /** Commitment to price against, parsed from the sheet's own purchase-model wording. */
  term?: PriceTerm;
  /** calculator.aws service key for build_estimate, when one applies. */
  calculatorKey?: string;
  /** Config fields for build_estimate, merged over the catalogue's minimalConfig. */
  calculatorConfig?: Record<string, unknown>;
  /** How this plan was arrived at, quoted in assumptions when it was not obvious. */
  basis: string;
  /** Set when neither code nor model could map the group; it stays visibly unpriced. */
  unsupported?: string;
  /** Price List can still diagnose this line, but the Calculator compiler must not fake it. */
  calculatorUnsupported?: string;
  storageOwner?: 'ec2-ebs' | 'service-native' | 'none';
  fingerprintFields?: string[];
}

// ---------------------------------------------------------------------------
// Deterministic classification
//
// The point of this section is that the model is not called at all for the common
// case. An inventory row that names an instance type has already told us everything
// the Price List needs; putting a language model in front of that is pure latency and
// a chance to be wrong. On the worked example every one of the 25 groups resolves
// here, which is why the pipeline finishes in a fraction of the loop's time.
// ---------------------------------------------------------------------------

/** m6a.xlarge, t3.medium, c6g.2xlarge, r5b.metal. */
const EC2_INSTANCE_TYPE = /^([a-z][a-z0-9]*[0-9][a-z]*)\.([a-z0-9]+)$/;
/** db.t3.medium, db.r6g.large — an RDS instance carries the db. prefix. */
const RDS_INSTANCE_TYPE = /^db\.([a-z][a-z0-9]*[0-9][a-z]*)\.([a-z0-9]+)$/;

/**
 * Operating system as the Price List names it.
 *
 * Not cosmetic: Windows m6a.xlarge in eu-central-1 is $0.391/hr against Linux's
 * $0.2064 — verified live. Reading "Win2019" as Linux would halve the compute bill of
 * every Windows machine in the estimate and report no error.
 */
function priceListOs(os: string | undefined): string {
  const text = String(os || '').toLowerCase();
  if (!text) return 'Linux';
  if (text.includes('rhel') || text.includes('red hat')) return 'RHEL';
  if (text.includes('suse') || text.includes('sles')) return 'SUSE';
  if (text.includes('win')) return 'Windows';
  return 'Linux';
}

/**
 * Bundled SQL Server licence, as the Price List's preInstalledSw attribute names it.
 *
 * The single largest per-machine cost a sheet can state and an estimate can miss. SQL
 * Server Standard on an m6a.xlarge roughly doubles the hourly rate and Enterprise more
 * than trebles it, because the licence is charged per vCPU. A row reading "Windows 2019 +
 * SQL Server Standard" priced as plain Windows is not a rounding error, it is a different
 * quotation — and it fails silently, because plain Windows is a real rate.
 *
 * The reverse costs just as much, which is why the rules live in shared/sql-licence.ts and
 * are read by the upload parser too: a row the sheet marks BYOL, or Express, carries no
 * licence charge at all and must be priced on the plain OS rate.
 */
function priceListSql(text: string): 'NA' | 'SQL Std' | 'SQL Web' | 'SQL Ent' {
  return sqlLicensing(text).billed;
}

/** Everything a group says about its software, which is where a licence is named. */
function licenceText(group: ResourceGroup): string {
  return `${group.os || ''} ${group.service || ''}`;
}

/** The calculator's own OS option id, which is not spelled the same as the above. */
function calculatorOs(os: string | undefined, sql: 'NA' | 'SQL Std' | 'SQL Web' | 'SQL Ent' = 'NA'): string {
  const base = priceListOs(os);
  if (sql !== 'NA') {
    // The calculator expresses OS and SQL edition as one option id, and it offers the
    // combination for Linux and RHEL as well as Windows.
    const edition = sql === 'SQL Ent' ? 'enterprise' : sql === 'SQL Web' ? 'web' : 'std';
    if (base === 'Windows') return `windows-${edition}`;
    if (base === 'RHEL') return `rhel-${edition}`;
    return `linux-${edition}`;
  }
  switch (base) {
    case 'Windows': return 'windows';
    case 'RHEL': return 'rhel';
    case 'SUSE': return 'suse';
    default: return 'linux';
  }
}

/**
 * Reads a commitment out of however the sheet worded it.
 *
 * "3-Yr No Upfront", "3 year RI no upfront", "RI-3Y", "Savings Plan (1yr)" — all real
 * spellings of a term, and all worth more than a rounding difference: a 3-year standard
 * RI on m6a.xlarge/Linux in eu-central-1 is $0.0939/hr against $0.2064 on-demand.
 * Pricing a committed fleet at on-demand overstates the bill by more than double.
 *
 * Returns undefined for on-demand and for anything unrecognised, because quoting a
 * discount the sheet did not ask for is the more damaging error of the two.
 */
export function parseTerm(purchaseModel: string | undefined): PriceTerm | undefined {
  const text = String(purchaseModel || '').toLowerCase();
  if (!text) return undefined;
  if (/on[- ]?demand|ondemand|pay[- ]as[- ]you[- ]go/.test(text)) return undefined;

  const committed = /reserv|\bri\b|savings?\s*plan|\bsp\b|commit|upfront|\d\s*[-\s]?(yr|year)/.test(text);
  if (!committed) return undefined;

  // 3 years unless the wording says one. The Price List publishes only these two.
  const years: 1 | 3 = /\b1\s*[-\s]?(yr|year)|\bone\s*year|\b1y\b/.test(text) ? 1 : 3;

  const purchase: PriceTerm['purchase'] = /all\s*upfront/.test(text)
    ? 'All Upfront'
    : /partial\s*upfront/.test(text)
      ? 'Partial Upfront'
      : 'No Upfront';

  // Standard is what "3-Yr No Upfront" means; convertible has to be asked for by name.
  const offeringClass: PriceTerm['offeringClass'] = /convertible/.test(text) ? 'convertible' : 'standard';

  return { years, purchase, offeringClass };
}

/**
 * The same wording, read as WHICH instrument was asked for rather than as a term.
 *
 * `parseTerm` above answers "what reserved term do I look up", and it deliberately folds a
 * Savings Plan onto the equivalent Reserved Instance term — see the test that pins that,
 * which calls them real spellings of the same thing. They are not quite: a Compute Savings
 * Plan and a Reserved Instance have different rates and very different coverage, and the
 * Price List API this pipeline reads publishes only the Reserved half. So the estimate
 * continues to price a Savings Plan row at the Reserved rate, because that is the closest
 * published figure and every existing estimate already uses it — but the substitution now
 * has to be *reported*, and that needs the distinction this function preserves and
 * `parseTerm` throws away.
 *
 * It also feeds the per-service eligibility check, which is what makes a mixed scenario
 * possible: knowing a commitment was requested is not enough to know whether the service
 * in question can take one.
 */
/**
 * Does this scenario's own wording name a span of time rather than a variant of the workload?
 *
 * Only reached for a requested scenario, which states no `kind` of its own -- the request is a
 * label and a pricing model, and whether five of them are consecutive years or three of them
 * are alternative terms decides whether a reader may add the totals up. Getting it wrong in
 * the additive direction is the expensive one: five fiscal years summed as though concurrent
 * overstates the estate roughly fivefold.
 *
 * Deliberately narrow. It looks for a four-digit year, a two-digit fiscal pair such as
 * "26-27", the letters FY, or the word "year"; anything else is treated as a variant, which is
 * the safe default because variants are stated as replacing one another rather than adding.
 */
const PERIOD_LABEL = /\b(?:19|20)\d{2}\b|\b\d{2}\s*[-\u2013/]\s*\d{2}\b|\bfy\b|\byears?\b/i;

/**
 * One named configuration to price.
 *
 * A segment is a contiguous run of the flat priced array, and its key is how it is found
 * again afterwards. It replaced a hardcoded baseline/right-sized pair that could only ever
 * describe two configurations and told them apart by slicing the priced array at one known
 * offset. A transposed upload states as many as it likes -- docs/Digital_Assets.xlsx states
 * eight, five fiscal years and three lower environments -- and each needs its own total.
 */
export interface Segment {
  key: string;
  label: string;
  kind: 'sizing' | 'period' | 'environment';
  detail: string;
  groups: ResourceGroup[];
  /**
   * The commitment every group in this segment is priced against.
   *
   * Set only when the segment came from a STATED request. Left unset when the segment came
   * from the sheet, in which case each group keeps its own `purchaseModel` cell -- a
   * capacity model routinely states different terms per service, and overwriting them all
   * with one term would reprice a workload nobody asked to reprice.
   */
  commitment?: CommitmentRequest;
  /** Closed plan vocabulary when the scenario was explicitly requested. */
  pricingModel?: string;
}

/**
 * The scenarios the requester actually asked for, turned into segments to price.
 *
 * These take precedence over the sheet's own bands, and that ordering is the point of the
 * field: the sheet says what the workload IS, and the request says which configurations of it
 * are wanted. A request for three pricing models across five years cannot be read out of an
 * inventory, because the inventory states neither.
 *
 * Returns the bands that matched no rows alongside the ones that did, rather than dropping
 * them. A band asked for and not delivered is the failure this whole path exists to make
 * visible: a matrix request carried as prose could lose a band with nothing to show it had,
 * and the document would look complete at seventeen links.
 *
 * Extracted from the pipeline so it can be tested without a Bedrock client or an MCP sidecar.
 * The two mistakes it can make are both silent -- a lost band, and a band filed as concurrent
 * when it is consecutive -- so it is the last logic in this file that should be reachable only
 * through a live run.
 */
export function planSegments(
  requested: EstimateScenarioRequest[],
  priceable: CalculationResource[],
  bands: NonNullable<WorkbookInsights['bands']>,
  hoursFor: Map<string, number>,
  requirements: RequirementConstraint[] = [],
): { segments: Segment[]; unmatched: string[] } {
  const segments: Segment[] = [];
  const unmatchedRequests: string[] = [];
  if (!requested.length) return { segments, unmatched: unmatchedRequests };

  const bandLabel = new Map(bands.map((band) => [band.key, band.label.trim().toLowerCase()]));
  const usedKeys = new Set<string>();
  requested.forEach((scenario, index) => {
    const wanted = scenario.environments
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const scenarioLabels = [scenario.scope, scenario.label]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    const matchingBandKeys = new Set(bands
      .filter((band) => scenarioLabels.some((label) => {
        const bandName = band.label.trim().toLowerCase();
        return label === bandName || label.includes(bandName) || bandName.includes(label);
      }))
      .map((band) => band.key));
    const rows = wanted.length
      ? priceable.filter((row) => {
        // Matched against the row's own environment AND the label of the band it sits in,
        // because the two layouts record an environment in different places: a flat sheet
        // has an Environment column, and a transposed capacity model has it in the column
        // heading, which reaches here as a band. "UAT" means the same thing in both, and a
        // request should not have to know which shape the upload happened to be.
        const own = String(row.environment || '').trim().toLowerCase();
        const band = row.scenario ? bandLabel.get(row.scenario) || '' : '';
        return wanted.some((name) => (own && (own === name || own.includes(name)))
          || (band && (band === name || band.includes(name))));
      })
      : matchingBandKeys.size
        ? priceable.filter((row) => Boolean(row.scenario && matchingBandKeys.has(row.scenario)))
        : priceable;

    const groups = groupResources(rows, hoursFor, 'baseline').map((group) => {
      let adjusted = group;
      for (const requirement of requirements) {
        if (!requirement.scope.includes(`scenario:${index}`)) continue;
        const serviceScopes = requirement.scope
          .filter((scope) => scope.startsWith('service:'))
          .map((scope) => normalizedSelector(scope.slice('service:'.length)));
        const service = normalizedSelector(group.service);
        if (serviceScopes.length && !serviceScopes.some((wanted) => serviceSelectorMatches(service, wanted))) continue;
        if (requirement.field !== 'resource.hours_per_month') continue;
        const hours = Number(requirement.expected);
        if (!Number.isFinite(hours) || hours <= 0 || hours > 744) continue;
        const previousHours = adjusted.hoursPerMonth ?? (adjusted.hoursPerDay / 24) * HOURS_PER_MONTH;
        const scale = previousHours > 0 ? hours / previousHours : 1;
        adjusted = {
          ...adjusted,
          hoursPerMonth: hours,
          hoursPerDay: Math.max(1, Math.min(24, Math.round((hours / HOURS_PER_MONTH) * 24))),
          quantities: adjusted.quantities?.map((quantity) => /-hours\/month$/i.test(quantity.unit)
            ? {
              ...quantity,
              amount: quantity.amount * scale,
              conversions: [...quantity.conversions, `confirmed scenario runtime: ${hours} hours/month`],
            }
            : quantity),
        };
      }
      return adjusted;
    });
    if (!groups.length) {
      unmatchedRequests.push(
        `"${scenario.label}" was requested`
        + (wanted.length ? ` for ${scenario.environments.join(', ')}` : '')
        + ' but matched no rows in the uploaded inventory, so it was not priced.',
      );
      return;
    }

    // Slugged from the label so the key means something in the saved result and in a
    // document's contents list; suffixed only on a genuine collision, because two
    // scenarios sharing a key would have one overwrite the other's total.
    const base = scenario.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      || `scenario-${index + 1}`;
    let key = base;
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}-${n}`;
    usedKeys.add(key);

    // Environment bands run concurrently and so add up; anything else is one workload
    // costed more than one way. A five-year projection is consecutive, and three pricing
    // models of the same estate are alternatives -- in both cases only one of the totals
    // will ever be spent, which is exactly what `sizing` already means here.
    const kind: Segment['kind'] = wanted.length
      ? 'environment'
      : PERIOD_LABEL.test(`${scenario.scope || ''} ${scenario.label}`)
        ? 'period'
        : 'sizing';

    segments.push({
      key,
      label: scenario.label,
      kind,
      detail: [
        scenario.scope ? `${scenario.scope}.` : '',
        `Priced as ${describeRequest(scenario.pricing_model)}, from today's live AWS rates.`,
        wanted.length
          ? `Covers ${scenario.environments.join(', ')} only. Concurrent with the other environments, so these totals do add up.`
          : kind === 'period'
            ? 'Consecutive with the other periods, so this total replaces theirs rather than adding to them.'
            : 'The same workload on different terms, so only one of these totals will ever be spent.',
        scenario.note || '',
      ].filter(Boolean).join(' '),
      groups,
      commitment: commitmentFromRequest(scenario.pricing_model),
      pricingModel: scenario.pricing_model,
    });
  });

  return { segments, unmatched: unmatchedRequests };
}

export function parseCommitment(purchaseModel: string | undefined): CommitmentRequest {
  const term = parseTerm(purchaseModel);
  if (!term) return { model: 'on-demand' };

  const text = String(purchaseModel || '').toLowerCase();
  // Reserved wins when a cell names both, which real sheets do: "1-Year RI with Compute
  // Savings Plan" is one line describing a mixed commitment, and the Reserved half is the
  // half that can actually be priced from published rates.
  const namesReserved = /reserv|\bri\b/.test(text);
  const namesSavingsPlan = /savings?\s*plan|\bcsp\b/.test(text);
  if (namesSavingsPlan && !namesReserved) {
    return { model: 'compute-savings-plan', years: term.years };
  }

  return {
    model: 'reserved',
    years: term.years,
    purchase: term.purchase,
    offeringClass: term.offeringClass,
  };
}

/**
 * A plan derived from the row alone, or undefined when the model is needed.
 *
 * Deliberately conservative: it only claims a group it can map with confidence, and
 * anything else falls through to the classifier. A wrong deterministic guess is worse
 * than a model call, because it is silent.
 */
export function planFromGroup(group: ResourceGroup, defaultRegion: string): GroupPlan | undefined {
  const size = String(group.size || '').trim();
  const region = group.region || defaultRegion;
  const term = parseTerm(group.purchaseModel);

  const adapted = compileWithCalculatorAdapter(group, { defaultRegion, term });
  if (adapted) return adapted;

  const rds = RDS_INSTANCE_TYPE.exec(size);
  if (rds) {
    // The engine governs the rate and the sheet does not always name it, so an
    // unnamed engine is left to the classifier rather than assumed.
    const engine = readEngine(group);
    if (!engine) return undefined;

    // Aurora carries its own calculator service, and its config shape is a
    // columnFormIPM row set rather than flat fields. Verified end to end against the
    // deployed sidecar: on-demand and every 1yr/3yr x upfront reserved tuple save and
    // export cleanly with these keys. The reserved columns are rebuilt around the
    // effective commitment at pricing time, alongside pricingStrategy (priceGroups).
    if (engine.startsWith('Aurora')) {
      return {
        serviceCode: 'AmazonRDS',
        filters: { instanceType: size, databaseEngine: engine },
        term,
        // The MySQL and PostgreSQL variants share this exact column form; both keys and
        // both term shapes were verified against the live sidecar.
        calculatorKey: engine === 'Aurora MySQL'
          ? 'amazonAuroraMySQLCompatible'
          : 'amazonRDSAuroraPostgreSQLCompatibleDB',
        calculatorConfig: auroraCalculatorConfig(group, region, size, term),
        basis: `RDS instance type read from the sheet (${size}, ${engine})`,
      };
    }
    return {
      serviceCode: 'AmazonRDS',
      filters: { instanceType: size, databaseEngine: engine },
      term,
      basis: `RDS instance type read from the sheet (${size}, ${engine})`,
    };
  }

  // ElastiCache node types are RDS's shape with a cache. prefix and no databaseEngine,
  // so they are matched deterministically rather than left to the classifier. The link
  // is configured On-Demand unconditionally: the live sidecar's export lint refuses
  // EVERY reserved tuple probed for amazonElastiCache (1yr/3yr x No/Partial/All Upfront)
  // as a combination that misprices silently, so there is no committed link to build.
  if (CACHE_INSTANCE_TYPE.test(size)) {
    return {
      serviceCode: 'AmazonElastiCache',
      filters: { instanceType: size, cacheEngine: 'Redis' },
      term,
      calculatorKey: 'amazonElastiCache',
      calculatorConfig: elasticacheCalculatorConfig(group, region, size),
      basis: `ElastiCache node type read from the sheet (${size})`,
    };
  }

  const ec2 = EC2_INSTANCE_TYPE.exec(size);
  if (ec2) {
    const os = priceListOs(group.os);
    // The sheet names a bundled SQL Server licence in whichever column it feels like, so
    // both the OS and the service description are read for it.
    const sql = priceListSql(licenceText(group));
    return {
      serviceCode: 'AmazonEC2',
      filters: {
        instanceType: size,
        operatingSystem: os,
        // Overrides the EC2_DEFAULTS 'NA': the licence is a different SKU, not a surcharge
        // on the plain one, so it has to be in the filter to be in the rate.
        ...(sql !== 'NA' ? { preInstalledSw: sql } : {}),
      },
      term,
      calculatorKey: 'ec2Enhancement',
      calculatorConfig: {
        region,
        // The lint reports tenancy as a missing required field if it is left out, despite
        // the catalogue claiming EstimateBuilder injects it. Verified against the live
        // sidecar: without this the service saves only partially. Shared is also what the
        // Price List rate is read for (EC2_DEFAULTS tenancy: 'Shared').
        tenancy: 'shared',
        instanceType: size,
        selectedOS: calculatorOs(group.os, sql),
        // workload IS the instance count — the catalogue's traps[] is explicit that
        // stashing the count anywhere else prices the estimate for one machine.
        workload: group.count,
        // Utilisation is hidden inside pricingStrategy and set via this top-level
        // field; the calculator has no other way to express a part-time machine.
        // The same whole percentage the report bills on, so the two agree exactly.
        utilization: String(billedPct(group, term)),
        pricingStrategy: calculatorPricingStrategy(term),
        // The disk goes on the EC2 service itself, not a separate EBS one: the field is
        // labelled "Storage for each EC2 instance" and the calculator multiplies it by
        // workload. Omitting it was why a saved link totalled less than this report — the
        // report priced every disk and the link priced none of them.
        //
        // group.diskGb is already the group total (disk_gb x count), so it is divided
        // back down to per-instance here; passing the total would bill count x the disk.
        ...(group.diskGb > 0
          ? {
            storageType: 'Storage General Purpose gp3 GB Mo',
            // { value, unit }, not a bare number: the live sidecar rejects a plain integer
            // with 'expected { value, unit } object (e.g. unit "gb|NA")'. The unit string
            // is size|frequency, and gp3 is billed per GB-month, so frequency is NA.
            storageAmount: {
              value: Math.max(1, Math.round(group.diskGb / Math.max(1, group.count))),
              unit: 'gb|NA',
            },
          }
          : {}),
        description: `${group.count} x ${size} ${os}${sql !== 'NA' ? ` + ${sql}` : ''}${group.environment ? ` (${group.environment})` : ''}`,
      },
      basis: `EC2 instance type read from the sheet (${size}, ${os}${sql !== 'NA' ? `, ${sql}` : ''})`,
    };
  }

  return undefined;
}

/** A cache. node type — ElastiCache's own prefix, distinct from RDS's db. one. */
const CACHE_INSTANCE_TYPE = /^cache\.[a-z][a-z0-9]*[0-9][a-z]*\.[a-z0-9]+$/;

/**
 * The calculator's columnFormIPM row for one Aurora instance set, in the exact shape the
 * live sidecar's valueShape documents and its export lint accepts.
 */
function auroraCalculatorConfig(
  group: ResourceGroup,
  region: string,
  size: string,
  term: PriceTerm | undefined,
): Record<string, unknown> {
  return {
    region,
    // The lint refuses the export without it ("required component \"edition\" missing"),
    // even though the field list marks nothing required.
    edition: 'auroraStandard',
    columnFormIPM: {
      value: [{
        'Number of Nodes': { value: String(group.count) },
        'Instance Type': { value: size },
        'undefined': { value: { unit: '100', selectedId: '%Utilized/Month' } },
        'Instance Family': { value: 'Memory optimized' },
        TermType: { value: term ? 'Reserved' : 'OnDemand' },
        ...(term ? {
          LeaseContractLength: { value: term.years === 1 ? '1yr' : '3yr' },
          PurchaseOption: { value: term.purchase },
        } : {}),
      }],
    },
    description: `${group.count} x ${size}${group.environment ? ` (${group.environment})` : ''}`,
  };
}

/**
 * The ElastiCache column form, live-verified the same way. TermType stays OnDemand
 * unconditionally: every reserved tuple the probe tried was refused by the export lint
 * as a combination that misprices silently.
 */
function elasticacheCalculatorConfig(
  group: ResourceGroup,
  region: string,
  size: string,
): Record<string, unknown> {
  return {
    region,
    columnFormIPM: {
      value: [{
        'Number of Nodes': { value: String(group.count) },
        'Instance Type': { value: size },
        'undefined': { value: { unit: '100', selectedId: '%Utilized/Month' } },
        'Cache Engine': { value: 'Redis' },
        'Instance Family': { value: 'Memory optimized' },
        TermType: { value: 'OnDemand' },
      }],
    },
    description: `${group.count} x ${size}${group.environment ? ` (${group.environment})` : ''}`,
  };
}

/** Database engine as the Price List names it, or undefined when the sheet is silent. */
function readEngine(group: ResourceGroup): string | undefined {
  const text = `${group.service || ''} ${group.os || ''}`.toLowerCase();
  // Aurora is tested before the plain engines because "Aurora MySQL" contains "mysql":
  // tested in the old order it read as plain MySQL and priced the wrong family.
  // Engine-less Aurora is ambiguous and must be resolved in the review plan.
  if (/aurora/.test(text)) return /mysql/.test(text)
    ? 'Aurora MySQL'
    : /postgres/.test(text) ? 'Aurora PostgreSQL' : undefined;
  if (/postgres/.test(text)) return 'PostgreSQL';
  if (/mysql/.test(text)) return 'MySQL';
  if (/maria/.test(text)) return 'MariaDB';
  if (/oracle/.test(text)) return 'Oracle';
  if (/sql\s*server|mssql/.test(text)) return 'SQL Server';
  return undefined;
}

/**
 * What share of the month this group runs, as the whole percentage BOTH sides use.
 *
 * The calculator's `utilization` field is an integer 1–100 and there is no way to express
 * anything finer, so a schedule of 8h/day is 33% there whatever we do. If the report
 * derived its hours independently — 730 x 8/24 = 243.33 — every part-time group would
 * read about 1% higher in the PDF than in the shareable link, and a client comparing the
 * two would find a discrepancy on every scheduled machine with no way to explain it.
 *
 * So the rounded percentage is computed once, here, and both the priced report and the
 * calculator config are derived from it. The two cannot disagree, by construction.
 */
export function billedPct(group: ResourceGroup, term?: PriceTerm): number {
  // A commitment is billed for the whole month whether or not the instance is running:
  // that is what a Reserved Instance or a Savings Plan is. A row marked both "3-Yr No
  // Upfront" and "8 hours a day" is a contradiction in the sheet, and the figure the
  // client will actually be invoiced is the full month — so pricing it at a third of one
  // would understate their bill by two thirds on that row and could not be defended.
  if (term) return 100;
  const exact = group.hoursPerMonth !== undefined
    ? (group.hoursPerMonth / HOURS_PER_MONTH) * 100
    : (group.hoursPerDay / 24) * 100;
  return Math.max(1, Math.min(100, Math.round(exact)));
}

/**
 * pricingStrategy in the shape the calculator accepts.
 *
 * The catalogue's traps[] is emphatic here: the shorthand strings "reserved" and
 * "instanceSavings" may silently fall back to On-Demand or produce $0 costs, and real
 * Standard/Convertible RIs are HIDDEN under shared tenancy. So a commitment is always
 * expressed as the full object form, as an instance Savings Plan — which is the
 * committed discount actually available on shared tenancy.
 */
function calculatorPricingStrategy(term?: PriceTerm): unknown {
  if (!term) return 'ondemand';
  return {
    model: 'instanceSavings',
    term: term.years === 1 ? '1 Year' : '3 Year',
    upfrontPayment: term.purchase === 'All Upfront'
      ? 'All'
      : term.purchase === 'Partial Upfront' ? 'Partial' : 'None',
  };
}

// ---------------------------------------------------------------------------
// The model's one job
// ---------------------------------------------------------------------------

/**
 * One bounded, single-shot Bedrock call.
 *
 * No tools, no conversation, an explicit output ceiling and its own timeout. Every model
 * call in this pipeline goes through here, which is what makes the truncation failure
 * impossible to reintroduce by accident: there is one place where max_tokens is set and
 * one place where a caller chooses it.
 */
async function askModel(
  client: BedrockRuntimeClient,
  input: {
    system: string;
    user: string;
    maxTokens: number;
    tier: Exclude<CalculatorModelTier, 'CODE'>;
    timeoutMs?: number;
  },
): Promise<string> {
  const modelId = calculatorModelId(input.tier);
  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.user }] }],
  };
  // Sonnet 5 rejects an explicit temperature; every builder in this repo guards the same
  // way, and the guard is kept identical so behaviour stays consistent across models.
  if (!modelId.includes('claude-sonnet-5')) body.temperature = 0;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? MODEL_CALL_TIMEOUT_MS);
  try {
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }),
      { abortSignal: abort.signal },
    );
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const text = (payload?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('\n')
      .trim();
    console.log(JSON.stringify({
      event: 'calculator_model_call',
      tier: input.tier,
      modelId,
      latencyMs: Date.now() - startedAt,
      inputTokens: payload?.usage?.input_tokens,
      outputTokens: payload?.usage?.output_tokens,
      validText: Boolean(text),
    }));
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls the first balanced JSON array out of a model reply. */
function parseJsonArray(text: string): any[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('no JSON array in the reply');
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('reply was not an array');
  return parsed;
}

const CLASSIFY_SYSTEM = `You map rows of a client's cost spreadsheet onto AWS Price List Query API lookups. You are not pricing anything and you are not writing prose.

For each numbered group you are given, return one JSON object:
{"group": <number>, "serviceCode": "<Price List service code>", "filters": {"<attribute>": "<value>"}, "note": "<short reason>"}

Rules:
- serviceCode is the Price List code, e.g. AmazonEC2, AmazonRDS, AmazonS3, AWSELB, AmazonVPC, AmazonEFS, AmazonFSx, AWSBackup, AmazonCloudWatch.
- filters are TERM_MATCH attributes exactly as that API names them. Use the fewest that identify one rate. Common ones:
  - EC2 compute: {"instanceType":"m5.large","operatingSystem":"Linux"}
  - EBS volume: {"volumeApiName":"gp3"}
  - RDS instance: {"instanceType":"db.t3.medium","databaseEngine":"PostgreSQL"}
  - S3 storage: {"storageClass":"General Purpose","volumeType":"Standard"}
  - Application load balancer: {"productFamily":"Load Balancer-Application"}
  - NAT gateway: {"productFamily":"NAT Gateway"}
  - EFS storage: {"storageClass":"General Purpose"}
- Where a group states vCPU and RAM but no instance type, choose the smallest current-generation instance that meets BOTH, and say which in note.
- If a group genuinely cannot be mapped to a published AWS rate, return {"group": <number>, "serviceCode": null, "note": "<why>"}. A named gap is a correct answer; an invented mapping is not.

Return ONLY the JSON array. No commentary before or after it.`;

/**
 * Maps the groups code could not, in bounded parallel chunks.
 *
 * Chunking is the fix for AI_OUTPUT_TRUNCATED and the source of the speed at once: the
 * output per call is bounded by construction, and independent chunks are one round trip
 * rather than N. A chunk that fails or comes back unparseable leaves its groups
 * unsupported instead of failing the estimate — the whole pipeline is built so that a
 * model fault costs detail, never the run.
 */
async function classifyGroups(
  client: BedrockRuntimeClient,
  pending: { index: number; group: ResourceGroup }[],
  defaultRegion: string,
  onCall: () => void,
): Promise<Map<number, GroupPlan>> {
  const plans = new Map<number, GroupPlan>();
  if (!pending.length) return plans;

  const chunks: typeof pending[] = [];
  for (let at = 0; at < pending.length; at += CLASSIFY_CHUNK) {
    chunks.push(pending.slice(at, at + CLASSIFY_CHUNK));
  }

  const replies = await Promise.all(chunks.map(async (chunk) => {
    const lines = chunk.map((entry, at) => {
      const group = entry.group;
      const spec = [
        group.service,
        group.size,
        group.vcpu !== undefined ? `${group.vcpu} vCPU` : '',
        group.ramGb !== undefined ? `${group.ramGb} GB RAM` : '',
        group.os,
        group.diskGb > 0 ? `${Math.round(group.diskGb)} GB disk` : '',
        group.environment ? `env=${group.environment}` : '',
        `region=${group.region || defaultRegion}`,
      ].filter(Boolean).join(' | ');
      return `${at + 1}. ${spec}`;
    });

    onCall();
    try {
      const text = await askModel(client, {
        system: CLASSIFY_SYSTEM,
        user: `Map these ${chunk.length} group(s):\n${lines.join('\n')}`,
        maxTokens: CLASSIFY_MAX_TOKENS,
        tier: 'HAIKU_4_5',
      });
      return { chunk, entries: parseJsonArray(text) };
    } catch (error) {
      console.warn(`Haiku classifier chunk failed (${(error as Error).message}); escalating once.`);
      onCall();
      try {
        const text = await askModel(client, {
          system: CLASSIFY_SYSTEM,
          user: `The constrained mapper failed. Resolve these ambiguous group(s) and return only the required JSON array:\n${lines.join('\n')}`,
          maxTokens: CLASSIFY_MAX_TOKENS,
          tier: 'SONNET_4_6',
        });
        return { chunk, entries: parseJsonArray(text) };
      } catch (repairError) {
        console.warn(`Classifier escalation failed (${(repairError as Error).message}); its groups stay unpriced.`);
        return { chunk, entries: [] as any[] };
      }
    }
  }));

  for (const { chunk, entries } of replies) {
    for (const entry of entries) {
      // 1-based within its own chunk, which is what the prompt asked for.
      const at = Number(entry?.group) - 1;
      const target = chunk[at];
      if (!target) continue;
      const serviceCode = typeof entry?.serviceCode === 'string' ? entry.serviceCode.trim() : '';
      if (!serviceCode) {
        plans.set(target.index, {
          serviceCode: '',
          filters: {},
          basis: 'not mapped',
          unsupported: String(entry?.note || 'no published AWS rate could be identified'),
        });
        continue;
      }
      const filters: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry?.filters || {})) {
        if (typeof value === 'string' || typeof value === 'number') filters[key] = String(value);
      }
      plans.set(target.index, {
        serviceCode,
        filters,
        term: parseTerm(target.group.purchaseModel),
        basis: String(entry?.note || 'mapped from the sheet description'),
      });
    }
    // A chunk that came back short leaves the rest visibly unpriced rather than
    // silently absent from the estimate.
    for (const entry of chunk) {
      if (!plans.has(entry.index)) {
        plans.set(entry.index, {
          serviceCode: '',
          filters: {},
          basis: 'not mapped',
          unsupported: 'the classifier returned no mapping for this group',
        });
      }
    }
  }

  return plans;
}

// ---------------------------------------------------------------------------
// Pricing and arithmetic — all code, all parallel
// ---------------------------------------------------------------------------

/** One group, priced. Nullable money throughout: an unpriced line stays unpriced. */
export interface PricedGroup {
  group: ResourceGroup;
  plan: GroupPlan;
  computeMonthly: number | null;
  computeWorkings?: string;
  termLabel?: string;
  termFellBack?: boolean;
  /**
   * Whether this group was priced at a committed rate or On-Demand, and why.
   *
   * Per group rather than per estimate, because that is the shape of the truth: a
   * "1-year Reserved" scenario over a real service mix prices Aurora, ElastiCache and
   * OpenSearch at the committed rate while ECS Fargate — which has no reserved purchase
   * model at all — stays On-Demand. Recorded so the report can state that mix instead of
   * letting a reader assume the whole estimate is committed and under-budget for it.
   */
  pricingDecision?: PricingDecision;
  storageMonthly: number | null;
  storageWorkings?: string;
  /**
   * The gp3 GB-month rate this group's storage was priced at.
   *
   * Retained rather than left inside `storageWorkings` prose, so the workbook can state
   * the rate on its Assumptions sheet -- a client checking arithmetic should not have to
   * parse a sentence to find the number every storage line was multiplied by.
   */
  storageRatePerGbMonth?: number;
  /** Why there is no compute figure, when there isn't one. */
  miss?: string;
}

/** Runs tasks with a fixed number in flight. Order of results matches order of input. */
async function withConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = cursor;
      cursor += 1;
      if (at >= items.length) return;
      results[at] = await task(items[at], at);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Hours this group is billed for in a month.
 *
 * hrs/month wins where the sheet states it, because the most common real schedule cannot
 * be expressed as whole hours a day: "12x5" is 260 hours a month, which is 8.55 hours a
 * day averaged out. Re-deriving it from a rounded hours-per-day would move the figure.
 */
/**
 * The disk a group is billed for, as the same figure the calculator will bill.
 *
 * The calculator takes storage per instance and multiplies by the instance count, so a
 * group total that does not divide evenly is rounded there whatever we do. Rounding it
 * the same way here keeps the report's storage line and the link's storage identical
 * instead of a gigabyte or two apart on every group. See billedPct for the same argument
 * applied to hours.
 */
export function diskGbBilled(group: ResourceGroup): number {
  if (group.diskGb <= 0) return 0;
  const count = Math.max(1, group.count);
  return Math.max(1, Math.round(group.diskGb / count)) * count;
}

function billedHours(group: ResourceGroup, term?: PriceTerm): number {
  // Derived from the same whole percentage the calculator is given, so the report's hours
  // and the shareable link's hours are the same number rather than two readings of one
  // schedule. See billedPct.
  return HOURS_PER_MONTH * (billedPct(group, term) / 100);
}

/**
 * The first declared dimension on this group that reconciles with an AWS rate's own unit.
 *
 * First match rather than best match: a resource is billed on each of its dimensions
 * separately and `rate` here is one rate, so the question is only whether this rate can be
 * applied at all. A Fargate group states both vCPU-hours and GB-hours; the vCPU rate
 * reconciles with the first and refuses the second, so which one is "first" cannot change
 * the answer for a given rate.
 *
 * `hours/month` is deliberately skipped, even when a group declares it. The runtime branch
 * that owns hours also owns the rule that a committed instance is billed for the whole
 * month whether or not it is running (see billedPct), and a declared hours figure carries
 * no knowledge of the commitment. Pricing an hourly rate from the declared figure instead
 * would quietly undo that rule and understate every reserved part-time machine — so hours
 * stay with the branch that reasons about them.
 */
function billableQuantity(
  group: ResourceGroup,
  awsUnit: string,
): { quantity: NonNullable<ResourceGroup['quantities']>[number]; match: UnitMatch } | undefined {
  for (const quantity of group.quantities ?? []) {
    if (quantity.unit === INSTANCE_UNIT) continue;
    const match = reconcile(quantity.unit as CanonicalUnit, awsUnit);
    if (match.ok) return { quantity, match };
  }
  return undefined;
}

function evidenceFromCanonical(row: CanonicalRow): CalculationResource['source_evidence'] {
  return row.provenance.slice(0, 100).map((cell) => ({
    sheet: cell.sheet,
    row: cell.row,
    label: cell.label,
    value: cell.value,
  }));
}

function fargateConfiguration(row: CanonicalRow): CalculationResource['configuration'] | undefined {
  if (!/fargate/i.test(row.service || '') || !row.shape) return undefined;
  return {
    fargateTask: {
      taskCount: {
        originalValue: row.shape.countOriginalValue ?? row.shape.count,
        originalUnit: row.shape.countOriginalUnit ?? 'tasks',
        originalPeriod: row.shape.countOriginalPeriod ?? 'month',
        derived: row.shape.countDerivedValue !== undefined ? {
          value: row.shape.countDerivedValue,
          unit: row.shape.countDerivedUnit ?? 'tasks',
          formula: row.shape.countConversionFormula ?? 'no count conversion',
        } : undefined,
        evidence: evidenceFromCanonical(row),
      },
      taskFrequency: row.shape.countOriginalPeriod === 'day' ? 'perDay' : 'perMonth',
      vcpuPerTask: row.shape.vcpu === undefined ? undefined : {
        originalValue: row.shape.vcpu,
        evidence: evidenceFromCanonical(row),
      },
      memoryGbPerTask: row.shape.ramGb === undefined ? undefined : {
        originalValue: row.shape.ramGb,
        originalUnit: 'GB',
        evidence: evidenceFromCanonical(row),
      },
      taskDuration: {
        originalValue: row.shape.durationOriginalValue ?? row.shape.hoursPerUnit,
        originalUnit: row.shape.durationOriginalUnit ?? 'hours',
        originalPeriod: row.shape.durationOriginalPeriod ?? 'month',
        derived: row.shape.durationDerivedValue !== undefined ? {
          value: row.shape.durationDerivedValue,
          unit: row.shape.durationDerivedUnit ?? 'hours',
          formula: row.shape.durationConversionFormula ?? 'no duration conversion',
        } : undefined,
        evidence: evidenceFromCanonical(row),
      },
    },
  };
}

export function resourcesFromCanonicalModel(model: CanonicalWorkbook): CalculationResource[] {
  return model.rows.map((row, index) => {
    const first = row.provenance[0];
    const configuration = fargateConfiguration(row);
    const role = /\b(?:dr|disaster|secondary|standby|replica|replicated)\b/i.test(row.label)
      ? 'DR'
      : undefined;
    return {
      plan_resource_id: row.id || String(index),
      resourceId: row.id,
      role,
      sheet: first?.sheet,
      row: first?.row,
      name: row.label,
      metric: row.label,
      service: row.service,
      scenario: row.scenario?.key,
      environment: row.environment,
      region: row.region,
      size: row.shape?.size,
      os: row.shape?.os,
      purchase_model: row.shape?.purchaseModel,
      quantity: row.shape ? String(row.shape.countOriginalValue ?? row.shape.count) : undefined,
      vcpu: row.shape?.vcpu,
      ram_gb: row.shape?.ramGb,
      hoursPerMonth: row.shape?.hoursPerUnit,
      raw: row.provenance.map((cell) => [cell.section, cell.label, cell.value].filter(Boolean).join(': ')).join(' | ').slice(0, 600),
      quantities: row.quantities.map((quantity) => ({
        unit: quantity.unit,
        amount: quantity.amount,
        originalValue: quantity.originalValue,
        originalUnit: quantity.originalUnit,
        originalScale: quantity.originalScale,
        originalPeriod: quantity.originalPeriod,
        derivedValue: quantity.derivedValue,
        derivedUnit: quantity.derivedUnit,
        derivedScale: quantity.derivedScale,
        derivedPeriod: quantity.derivedPeriod,
        conversionFormula: quantity.conversionFormula,
        basis: quantity.basis,
        conversions: quantity.conversions,
      })),
      attributes: row.attributes,
      notes: row.notes,
      ...(configuration ? { configuration } : {}),
      source_evidence: evidenceFromCanonical(row),
      unresolved_fields: row.unpriced.map((cell) => cell.provenance.label).slice(0, 80),
      readiness: row.unpriced.length ? 'NEEDS_INPUT' : 'SEMANTICALLY_MAPPED',
    };
  });
}

function quantityByUnit(group: ResourceGroup, unit: CanonicalUnit) {
  return (group.quantities ?? []).find((quantity) => quantity.unit === unit);
}

async function priceFargateDimensions(
  group: ResourceGroup,
  region: string,
  onCall: (name: string, isError: boolean) => void,
): Promise<{ monthly?: number; workings?: string; termLabel?: string; miss?: string }> {
  const vcpuHours = quantityByUnit(group, 'vCPU-hours/month');
  const memoryHours = quantityByUnit(group, 'GB-hours/month');
  if (!vcpuHours || !memoryHours) return {};

  const [vcpuRate, memoryRate] = await Promise.all([
    lookupPrice({
      serviceCode: 'AmazonECS',
      region,
      filters: { usagetype: '*Fargate-vCPU-Hours:perCPU' },
    }),
    lookupPrice({
      serviceCode: 'AmazonECS',
      region,
      filters: { usagetype: '*Fargate-GB-Hours' },
    }),
  ]);
  onCall('get_aws_price', !vcpuRate.found);
  onCall('get_aws_price', !memoryRate.found);

  if (!vcpuRate.found || vcpuRate.ratePerUnit === undefined || !memoryRate.found || memoryRate.ratePerUnit === undefined) {
    return {
      miss: [
        !vcpuRate.found ? vcpuRate.message || 'Fargate vCPU-hour price was not found.' : '',
        !memoryRate.found ? memoryRate.message || 'Fargate GB-hour price was not found.' : '',
      ].filter(Boolean).join(' '),
    };
  }

  const vcpu = vcpuRate.ratePerUnit * vcpuHours.amount;
  const memory = memoryRate.ratePerUnit * memoryHours.amount;
  const monthly = vcpu + memory;
  return {
    monthly,
    termLabel: 'on-demand',
    workings: [
      `$${vcpuRate.ratePerUnit.toFixed(6)}/${vcpuRate.unit || 'vCPU-Hours'} x ${round2(vcpuHours.amount)} ${vcpuHours.unit}`,
      `$${memoryRate.ratePerUnit.toFixed(6)}/${memoryRate.unit || 'GB-Hours'} x ${round2(memoryHours.amount)} ${memoryHours.unit}`,
      `= $${monthly.toFixed(2)}/mo`,
      [...vcpuHours.conversions, ...memoryHours.conversions].length
        ? `-- ${[...vcpuHours.conversions, ...memoryHours.conversions].join('; ')}`
        : '',
    ].filter(Boolean).join(' '),
  };
}

/**
 * Prices every group concurrently: compute rate, and the storage rate its disks need.
 *
 * This is the step that replaces most of the old loop's wall clock. 25 groups priced
 * serially at ~1s a lookup was 25 seconds of the model's turn budget plus a round trip
 * each; here they are four batches of eight and the arithmetic is free.
 */
async function priceGroups(
  entries: { group: ResourceGroup; plan: GroupPlan; commitment?: CommitmentRequest }[],
  defaultRegion: string,
  onCall: (name: string, isError: boolean) => void,
): Promise<PricedGroup[]> {
  return withConcurrency(entries, PRICE_CONCURRENCY, async ({ group, plan, commitment }) => {
    const region = group.region || defaultRegion;
    const priced: PricedGroup = {
      group,
      plan,
      computeMonthly: null,
      storageMonthly: null,
    };

    if (plan.unsupported) {
      priced.miss = plan.unsupported;
    } else {
      // Eligibility is settled BEFORE the lookup, not discovered by it.
      //
      // The old flow asked AWS for a commitment on every group and let the answer decide:
      // anything with no published reserved rate fell back to On-Demand and raised a
      // count-only warning. That produced the right number by accident and could not say
      // which services it applied to. Deciding first means a service with no reserved
      // purchase model — Fargate is the standing example — is priced On-Demand
      // deliberately, with a printable reason, and one pointless Price List call is saved
      // per such group.
      // A stated commitment wins over the sheet's own purchase-model cell, and only when one
      // was stated: the whole point of asking for "the same estate on 3-year RI" is that it
      // overrides whatever terms the inventory happens to carry. With nothing requested the
      // cell is still authoritative, so an ordinary upload prices exactly as it did before.
      const decision = resolvePricing(
        { serviceCode: plan.serviceCode, filters: plan.filters },
        commitment ?? parseCommitment(group.purchaseModel),
      );
      priced.pricingDecision = decision;

      // The term the DECISION resolved to, not the one the sheet's own cell parsed to.
      // They are the same thing only when nothing was requested: a stated commitment
      // ("this estate on 1-year RI") resolves to a 1-year term while the sheet's cell
      // still says "3-Yr No Upfront", and pricing the request at the cell's term would
      // quietly hand back a rate for the wrong commitment. `CommittedPricing.term` exists
      // to be handed straight here. An unpriceable Savings Plan request is deliberately
      // not translated to a Reserved term: the diagnostic rate falls back to On-Demand
      // and the manifest marks the requested commercial model unsupported.
      const effectiveTerm = decision.pricing === 'committed'
        ? decision.term
        : undefined;

      const fargatePrice = plan.serviceCode === 'AmazonECS'
        ? await priceFargateDimensions(group, region, onCall)
        : {};

      // The scenario decision is authoritative. The initial deterministic plan was built
      // from the workbook cell, but a reviewed scenario may intentionally override that
      // term; compiling the adapter again here prevents the old term/config from leaking
      // into the saved estimate.
      const scenarioAdapter = compileWithCalculatorAdapter(group, {
        defaultRegion: region,
        term: effectiveTerm,
      });
      if (scenarioAdapter) {
        const {
          calculatorConfig: _oldConfig,
          calculatorKey: _oldKey,
          calculatorUnsupported: _oldUnsupported,
          term: _oldTerm,
          ...stablePlan
        } = plan;
        priced.plan = { ...stablePlan, ...scenarioAdapter };
      }

      // The shareable link must agree with the report, so the config the EC2 path built
      // from the SHEET's cell is rebuilt around the effective commitment here. Cloned
      // rather than mutated: one plan object is shared by every segment that prices the
      // same group, and a reserved segment writing into it would leak its pricing model
      // into the on-demand segment's link.
      if (priced.plan.calculatorConfig) {
        // EC2 is the only Calculator adapter whose custom transform consumes the
        // compiler-only pricingStrategy/utilization keys. Other services must receive
        // only fields from their live Calculator schema; sending these internal keys to
        // them makes build_estimate return needs_field_grounding even when every real
        // service field is valid. A columnFormIPM service (Aurora, ElastiCache) states
        // its commitment inside the column row rather than in a pricingStrategy, so the
        // rebuild covers both shapes without adding EC2 metadata to unrelated services.
        const form = priced.plan.calculatorConfig.columnFormIPM as
          | { value: Array<Record<string, { value: unknown }>> }
          | undefined;
        priced.plan = {
          ...priced.plan,
          calculatorConfig: {
            ...priced.plan.calculatorConfig,
            ...(!form && priced.plan.calculatorKey === 'ec2Enhancement' ? {
              pricingStrategy: calculatorPricingStrategy(effectiveTerm),
              utilization: String(billedPct(group, effectiveTerm)),
            } : {}),
            ...(form && effectiveTerm ? {
              columnFormIPM: {
                value: form.value.map((row) => (row.TermType && row.TermType.value === 'OnDemand'
                  ? {
                    ...row,
                    TermType: { value: 'Reserved' },
                    LeaseContractLength: { value: effectiveTerm.years === 1 ? '1yr' : '3yr' },
                    PurchaseOption: { value: effectiveTerm.purchase },
                  }
                  : row)),
              },
            } : {}),
          },
        };
      }

      const rate = fargatePrice.monthly !== undefined ? undefined : await lookupPrice({
        serviceCode: plan.serviceCode,
        region,
        filters: plan.filters,
        term: effectiveTerm,
      });
      if (rate) onCall('get_aws_price', !rate.found);

      if (fargatePrice.monthly !== undefined) {
        priced.computeMonthly = fargatePrice.monthly;
        priced.computeWorkings = fargatePrice.workings;
        priced.termLabel = fargatePrice.termLabel;
      } else if (fargatePrice.miss) {
        priced.miss = fargatePrice.miss;
      } else if (rate?.found && rate.ratePerUnit !== undefined) {
        priced.termLabel = rate.termLabel;
        priced.termFellBack = rate.termFellBack;

        // What AWS charges the rate PER now decides how the rate may be used, and the
        // question is asked rather than assumed.
        //
        // This used to be a two-way branch: a "GB-Mo" unit was treated as storage and
        // EVERYTHING ELSE was assumed hourly and multiplied by a month of hours. There was
        // no third case, so a per-request, per-invocation or GB-second rate was silently
        // multiplied by ~730 and by the instance count on top, and the workings line
        // printed the inflated figure with a straight face. `reconcile` refuses instead,
        // which turns a confidently wrong number into a line that says what is missing.
        const asStorage = reconcile('GB/month', rate.unit || '');
        const asRuntime = reconcile(INSTANCE_UNIT, rate.unit || '');
        const declared = billableQuantity(group, rate.unit || '');

        if (declared) {
          // A dimension the sheet DECLARED beats every dimension inferred from the group's
          // shape, and is checked first for that reason. The inferred paths below read a
          // machine's disk total and its runtime hours, which are the right quantities for
          // a machine and are both absent on a usage-driven resource: an S3 bucket priced
          // through the storage path below would be multiplied by a `diskGb` of zero and
          // come out free, which is the failure mode a reader is least likely to catch.
          const monthly = rate.ratePerUnit * declared.match.multiplier * declared.quantity.amount;
          priced.computeMonthly = monthly;
          priced.computeWorkings = [
            `$${rate.ratePerUnit.toFixed(6)}/${rate.unit || 'unit'} (${rate.termLabel || 'on-demand'})`,
            `x ${round2(declared.quantity.amount)} ${declared.quantity.unit}`,
            declared.match.multiplier === 1 ? '' : `(${declared.match.explanation})`,
            `[${declared.quantity.basis}]`,
            `= $${monthly.toFixed(2)}/mo`,
            // The conversions travel with the figure rather than being summarised
            // elsewhere: "10 tasks a day became 300 a month" is the exact step that used to
            // go wrong silently, so it belongs on the line whose number depends on it.
            declared.quantity.conversions.length
              ? `— ${declared.quantity.conversions.join('; ')}`
              : '',
          ].filter(Boolean).join(' ');
        } else if (asStorage.ok) {
          // A storage rate means the filters resolved to a volume rather than compute, so
          // the group's own disk total is the quantity and its hours are irrelevant.
          const gigabytes = group.diskGb > 0 ? group.diskGb : 0;
          const derived = monthlyFromGbMonth({
            ratePerGbMonth: rate.ratePerUnit * asStorage.multiplier,
            gigabytes,
          });
          priced.computeMonthly = derived.monthly;
          priced.computeWorkings = derived.workings;
        } else if (asRuntime.ok) {
          const hours = billedHours(group, plan.term);
          const monthly = rate.ratePerUnit * asRuntime.multiplier * hours * group.count;
          priced.computeMonthly = monthly;
          const scale = group.count > 1 ? ` x ${group.count}` : '';
          priced.computeWorkings =
            `$${rate.ratePerUnit.toFixed(4)}/${rate.unit || 'Hrs'} (${rate.termLabel || 'on-demand'}) `
            + `x ${Math.round(hours * 10) / 10} hrs/month${scale} = $${monthly.toFixed(2)}/mo`;
        } else {
          // Deliberately unpriced. This group is machine-shaped — it is counted in
          // instances and hours — but the rate that matched is charged per something else
          // entirely, so there is no honest arithmetic joining the two. Saying so leaves a
          // gap a reader can act on; guessing would leave a total nobody can find the
          // error in.
          const stated = (group.quantities ?? []).map((entry) => entry.unit);
          priced.miss = `AWS prices this at $${rate.ratePerUnit} per "${rate.unit || 'an unnamed unit'}", `
            + (stated.length
              // Naming the declared dimensions turns this from "we could not price it" into
              // "the sheet and AWS are measuring different things, here is which two" —
              // which is the difference between a gap a reader can close and one they can
              // only report.
              ? `and this resource states ${stated.join(', ')}. None of those reconcile with `
                + 'that unit, so nothing was multiplied together and the line is left unpriced. '
                + 'Restate the quantity in the dimension AWS bills, or check the service mapping.'
              : 'which is neither runtime hours nor gigabyte-months. This line is counted in machines and '
                + 'hours, so the two were not multiplied together and it is left unpriced. Give the resource '
                + 'an explicit usage quantity and unit for it to be priced.');
        }
      } else {
        priced.miss = rate?.message || 'no published rate matched';
      }
    }

    // Storage is a separate line and a separate rate: it costs the same whether the
    // machine is running or not, so it must never inherit the compute utilisation.
    if (group.diskGb > 0
      && priced.plan.storageOwner === 'ec2-ebs'
      && !String(priced.computeWorkings || '').includes('GB-month')) {
      const disk = await lookupPrice({
        serviceCode: 'AmazonEC2',
        region,
        filters: { volumeApiName: 'gp3', productFamily: 'Storage' },
      });
      onCall('get_aws_price', !disk.found);
      if (disk.found && disk.ratePerUnit !== undefined) {
        const derived = monthlyFromGbMonth({
          ratePerGbMonth: disk.ratePerUnit,
          gigabytes: diskGbBilled(group),
        });
        priced.storageMonthly = derived.monthly;
        priced.storageWorkings = derived.workings;
        priced.storageRatePerGbMonth = disk.ratePerUnit;
      }
    }

    return priced;
  });
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A group's own label, so a client can find it in their own spreadsheet. */
function labelOf(group: ResourceGroup): string {
  const spec = group.vcpu !== undefined || group.ramGb !== undefined
    ? `${group.vcpu ?? '?'} vCPU / ${group.ramGb ?? '?'} GB`
    : '';
  return [
    `${group.count} x ${group.size || spec || 'unspecified size'}`,
    group.os,
    group.purchaseModel,
    group.names.length ? `e.g. ${group.names.join(', ')}` : '',
  ].filter(Boolean).join(' | ');
}

/**
 * What to call this group's service in the pricing-model sentence.
 *
 * The sheet's own word, not the Price List service code. A code cannot tell Aurora from
 * plain RDS MySQL, or ElastiCache for Redis from Memcached, and both distinctions are the
 * point of the sentence — "RI scope: Aurora + ElastiCache + OpenSearch" is only checkable
 * by the person who wrote the sheet if it uses their vocabulary. Groups are folded by
 * service, so the distinct values here are the sheet's own small vocabulary rather than
 * free text per row.
 *
 * Over-long text falls back to the service code's own display name: one verbose cell must
 * not be able to turn a one-line statement into a paragraph.
 */
function serviceLabelOf(group: ResourceGroup): string | undefined {
  const stated = String(group.service || '').replace(/\s+/g, ' ').trim();
  return stated && stated.length <= 40 ? stated : undefined;
}

/**
 * How a set of priced groups divides between committed and On-Demand pricing.
 *
 * Returns undefined when no group carries an eligibility decision, which is what an
 * estimate priced before this existed looks like — the caller then says nothing rather
 * than asserting an all-On-Demand mix it cannot support.
 *
 * A group that asked for a commitment and did not get one is reported as On-Demand
 * regardless of what eligibility predicted: `termFellBack` is what AWS actually answered
 * when asked for the rate, and claiming committed scope for a line priced On-Demand would
 * make this sentence the misstatement it exists to prevent.
 */
export function mixedPricing(priced: PricedGroup[]): ScenarioSummary | undefined {
  const lines: ScenarioLine[] = [];
  for (const entry of priced) {
    const decision = entry.pricingDecision;
    if (!decision) continue;
    lines.push({
      label: serviceLabelOf(entry.group),
      decision: entry.termFellBack && decision.pricing === 'committed'
        ? {
          pricing: 'on-demand',
          serviceCode: decision.serviceCode,
          reason: 'AWS publishes no reserved rate for this configuration, so it is priced On-Demand.',
          because: 'no-commitment-offered',
        }
        : decision,
    });
  }
  return lines.length ? summariseScenario(lines) : undefined;
}

/**
 * The pricing-model fields for one scenario row: which commitment, over which services.
 *
 * Derived per segment rather than once for the estimate, because each scenario is priced
 * from its own groups and a fiscal-year sheet can state a different purchase model in
 * every column.
 */
function segmentPricing(priced: PricedGroup[]): {
  pricing_model?: string;
  scope?: string;
  pricing_mix?: string;
} {
  const mix = mixedPricing(priced);

  // Read off the decisions rather than off `plan.term`: `plan.term` is what was asked for,
  // and a line that asked and fell back is priced On-Demand however the request read.
  const terms = new Set<string>();
  for (const entry of priced) {
    const decision = entry.pricingDecision;
    if (!decision || entry.termFellBack) continue;
    if (decision.pricing === 'committed') terms.add(decision.termLabel);
  }

  const model = terms.size ? [...terms].sort().join(' + ') : 'On-Demand';
  const scope = mix?.committed.join(' + ');
  return {
    // Schema caps: 120, 120 and 600 characters. Truncated here rather than left to fail
    // validation, because a long-but-true label must not be able to void a whole estimate
    // at the parse step after the arithmetic is already done.
    pricing_model: model.slice(0, 120),
    scope: scope ? scope.slice(0, 120) : undefined,
    pricing_mix: mix?.sentence ? mix.sentence.slice(0, 600) : undefined,
  };
}

/**
 * Which side of the production line an environment scenario sits on.
 *
 * Only asked of environment bands. A fiscal-year column is not an environment, and
 * guessing one from a year label would put "FY26-27" in a production/lower split that a
 * reader would then filter and subtotal on.
 */
function environmentGroupOf(label: string): 'production' | 'lower' | 'other' {
  const text = label.toLowerCase();
  // The lower-environment test runs first on purpose: "non-prod", "pre-prod" and "preprod"
  // all contain "prod", so a production-first test would file every one of them as
  // production. That is the most consequential way to get this wrong, because it moves a
  // test estate into the figure a client budgets against.
  if (/non-?prod|pre-?prod|dev|test|stag|uat|\bqa\b|sandbox|\bsit\b|lower/.test(text)) return 'lower';
  if (/prod|\bprd\b|\blive\b/.test(text)) return 'production';
  return 'other';
}

/** Turns priced groups into the report's line items, compute and storage separately. */
function toLineItems(priced: PricedGroup[]): CalculationResult['lineItems'] {
  const items: CalculationResult['lineItems'] = [];

  for (const entry of priced) {
    const { group } = entry;
    items.push({
      service: group.service || 'Amazon EC2',
      detail: labelOf(group),
      monthly: entry.computeMonthly === null ? null : round2(entry.computeMonthly),
      workings: entry.computeWorkings
        ?? (entry.miss ? `Not priced: ${entry.miss}` : undefined),
      environment: group.environment,
      hoursPerDay: group.hoursPerDay,
      timeBilled: true,
    });

    if (entry.storageMonthly !== null) {
      items.push({
        service: 'Amazon EBS',
        detail: `${Math.round(group.diskGb)} GB attached to ${labelOf(group)}`,
        monthly: round2(entry.storageMonthly),
        workings: entry.storageWorkings,
        environment: group.environment,
        // Storage is billed whether or not the machine runs, so it is excluded from
        // the scheduling-savings figure the report derives from timeBilled lines.
        timeBilled: false,
      });
    }
  }

  if (items.length <= MAX_LINE_ITEMS) return items;

  // Summarised rather than dropped: an omitted line is money the client is paying that
  // the document does not mention.
  const kept = items.slice(0, MAX_LINE_ITEMS);
  const tail = items.slice(MAX_LINE_ITEMS);
  const total = tail.reduce((sum, item) => sum + (item.monthly ?? 0), 0);
  kept.push({
    service: 'Remaining resources',
    detail: `${tail.length} further line(s), summarised to keep the report readable`,
    monthly: round2(total),
    workings: 'Sum of the remaining priced lines',
  });
  return kept;
}

/**
 * Which CPU family an instance type runs on, read from the type's own name.
 *
 * The reference TCO workbook carries a Processor column and nothing in the uploaded sheet
 * supplies one, but the instance family already encodes it: a trailing `g` is Graviton,
 * an `a` is AMD EPYC, and everything else AWS sells on these families is Intel Xeon.
 * Undefined where the name does not parse, so an unrecognised family prints blank instead
 * of a guess.
 */
export function processorOf(size?: string): string | undefined {
  const family = String(size ?? '').trim().toLowerCase().split('.')[0];
  const match = /^([a-z]+)(\d+)([a-z]*)$/.exec(family);
  if (!match) return undefined;
  const [, letters, , suffix] = match;
  // a1 is the one Graviton family with no suffix letter to give it away.
  if (suffix.includes('g') || letters === 'a') return 'AWS Graviton';
  if (suffix.includes('a')) return 'AMD EPYC';
  return 'Intel Xeon';
}

/** Shortened with a visible marker, so a reader can tell a trim from a short cell. */
const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}...` : text;

/**
 * Why this machine is the size it is, assembled from what the sheet actually said.
 *
 * Not generated prose: the source spec, the right-sizing recommendation and the client's
 * own note are the three things that justify a size, and all three came from their file.
 */
function justificationOf(resource: CalculationResource): string | undefined {
  const parts = [
    resource.source_size ? `Source: ${resource.source_size}` : '',
    resource.right_sized_size && resource.right_sized_size !== resource.size
      ? `Right-sizing recommends ${resource.right_sized_size}`
      : '',
    resource.dr_eligible ? 'Marked DR-eligible' : '',
    (resource.notes || '').trim(),
  ].filter(Boolean);
  const text = parts.join('. ');
  return text ? clipTo(text, 500) : undefined;
}

/**
 * Allocates each priced group across the machines it stands for.
 *
 * This is arithmetic on figures AWS already returned, not a second pricing pass -- and it
 * has to be, because prices in this app come only from the Price List API. A group is by
 * definition machines of identical size, OS, region, schedule and purchase model, so its
 * compute divides by machine count exactly. Storage is apportioned on each row's share of
 * the group's disk instead, so a server carrying a 2TB volume is not charged the group
 * mean -- and because it is a share of the figure that was priced, the rows still sum to
 * the group total and the workbook's grand total still equals monthlyTotal.
 */
export function toServers(
  priced: PricedGroup[],
  resources: CalculationResource[],
): NonNullable<CalculationResult['servers']> {
  const rows: NonNullable<CalculationResult['servers']> = [];

  for (const entry of priced) {
    const { group } = entry;
    const groupCount = Math.max(1, group.count);

    for (const index of group.members) {
      const resource = typeof index === 'number'
        ? resources[index]
        : resources.find((candidate) => candidate.plan_resource_id === index || candidate.resourceId === index);
      if (!resource) continue;

      const count = countOf(resource);
      const diskGb = (resource.disk_gb ?? 0) * count;
      const computeMonthly = entry.computeMonthly === null
        ? null
        : round2(entry.computeMonthly * (count / groupCount));
      const storageMonthly = entry.storageMonthly === null || group.diskGb <= 0 || diskGb <= 0
        ? null
        : round2(entry.storageMonthly * (diskGb / group.diskGb));

      rows.push({
        name: resource.name || `${group.service} row ${resource.row ?? (typeof index === 'number' ? index + 1 : index)}`,
        count,
        environment: group.environment,
        group: labelOf(group),
        os: group.os,
        processor: processorOf(group.size),
        instance: group.size,
        vcpu: group.vcpu,
        ramGb: group.ramGb,
        // The sheet's own wording first: it is what the client recognises. Where a row
        // stated no model, the term AWS actually quoted is the honest answer.
        purchaseModel: group.purchaseModel || entry.termLabel || 'On-Demand',
        diskGb: diskGb > 0 ? round2(diskGb) : undefined,
        diskType: storageMonthly === null ? undefined : 'gp3',
        hoursPerDay: group.hoursPerDay,
        computeMonthly,
        storageMonthly,
        justification: justificationOf(resource),
        sheet: resource.sheet,
        row: resource.row,
      });
    }
  }

  return rows;
}

/** Per-environment rollup, so the report's subtotals match the calculator's folders. */
function toEnvironments(
  priced: PricedGroup[],
  record: CalculationRecord,
): CalculationResult['environments'] {
  const hoursFor = new Map(
    (record.environment_hours || []).map((entry) => [entry.name, entry.hoursPerDay]),
  );
  const totals = new Map<string, { monthly: number; hoursPerDay: number }>();

  for (const entry of priced) {
    const name = entry.group.environment || 'Unassigned';
    const existing = totals.get(name) || {
      monthly: 0,
      hoursPerDay: hoursFor.get(name) ?? entry.group.hoursPerDay,
    };
    existing.monthly += (entry.computeMonthly ?? 0) + (entry.storageMonthly ?? 0);
    totals.set(name, existing);
  }

  return [...totals.entries()]
    .sort((left, right) => right[1].monthly - left[1].monthly)
    .map(([name, value]) => ({
      name,
      hoursPerDay: Math.max(1, Math.min(24, Math.round(value.hoursPerDay))),
      monthly: round2(value.monthly),
    }));
}

// ---------------------------------------------------------------------------
// Saving the shareable estimate
// ---------------------------------------------------------------------------

/**
 * A group name calculator.aws will actually keep.
 *
 * Verified live against the sidecar, twice: a group named `Prod/UAT/Dev` is accepted by
 * `build_estimate` — every service in it reports `success: true` — and is then completely
 * absent from the saved estimate. On the worked COSEC workbook that silently dropped
 * $4,313.37/month, 16% of the bill, out of the shareable link while the report still
 * carried it. That is exactly the "the calculator says one thing and the PDF says
 * another" failure, and it produced no error anywhere.
 *
 * A separate probe of eight candidate names established that `(` `)` `_` `.` `,` `:` `+`
 * `#` and spaces all survive intact, `&` is silently stripped, and `/` is the character
 * that kills the group. So the slash is mapped to a hyphen, `&` is spelled out so the
 * link reads the way the report does, and anything outside the verified-safe set is
 * replaced rather than trusted.
 */
export function calculatorGroupName(environment?: string): string {
  const cleaned = (environment || '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9 ()._,:+#-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-,:.+#]+|[-,:.+#]+$/g, '')
    .trim();
  // 'Estimate' rather than an empty name: an unnamed group is one the calculator groups
  // under a blank heading, which reads as a bug to the client.
  return cleaned.slice(0, 60) || 'Estimate';
}

/**
 * One service entry for `build_estimate`, plus what it is worth.
 *
 * The money rides along only so the post-save check can price a service the calculator
 * dropped. It is stripped before the payload goes out.
 */
interface SaveEntry {
  service?: string;
  serviceCode: string;
  group: string;
  config?: Record<string, unknown>;
  monthly: number;
  label: string;
  resourceIds: string[];
  requestedPricing: string;
  resolvedPricing: string;
  semanticIntent?: Record<string, unknown>;
  pricingStatus: 'EXACT' | 'MIXED' | 'UNSUPPORTED';
  pricingReason?: string;
  fingerprintFields?: string[];
  preflight: ResourcePreflight;
}

interface ValidatedSaveResult {
  url: string | null;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  warning?: string;
  requirementChecks: RequirementCheck[];
  validationErrors: string[];
  snapshot?: SavedEstimateSnapshot;
  manifest: ExecutionManifest;
}

function measurementNumber(value: unknown): number | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['originalValue', 'value', 'derivedValue']) {
      const parsed = Number(record[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function semanticIntentFor(group: ResourceGroup, config?: Record<string, unknown>): Record<string, unknown> | undefined {
  const fargate = group.configuration?.fargateTask;
  if (fargate && typeof fargate === 'object' && !Array.isArray(fargate)) {
    const semantic = fargate as Record<string, unknown>;
    const duration = semantic.taskDuration && typeof semantic.taskDuration === 'object' && !Array.isArray(semantic.taskDuration)
      ? semantic.taskDuration as Record<string, unknown>
      : undefined;
    const derived = duration?.derived && typeof duration.derived === 'object' && !Array.isArray(duration.derived)
      ? duration.derived as Record<string, unknown>
      : undefined;
    return {
      taskCount: measurementNumber(semantic.taskCount),
      taskFrequency: semantic.taskFrequency,
      vcpuPerTask: measurementNumber(semantic.vcpuPerTask),
      memoryGbPerTask: measurementNumber(semantic.memoryGbPerTask),
      duration: measurementNumber(derived) ?? measurementNumber(duration),
      durationUnit: String(derived?.unit || duration?.derivedUnit || 'hours'),
      calculatorNumberOfTasks: config?.numberOfTasks,
      calculatorTaskDuration: config?.taskDuration,
    };
  }
  return undefined;
}

function preflightFor(entry: {
  label: string;
  group: ResourceGroup;
  serviceCode: string;
  calculatorService?: string;
  config?: Record<string, unknown>;
  fingerprintFields?: string[];
  pricingStatus: 'EXACT' | 'MIXED' | 'UNSUPPORTED';
  pricingReason?: string;
}): ResourcePreflight {
  const checks: ResourcePreflight['checks'] = [];
  const blockers: string[] = [];
  const add = (check: ResourcePreflight['checks'][number]) => {
    checks.push(check);
    if (check.status === 'FAIL' || check.status === 'UNRESOLVED') {
      blockers.push(`${check.field}: ${check.message || 'unresolved'}`);
    }
  };
  add({
    field: 'service',
    status: entry.serviceCode ? 'PASS' : 'UNRESOLVED',
    actual: entry.serviceCode || undefined,
    source: 'workbook',
    message: entry.serviceCode ? undefined : 'No AWS service family was mapped.',
  });
  add({
    field: 'region',
    status: (entry.group.region || entry.config?.region) ? 'PASS' : 'UNRESOLVED',
    actual: entry.group.region || entry.config?.region,
    source: entry.group.region ? 'workbook' : 'system_default',
    message: (entry.group.region || entry.config?.region) ? undefined : 'No AWS region is available for this resource.',
  });
  add({
    field: 'calculator.adapter',
    status: entry.calculatorService && entry.config ? 'PASS' : 'UNRESOLVED',
    actual: entry.calculatorService || undefined,
    source: 'mcp',
    message: entry.calculatorService && entry.config
      ? undefined
      : (entry.pricingReason || 'No verified Calculator configuration was produced.'),
  });
  for (const field of entry.fingerprintFields || []) {
    if (entry.config?.[field] === undefined) continue;
    checks.push({
      field: `calculator.${field}`,
      status: 'PASS',
      actual: entry.config?.[field],
      source: 'workbook',
    });
  }
  for (const quantity of entry.group.quantities || []) {
    checks.push({
      field: `quantity.${quantity.basis}`,
      status: 'PASS',
      actual: quantity.amount,
      source: 'workbook',
      measurement: {
        originalValue: quantity.originalValue ?? quantity.amount,
        originalUnit: quantity.originalUnit ?? quantity.unit,
        originalScale: quantity.originalScale,
        originalPeriod: quantity.originalPeriod ?? 'month',
        derivedValue: quantity.derivedValue ?? quantity.amount,
        derivedUnit: quantity.derivedUnit ?? quantity.unit,
        derivedScale: quantity.derivedScale,
        derivedPeriod: quantity.derivedPeriod ?? 'month',
        conversionFormula: quantity.conversionFormula,
      },
    });
  }
  if (entry.pricingStatus === 'UNSUPPORTED') {
    blockers.push(`pricing: ${entry.pricingReason || 'requested pricing model is unsupported for this resource'}`);
  }
  return {
    resourceId: entry.group.members.map(String).join(',') || entry.label,
    label: entry.label,
    service: entry.serviceCode,
    environment: entry.group.environment,
    region: entry.group.region || String(entry.config?.region || ''),
    readiness: blockers.length ? 'NEEDS_INPUT' : 'COMPILED',
    checks,
    blockers: [...new Set(blockers)],
    sourceEvidence: entry.group.sourceEvidence || [],
  };
}

/**
 * Gives every service a description no other service in its group shares.
 *
 * The second half of the same silent-loss bug. Verified live: two services in one group
 * with the same `service` and the same `description` collapse to one in the saved
 * estimate — `build_estimate` reports `success: true` for both and warns that it
 * "appended a duplicate row", and then the earlier one is simply not there when the
 * estimate is read back. Sending the worked example's real 25 services reproduced it
 * exactly: 21 survived. Making the descriptions unique and re-sending the same nine UAT
 * services returned all nine.
 *
 * Two rows genuinely can be the same shape — "2 x m6a.large Windows" twice in UAT, one
 * with 1,406 GB attached and one with 512 GB — so the fix is to tell them apart, not to
 * merge them. A machine name is the discriminator a client can look up in their own
 * sheet; a counter is the fallback that cannot fail.
 */
function distinctDescription(
  taken: Map<string, Set<string>>,
  group: string,
  base: string,
  names: string[],
): string {
  let used = taken.get(group);
  if (!used) {
    used = new Set<string>();
    taken.set(group, used);
  }
  const candidates = [base, ...names.slice(0, 3).map((name) => `${base} - ${name}`)];
  for (const candidate of candidates) {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} #${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Reads the saved estimate back and reports anything the calculator did not keep.
 *
 * The guarantee this pipeline has to make is that the shareable link and the priced
 * report describe the same resources. Both bugs above were invisible from our side:
 * every service reported success and the URL came back fine. So the link is now verified
 * against what we sent, by group and description, and any shortfall is stated in dollars
 * in the report itself.
 *
 * Never throws. A verification that cannot run leaves a note saying so; it must not cost
 * the client a fully priced estimate.
 */
async function readSaved(
  mcp: CalculatorGateway,
  url: string,
  onCall: (name: string, isError: boolean) => void,
): Promise<{ snapshot?: SavedEstimateSnapshot; error?: string }> {
  try {
    const result = await mcp.readEstimate(url);
    onCall('import_estimate', result.isError);
    if (result.isError) {
      return { error: `The saved estimate could not be read back: ${result.text.slice(0, 300)}` };
    }
    try {
      return { snapshot: parseSavedEstimateSnapshot(result.text) };
    } catch (error) {
      return { error: `The saved estimate read-back could not be parsed: ${(error as Error).message}` };
    }
  } catch (error) {
    onCall('import_estimate', true);
    return { error: `The saved estimate could not be read back: ${(error as Error).message.slice(0, 300)}` };
  }
}

/**
 * Saves one calculator.aws estimate and returns its URL, or null with a reason.
 *
 * `build_estimate` is one sidecar call that creates, adds every service, lint-checks and
 * saves. Using it instead of create_estimate + N x add_service + export_estimate removes
 * an entire class of failure by construction: there is no window in which a second
 * estimate can be created, no partially-populated estimate to orphan, and no ordering
 * for a retry to get wrong. A live run created a second estimate at turn 20 and exported
 * a link covering a fraction of the workload; that cannot happen here.
 *
 * Never throws. The link is the nicer half of the output and the costs are the half the
 * client needs, so a save failure must not discard a fully priced estimate.
 *
 * The estimate is read back before this returns. Two live-verified bugs — a group name
 * containing a slash, and two services sharing a description inside one group — cause the
 * calculator to keep the URL and quietly discard the resources, which is how the link and
 * the report came to disagree by $4,601.75/month on the worked example. Both are prevented
 * above; the read-back is what stops any third variant of the same failure from ever
 * reaching a client unremarked.
 */
async function saveEstimate(
  mcp: CalculatorGateway,
  name: string,
  scenarioId: string,
  priced: PricedGroup[],
  context: {
    planRevision?: EstimatePlanRevision;
    inputHash: string;
    requestedPricing: string;
  },
  onCall: (name: string, isError: boolean) => void,
): Promise<ValidatedSaveResult> {
  const taken = new Map<string, Set<string>>();
  const services: SaveEntry[] = priced.map((entry) => {
      const group = calculatorGroupName(entry.group.environment);
      const base = String(entry.plan.calculatorConfig?.description ?? labelOf(entry.group));
      const description = distinctDescription(taken, group, base, entry.group.names);
      const decision = entry.pricingDecision;
      const exact = context.requestedPricing === 'sheet-specified'
        ? (decision?.pricing === 'committed' && !decision.substitution)
          || (decision?.pricing === 'on-demand' && decision.because === 'requested')
        : context.requestedPricing === 'on-demand'
          ? decision?.pricing === 'on-demand' && decision.because === 'requested'
          : decision?.pricing === 'committed' && !decision.substitution;
      const resolvedPricing = exact
        ? context.requestedPricing === 'sheet-specified'
          ? decision?.pricing === 'committed'
            ? `ri-${decision.term.years}yr-${decision.term.purchase === 'All Upfront'
              ? 'all-upfront' : decision.term.purchase === 'Partial Upfront' ? 'partial-upfront' : 'no-upfront'}`
            : 'on-demand'
          : context.requestedPricing
        : decision?.pricing === 'committed'
          ? decision.termLabel
          : decision?.pricing === 'on-demand'
            ? 'on-demand'
            : decision?.pricedAt || 'unresolved';
      const intentionalOnDemandRemainder = decision?.pricing === 'on-demand'
        && ['no-commitment-offered', 'not-instance-capacity', 'no-savings-plan-coverage']
          .includes(decision.because);
      const pricingStatus: SaveEntry['pricingStatus'] = exact
        ? 'EXACT'
        : intentionalOnDemandRemainder || (decision?.pricing === 'committed' && !decision.substitution)
          ? 'MIXED'
          : 'UNSUPPORTED';
      const saveEntry = {
        service: entry.plan.calculatorKey,
        serviceCode: entry.plan.serviceCode,
        group,
        ...(entry.plan.calculatorConfig ? {
          config: { ...entry.plan.calculatorConfig, description },
        } : {}),
        monthly: (entry.computeMonthly ?? 0) + (entry.storageMonthly ?? 0),
        label: labelOf(entry.group),
        resourceIds: entry.group.members.map(String),
        requestedPricing: context.requestedPricing,
        resolvedPricing,
        semanticIntent: semanticIntentFor(entry.group, entry.plan.calculatorConfig),
        pricingStatus: entry.plan.calculatorUnsupported ? 'UNSUPPORTED' : pricingStatus,
        pricingReason: entry.plan.calculatorUnsupported
          || (decision?.pricing === 'committed' ? decision.substitution : decision?.pricing === 'on-demand' ? decision.reason : decision?.caveat),
        fingerprintFields: entry.plan.fingerprintFields,
      };
      return {
        ...saveEntry,
        preflight: preflightFor({
          label: saveEntry.label,
          group: entry.group,
          serviceCode: saveEntry.serviceCode,
          calculatorService: saveEntry.service,
          config: saveEntry.config,
          fingerprintFields: saveEntry.fingerprintFields,
          pricingStatus: saveEntry.pricingStatus,
          pricingReason: saveEntry.pricingReason,
        }),
      };
    });

  const saveable = services.filter((entry) => entry.service && entry.config);
  const includedResourceIds = new Set(saveable.flatMap((entry) => entry.resourceIds));
  const constraints = (context.planRevision?.requirements || []).filter((requirement) => {
    const resourceScopes = requirement.scope.filter((scope) => scope.startsWith('resource:'));
    if (resourceScopes.length
      && !resourceScopes.some((scope) => includedResourceIds.has(scope.slice('resource:'.length)))) return false;
    const serviceScopes = requirement.scope
      .filter((scope) => scope.startsWith('service:'))
      .map((scope) => scope.slice('service:'.length).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!serviceScopes.length) return true;
    return saveable.some((entry) => {
      const identity = `${entry.serviceCode} ${entry.label}`.toLowerCase().replace(/[^a-z0-9]/g, '');
      return serviceScopes.some((scope) => identity.includes(scope) || scope.includes(identity));
    });
  });
  const buildManifest = () => createExecutionManifest({
    scenarioId,
    planRevisionId: context.planRevision?.revisionId || 'legacy',
    inputHash: context.inputHash,
    constraints,
    preflight: services.map((entry) => entry.preflight),
    services: services.map((entry) => ({
      resourceIds: entry.resourceIds,
      serviceCode: entry.serviceCode,
      calculatorService: entry.service,
      group: entry.group,
      description: String(entry.config?.description ?? entry.label),
      config: entry.config,
      semanticIntent: entry.semanticIntent,
      fingerprintFields: entry.fingerprintFields,
      requestedPricing: entry.requestedPricing,
      resolvedPricing: entry.resolvedPricing,
      pricingStatus: entry.pricingStatus,
      pricingReason: entry.pricingReason,
    })),
  });
  let manifest = buildManifest();
  const preflightBlockers = services.flatMap((entry) => entry.preflight.blockers.map((blocker) => `${entry.label}: ${blocker}`));
  if (preflightBlockers.length) {
    const validationErrors = [
      'Calculator preflight failed; no AWS Pricing Calculator estimate was created.',
      ...preflightBlockers,
    ];
    return {
      url: null,
      status: 'FAILED',
      warning: validationErrors.join(' '),
      requirementChecks: [],
      validationErrors,
      manifest,
    };
  }
  if (!saveable.length) {
    const validationErrors = [
      'No resource has a supported AWS Pricing Calculator adapter; no partial link was created.',
      ...services.map((entry) => entry.pricingReason).filter((reason): reason is string => Boolean(reason)),
    ];
    return {
      url: null,
      status: 'FAILED',
      warning: validationErrors[0],
      requirementChecks: [],
      validationErrors,
      manifest,
    };
  }
  if (saveable.length !== services.length) {
    const missing = services.filter((entry) => !entry.service || !entry.config);
    const validationErrors = [
      `Calculator compilation stopped before save: ${missing.length} resource group(s) still need a supported, fully specified service contract.`,
      ...missing.map((entry) => `${entry.label}: ${entry.pricingReason || 'no Calculator adapter/configuration was produced'}`),
    ];
    return {
      url: null,
      status: 'FAILED',
      warning: validationErrors.join(' '),
      requirementChecks: [],
      validationErrors,
      manifest,
    };
  }

  const catalogs = new Map<string, ReturnType<typeof parseServiceCatalog>>();
  const validateCatalogs = async (refresh = false): Promise<string[]> => {
    const errors: string[] = [];
    if (refresh) catalogs.clear();

    for (const entry of saveable) {
      if (!entry.service || !entry.config) continue;
      let catalog = catalogs.get(entry.service);
      if (!catalog) {
        const response = await mcp.getServiceCatalog(entry.service);
        onCall('get_service_fields', response.isError);
        try {
          catalog = parseServiceCatalog(response);
          catalogs.set(entry.service, catalog);
        } catch (error) {
          errors.push(`${entry.service}: ${(error as Error).message}`);
          continue;
        }
      }
      entry.config = resolveConfigAgainstCatalog(catalog, entry.config);
      errors.push(...validateConfigAgainstCatalog(catalog, entry.config));
    }
    return [...new Set(errors)];
  };

  try {
    const catalogErrors = await validateCatalogs();
    if (catalogErrors.length) return {
      url: null,
      status: 'FAILED',
      warning: catalogErrors.join(' '),
      requirementChecks: [],
      validationErrors: catalogErrors,
      manifest,
    };
    manifest = buildManifest();
    const payloadForSave = () => saveable.map((entry) => ({
      service: entry.service!,
      group: entry.group,
      config: entry.config!,
    }));
    let payload = payloadForSave();
    let result = await mcp.saveEstimate(
      name,
      payload,
    );
    onCall('build_estimate', result.isError);

    if (result.isError) {
      // Catalog contracts can change independently of this deployment. Refresh once and
      // retry only when the current payload still validates against the refreshed schema.
      const refreshedErrors = await validateCatalogs(true);
      if (!refreshedErrors.length) {
        payload = payloadForSave();
        result = await mcp.saveEstimate(name, payload);
        onCall('build_estimate_retry', result.isError);
      }
    }
    if (result.isError) {
      const validationErrors = [`AWS Pricing Calculator rejected the compiled estimate: ${result.text.slice(0, 300)}`];
      return {
        url: null,
        status: 'FAILED',
        warning: validationErrors[0],
        requirementChecks: [],
        validationErrors,
        manifest,
      };
    }

    // The tool returns { sharable_url, aws_estimate_id, services }; the URL is also
    // findable in the raw text, which is the more robust of the two given the reply is
    // occasionally wrapped in prose.
    const url = /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(result.text)?.[0]
      ?? (() => {
        try {
          return JSON.parse(result.text)?.sharable_url ?? null;
        } catch {
          return null;
        }
      })();

    if (!url) {
      const validationErrors = ['The estimate saved but AWS Pricing Calculator returned no shareable URL.'];
      return { url: null, status: 'FAILED', warning: validationErrors[0], requirementChecks: [], validationErrors, manifest };
    }
    const readBack = await readSaved(mcp, String(url), onCall);
    if (!readBack.snapshot) {
      const validationErrors = [readBack.error || 'The saved estimate could not be validated.'];
      return {
        url: String(url), status: 'PARTIAL', warning: validationErrors[0], requirementChecks: [], validationErrors, manifest,
      };
    }
    let linkCheck: Awaited<ReturnType<CalculatorGateway['validateLink']>>;
    try {
      linkCheck = await mcp.validateLink(String(url));
    } catch (error) {
      linkCheck = {
        validUrl: false,
        reason: `AWS Pricing Calculator link browser validation could not be completed: ${(error as Error).message.slice(0, 300)}`,
      };
    }
    const renderedSnapshot = {
      ...readBack.snapshot,
      ...(linkCheck.validUrl && linkCheck.monthly !== undefined ? { monthly: linkCheck.monthly } : {}),
      ...(linkCheck.validUrl && linkCheck.upfront !== undefined ? { upfront: linkCheck.upfront } : {}),
      ...(linkCheck.validUrl && linkCheck.total12Months !== undefined ? { total12Months: linkCheck.total12Months } : {}),
    };
    const validation = validateSavedEstimate(manifest, renderedSnapshot);
    const validationErrors = [...new Set([
      ...validation.errors,
      ...(!linkCheck.validUrl
        ? [linkCheck.reason || 'AWS Pricing Calculator link browser validation could not be completed.']
        : []),
    ])];
    return {
      url: String(url),
      status: validationErrors.length ? 'PARTIAL' : 'COMPLETED',
      ...(validationErrors.length ? { warning: validationErrors.join(' ') } : {}),
      requirementChecks: validation.checks,
      validationErrors,
      snapshot: renderedSnapshot,
      manifest,
    };
  } catch (error) {
    onCall('build_estimate', true);
    const validationErrors = [`The shareable calculator.aws link could not be created: ${(error as Error).message.slice(0, 300)}`];
    return {
      url: null,
      status: 'FAILED',
      warning: validationErrors[0],
      requirementChecks: [],
      validationErrors,
      manifest,
    };
  }
}

// ---------------------------------------------------------------------------
// The narrative
// ---------------------------------------------------------------------------

const NARRATE_SYSTEM = `You write the assumptions and warnings for an AWS cost estimate that has ALREADY been priced from live AWS published rates. The arithmetic is done and is not yours to change.

Return ONLY a JSON object:
{"assumptions": ["..."], "warnings": ["..."]}

- assumptions: what a reader must know to interpret the figures — the region priced, the schedule applied, the commitment terms used, any sizing chosen where the sheet gave only vCPU/RAM, and any of the client's own stated assumptions you were given that shape the estimate.
- warnings: anything that makes the total understate or overstate reality. Name unpriced resources explicitly, one per warning. Call out a material variance against the client's own modelled figure and say which direction it goes.
- Be specific and short. "12 machines in Dev were not priced because no published rate matched db.custom.m5" beats "some resources were not priced".
- Never state a price, a rate or a total. Never contradict the figures you were given.
- No commentary outside the JSON object.`;

/** Pulls the first balanced JSON object out of a model reply. */
function parseJsonObject(text: string): any {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  .map((entry) => entry.trim().slice(0, 500));

/**
 * The assumptions and warnings code can state without a model.
 *
 * These are always present, whether or not the narrative call succeeds. That ordering
 * matters: the facts a client must know to read the figures — which region, which
 * schedule, which commitment, what was not priced — are derived from the estimate itself
 * and must not depend on a Bedrock call that might fail.
 */
function deterministicNotes(
  priced: PricedGroup[],
  record: CalculationRecord,
  defaultRegion: string,
): { assumptions: string[]; warnings: string[] } {
  const assumptions: string[] = [];
  const warnings: string[] = [];

  assumptions.push(
    `Every figure is calculated from live AWS published rates read from the AWS Price List Query API on ${new Date().toISOString().slice(0, 10)}, not from any rate stated in the uploaded file.`,
  );

  const regions = [...new Set(priced.map((entry) => entry.group.region || defaultRegion))];
  assumptions.push(regions.length === 1
    ? `All resources are priced in ${regions[0]}.`
    : `Resources are priced in their own regions: ${regions.join(', ')}.`);

  const committed = priced.filter((entry) => entry.plan.term);
  if (committed.length) {
    const terms = [...new Set(committed.map((entry) => entry.termLabel).filter(Boolean))];
    assumptions.push(
      `${committed.length} group(s) carry a commitment in the uploaded file and are priced on that term${terms.length ? ` (${terms.join('; ')})` : ''}.`,
    );
    // Why the shareable link names a different product for the same money: calculator.aws
    // hides Standard and Convertible Reserved Instances unless tenancy is dedicated, so a
    // shared-tenancy commitment can only be expressed there as an EC2 Instance Savings
    // Plan. AWS sets the Instance Savings Plan discount to match the Standard RI discount
    // for the same term and upfront option, so the rate is the same one either way — but a
    // client reading both documents will see the two names and should be told they agree.
    assumptions.push(
      'Committed rates are read from the AWS Price List as Standard Reserved Instances and appear in the shareable calculator link as the matching EC2 Instance Savings Plan, which AWS prices identically for the same term and upfront option. Reserved Instances are not selectable on shared tenancy in calculator.aws.',
    );
  }

  // The one discrepancy a client is guaranteed to notice: a link that totals less than the
  // report because some priced lines have no calculator service definition to be saved as.
  // Naming the money involved is the difference between an explained gap and a wrong figure.
  const offLink = priced.filter((entry) => (
    !entry.miss && !entry.plan.calculatorKey && (entry.computeMonthly ?? 0) > 0
  ));
  if (offLink.length) {
    const money = offLink.reduce(
      (total, entry) => total + (entry.computeMonthly ?? 0) + (entry.storageMonthly ?? 0),
      0,
    );
    warnings.push(
      `The shareable calculator.aws link covers the EC2 resources only. ${offLink.length} priced group(s) worth $${round2(money).toFixed(2)}/month — ${[...new Set(offLink.map((entry) => entry.plan.serviceCode).filter(Boolean))].join(', ') || 'other services'} — have no calculator service definition, so the link's total is lower than the total in this report by that amount. The figures in this report are the complete ones.`,
    );
  }

  // How the committed and On-Demand halves of this estimate divide, named service by
  // service. Replaces a warning that counted the fallbacks and named none of them.
  const mix = mixedPricing(priced);
  if (mix && (mix.committed.length || mix.caveats.length)) {
    warnings.push(mix.sentence);
    // Caveats are pushed separately rather than folded into the sentence: each one is a
    // condition on a specific service (a Savings Plan that cannot be priced from published
    // rates, reserved capacity that buys nothing for a table in on-demand mode), and
    // collapsing them into one line makes it impossible to tell which service each applies
    // to — which is the only thing that makes a caveat actionable.
    for (const caveat of mix.caveats) warnings.push(caveat);
  }

  // A row that states both a commitment and a part-time schedule contradicts itself. The
  // commitment wins, because that is what the invoice will say — but the client has to be
  // told, since their own sheet implies a smaller number.
  const committedPartTime = priced.filter((entry) => (
    entry.plan.term && billedPct(entry.group) < 100
  ));
  if (committedPartTime.length) {
    warnings.push(
      `${committedPartTime.length} group(s) state both a commitment and a part-time schedule in the uploaded file. A Reserved Instance or Savings Plan is billed for the whole month whether or not the instance is running, so these are priced for the full ${HOURS_PER_MONTH} hours: ${committedPartTime.slice(0, 5).map((entry) => labelOf(entry.group)).join('; ')}${committedPartTime.length > 5 ? ` and ${committedPartTime.length - 5} more` : ''}.`,
    );
  }

  const sqlLicensed = priced.filter((entry) => entry.plan.filters?.preInstalledSw);
  if (sqlLicensed.length) {
    assumptions.push(
      `${sqlLicensed.length} group(s) are priced with a bundled SQL Server licence read from the uploaded file (${[...new Set(sqlLicensed.map((entry) => entry.plan.filters.preInstalledSw))].join(', ')}), which is charged per vCPU and is a large part of their rate. Bring-your-own-licence would be cheaper and is not assumed.`,
    );
  }

  // The opposite case, and it has to be stated just as plainly: the rate is the plain OS
  // one, so a reader comparing it against a licence-inclusive quote will find it low.
  const sqlUnbilled = priced
    .map((entry) => ({ entry, licence: sqlLicensing(licenceText(entry.group)) }))
    .filter((item) => item.licence.unbilled);
  if (sqlUnbilled.length) {
    const reasons = [...new Set(sqlUnbilled.map((item) => item.licence.unbilled))];
    assumptions.push(
      `${sqlUnbilled.length} group(s) name SQL Server, but the uploaded file states ${reasons.join(' / ')}, so no SQL Server licence cost is included in their rate — they are priced on the plain operating-system rate, as the file intends. Had AWS supplied the licence instead, those groups would cost materially more, because it is billed per vCPU.`,
    );
  }

  const partTime = priced.filter((entry) => billedHours(entry.group, entry.plan.term) < HOURS_PER_MONTH);
  if (partTime.length) {
    assumptions.push(
      `${partTime.length} group(s) are billed for less than a full month because the file or the form states a part-time schedule; storage on those machines is still billed for the full month.`,
    );
  }

  for (const entry of priced.filter((item) => item.miss)) {
    warnings.push(`Not priced — ${labelOf(entry.group)}: ${entry.miss}`);
  }

  if (record.resources_truncated) {
    assumptions.push('The uploaded file was large enough that its parsed rows were stored separately; the full list was priced.');
  }

  for (const warning of record.input_warnings || []) warnings.push(warning);

  return { assumptions, warnings };
}

function normalizedSelector(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function serviceSelectorMatches(service: string, wanted: string): boolean {
  if (!wanted) return false;
  if (service.includes(wanted) || wanted.includes(service)) return true;
  const significant = wanted.split(' ')
    .filter((word) => !['amazon', 'aws', 'ecs', 'service'].includes(word));
  return significant.length > 0 && significant.every((word) => service.includes(word));
}

function constraintApplies(
  resource: CalculationResource,
  resourceId: string,
  scopes: string[],
): boolean {
  if (!scopes.length || scopes.some((scope) => [
    'all-resources',
    'all-time-billed-resources',
    'all-eligible-resources',
  ].includes(scope))) return true;
  const haystack = normalizedSelector([
    resource.service,
    resource.name,
    resource.metric,
    resource.section,
  ].filter(Boolean).join(' '));
  return scopes.some((scope) => {
    if (scope === `resource:${resourceId}`) return true;
    if (scope.startsWith('service:')) {
      const wanted = normalizedSelector(scope.slice('service:'.length));
      return serviceSelectorMatches(haystack, wanted);
    }
    if (scope.startsWith('environment:')) {
      return normalizedSelector(resource.environment || '') === normalizedSelector(scope.slice('environment:'.length));
    }
    return false;
  });
}

/**
 * Applies the confirmed structured constraints to a disposable working inventory.
 * The original parsed rows and WorkbookIR stay immutable in S3; every applied value is
 * therefore both effective for compilation and auditable against its source revision.
 */
export function materializePlanResources(
  resources: CalculationResource[],
  revision?: EstimatePlanRevision,
): CalculationResource[] {
  return resources.map((source, index) => {
    const resourceId = source.plan_resource_id || String(index);
    let resource: CalculationResource = { ...source, plan_resource_id: resourceId };
    for (const constraint of revision?.requirements || []) {
      if (constraint.scope.some((scope) => scope.startsWith('scenario:'))
        || !constraintApplies(resource, resourceId, constraint.scope)) continue;
      const expected = constraint.expected;
      switch (constraint.field) {
        case 'resource.region':
          if (typeof expected === 'string') resource = { ...resource, region: expected };
          break;
        case 'resource.instance_type':
          if (typeof expected === 'string') resource = { ...resource, size: expected };
          break;
        case 'resource.count':
          if (Number.isFinite(Number(expected))) resource = { ...resource, quantity: String(expected) };
          break;
        case 'resource.hours_per_month': {
          const hours = Number(expected);
          if (Number.isFinite(hours) && hours > 0 && hours <= 744) resource = {
            ...resource,
            hoursPerMonth: hours,
            hoursPerDay: Math.max(1, Math.min(24, Math.round((hours / HOURS_PER_MONTH) * 24))),
          };
          break;
        }
        case 'resource.purchase_model':
          if (typeof expected === 'string') resource = { ...resource, purchase_model: expected };
          break;
        case 'database.multi_az':
          if (expected === true) resource = {
            ...resource,
            notes: [resource.notes, 'Multi-AZ required by confirmed plan'].filter(Boolean).join('; '),
          };
          break;
        case 'database.engine':
          if (typeof expected === 'string') resource = { ...resource, os: expected };
          break;
        case 'api_gateway.api_type':
        case 'sns.delivery_type':
        case 'ses.send_source':
        case 'cognito.tier':
        case 'lambda.execution_profile':
        case 'bedrock.model':
        case 'bedrock.tokens_per_call':
        case 'sagemaker.inference_configuration':
        case 'quicksight.subscription_profile':
        case 'load_balancer.capacity_profile':
        case 'waf.traffic_profile':
        case 'memorydb.data_profile':
        case 'nat_gateway.configuration':
          resource = {
            ...resource,
            configuration: {
              ...(resource.configuration || {}),
              [constraint.field]: expected,
            },
            attributes: [
              ...(resource.attributes || []).filter((entry) => entry.label !== constraint.field),
              { label: constraint.field, value: typeof expected === 'string' ? expected : JSON.stringify(expected) },
            ],
          };
          break;
        default:
          // Unknown fields remain requirements in the manifest and therefore make the run
          // partial/unverifiable instead of being silently treated as applied.
          break;
      }
    }
    return resource;
  });
}

/**
 * Runs the whole estimate: group, classify, price, save, narrate.
 *
 * Replaces runEstimateLoop. The signature takes the record and rows rather than a built
 * prompt string, because the pipeline needs the structured rows — a prompt is a thing it
 * builds for one bounded call, not the interface it works from.
 */
export async function runEstimatePipeline(
  record: CalculationRecord,
  resources: CalculationResource[],
  mcp: CalculatorGateway,
  onProgress?: PipelineProgress,
  canonicalModel?: CanonicalWorkbook,
): Promise<PipelineOutcome> {
  const startedAt = Date.now();
  // Per-estimate, not per-container: a warm Lambda would otherwise reuse rates read on an
  // earlier invocation, which could be hours old.
  resetPriceCache();
  const client = new BedrockRuntimeClient({ region: REGION });
  const toolCalls: { name: string; isError: boolean }[] = [];
  let modelCalls = 0;

  const onCall = (name: string, isError: boolean) => { toolCalls.push({ name, isError }); };
  const remaining = () => PIPELINE_DEADLINE_MS - (Date.now() - startedAt);

  const defaultRegion = record.region || record.workbook?.primary_region || 'ap-south-1';
  const planRevision = record.plan_v2?.revisions.find(
    (revision) => revision.revisionId === (record.confirmed_plan_revision_id || record.plan_v2?.currentRevisionId),
  );
  const semanticResources = canonicalModel?.rows?.length ? resourcesFromCanonicalModel(canonicalModel) : resources;
  const plannedResources = materializePlanResources(semanticResources, planRevision);

  // --- 1. Group. Code, instant, and already covered by calculator-prompt tests. -----
  await onProgress?.({ stage: 'grouping', message: 'Folding the inventory into groups' });

  const hoursFor = new Map(
    (record.environment_hours || []).map((entry) => [entry.name.trim().toLowerCase(), entry.hoursPerDay]),
  );
  const priceable = plannedResources.filter((row) => row.service || row.size || row.vcpu !== undefined);
  const baselineGroups = groupResources(priceable, hoursFor, 'baseline');
  const hasRightSizing = priceable.some((row) => row.right_sized_size);
  const rightsizedGroups = hasRightSizing
    ? groupResources(priceable, hoursFor, 'rightsized')
    : [];

  console.log(
    `Pipeline: ${priceable.length} priceable row(s) -> ${baselineGroups.length} baseline group(s)`
    + `${hasRightSizing ? `, ${rightsizedGroups.length} right-sized group(s)` : ''}.`,
  );

  if (!baselineGroups.length) {
    throw new Error('NO_PRICEABLE_ROWS: the uploaded file produced no resources that could be priced.');
  }


  const bands = (record.workbook?.bands ?? [])
    .filter((band) => priceable.some((row) => row.scenario === band.key));

  const segments: Segment[] = [];

  const requestedScenarios = planRevision?.scenarios ?? record.requested_plan?.scenarios ?? [];
  const { segments: requestedSegments, unmatched: unmatchedRequests } =
    planSegments(requestedScenarios, priceable, bands, hoursFor, planRevision?.requirements);
  segments.push(...requestedSegments);
  const requested = requestedScenarios;

  // Two or more bands is what makes them scenarios. One band is just an inventory that
  // happened to be written sideways, and priced as a single estimate it behaves exactly
  // as a flat sheet does -- including emitting no scenarios at all.
  if (!segments.length && bands.length > 1) {
    for (const band of bands) {
      const groups = groupResources(
        priceable.filter((row) => row.scenario === band.key),
        hoursFor,
        'baseline',
      );
      if (!groups.length) continue;
      segments.push({
        key: band.key,
        label: band.label,
        kind: band.kind,
        detail: band.kind === 'period'
          // Stated because adding consecutive years is the mistake this shape invites, and
          // a reader who makes it overstates the estate by the number of years in the sheet.
          ? `${band.label} as the sheet sizes it, costed from today's live rates. Consecutive with the other periods, so this total replaces theirs rather than adding to them.`
          : `The ${band.label} environment as the sheet sizes it. Concurrent with the other environments, so these totals do add up.`,
        groups,
        pricingModel: 'sheet-specified',
      });
    }
  }
  if (!segments.length) {
    segments.push({
      key: 'baseline',
      label: 'Lift and shift',
      kind: 'sizing',
      detail: 'Every machine at the size the uploaded file targets. This is the configuration the shareable link describes.',
      groups: baselineGroups,
      pricingModel: 'sheet-specified',
    });
    if (rightsizedGroups.length) {
      segments.push({
        key: 'rightsized',
        label: 'Right-sized',
        kind: 'sizing',
        detail: 'The same machines at the sizes the file recommends, costed from the same live rates. Not saved to the shareable link, because it is not the agreed configuration.',
        groups: rightsizedGroups,
        pricingModel: 'sheet-specified',
      });
    }
  }

  // --- 2. Plan. Code first; the model only sees what code could not map. -----------
  const allGroups = segments.flatMap(
    (segment) => segment.groups.map((group) => ({ group, scenario: segment.key })),
  );

  const plans = new Map<number, GroupPlan>();
  const pending: { index: number; group: ResourceGroup }[] = [];
  allGroups.forEach((entry, index) => {
    const derived = planFromGroup(entry.group, defaultRegion);
    if (derived) plans.set(index, derived);
    else pending.push({ index, group: entry.group });
  });

  if (pending.length) {
    await onProgress?.({
      stage: 'classifying',
      message: `Identifying AWS services for ${pending.length} group(s)`,
    });
    const classified = await classifyGroups(client, pending, defaultRegion, () => { modelCalls += 1; });
    for (const [index, plan] of classified) plans.set(index, plan);
  }
  console.log(
    `Pipeline: ${allGroups.length - pending.length} group(s) mapped by rule, ${pending.length} by model.`,
  );

  // --- 3. Price. Parallel, and the step that used to cost minutes. -----------------
  await onProgress?.({ stage: 'pricing', message: `Pricing ${allGroups.length} group(s) from live AWS rates` });

  const commitmentOf = new Map(
    segments.filter((segment) => segment.commitment).map((segment) => [segment.key, segment.commitment!]),
  );

  const priceInput = allGroups.map((entry, index) => ({
    group: entry.group,
    commitment: commitmentOf.get(entry.scenario),
    plan: plans.get(index) ?? {
      serviceCode: '',
      filters: {},
      basis: 'not mapped',
      unsupported: 'no service mapping was produced for this group',
    },
  }));
  const pricedAll = await priceGroups(priceInput, defaultRegion, onCall);

  const sumOf = (entries: PricedGroup[]) => entries.reduce(
    (total, entry) => total + (entry.computeMonthly ?? 0) + (entry.storageMonthly ?? 0),
    0,
  );

  // The priced array comes back in the order it was sent, so each segment reclaims its own
  // run by the length it contributed. Walking the offsets rather than slicing at one known
  // point is what lets there be more than two of them.
  const pricedSegments: Array<Segment & { priced: PricedGroup[]; monthly: number }> = [];
  let offset = 0;
  for (const segment of segments) {
    const slice = pricedAll.slice(offset, offset + segment.groups.length);
    offset += segment.groups.length;
    pricedSegments.push({ ...segment, priced: slice, monthly: sumOf(slice) });
  }

  // The first segment is the estimate: its total is the headline, its groups are the line
  // items, and it is the one configuration the shareable link describes. For a fiscal-year
  // sheet that is the first year, which is the only one a reader can act on today.
  const priced = pricedSegments[0].priced;
  const baselineTotal = pricedSegments[0].monthly;
  // Kept for the narrative, which says something specific about a right-sized alternative
  // and must not say it about a fiscal year.
  const rightsized = pricedSegments.find((segment) => segment.key === 'rightsized');
  const rightsizedTotal = rightsized ? rightsized.monthly : null;
  const misses = priced.filter((entry) => entry.miss).length;

  console.log(
    `Pipeline: priced ${priced.length - misses}/${priced.length} group(s) of `
    + `"${pricedSegments[0].label}", $${baselineTotal.toFixed(2)}/mo`
    + `${pricedSegments.length > 1 ? `; ${pricedSegments.length} scenario(s) total (`
      + `${pricedSegments.map((segment) => `${segment.label}: $${segment.monthly.toFixed(2)}`).join(', ')})` : ''}`
    + `, ${Math.round(remaining() / 1000)}s budget left.`,
  );

  // --- 4. Save and validate every requested scenario. ------------------------------
  await onProgress?.({ stage: 'saving', message: `Saving ${pricedSegments.length} AWS Calculator scenario(s)` });
  const inputHash = record.workbook_hash || record.calculation_id;
  const savedSegments = await withConcurrency(pricedSegments.map((segment, index) => ({ segment, index })), 2, async ({ segment, index }) => saveEstimate(
    mcp,
    pricedSegments.length > 1 ? `${record.name} - ${segment.label}` : record.name,
    segment.key,
    segment.priced,
    {
      planRevision: planRevision ? {
        ...planRevision,
        requirements: planRevision.requirements.filter((requirement) => {
          const scenarioScopes = requirement.scope.filter((scope) => scope.startsWith('scenario:'));
          return !scenarioScopes.length || scenarioScopes.includes(`scenario:${index}`);
        }),
      } : undefined,
      inputHash,
      requestedPricing: segment.pricingModel || 'sheet-specified',
    },
    onCall,
  ));
  const saved = savedSegments[0];

  // --- 5. Narrate. Bounded, optional, and last. ------------------------------------
  const notes = deterministicNotes(priced, record, defaultRegion);
  // Named individually rather than counted. A reader comparing the document against what they
  // asked for needs to know WHICH band is missing; "3 scenarios were not priced" leaves them
  // to work it out by elimination, which on an eighteen-band request nobody does.
  for (const missing of unmatchedRequests) notes.warnings.push(missing);
  const reportedTotal = record.workbook?.reported_monthly_total ?? null;

  if (requested.length) {
    notes.assumptions.push(
      `This estimate prices ${segments.length} of the ${requested.length} scenario(s) requested `
      + `(${segments.map((segment) => segment.label).join(', ')}), each on the pricing model asked for `
      + 'rather than on the terms stated in the uploaded sheet.'
      + (record.requested_plan?.rationale ? ` Requested because: ${record.requested_plan.rationale}` : ''),
    );
  }

  // A multi-scenario upload needs its headline figure pinned to one configuration in words,
  // not just in the scenario table. A reader who takes the total as the whole sheet either
  // adds five fiscal years together or reads one environment as the estate.
  if (pricedSegments.length > 1 && pricedSegments[0].kind !== 'sizing') {
    notes.assumptions.push(
      `The uploaded sheet states ${pricedSegments.length} configurations across its columns `
      + `(${pricedSegments.map((segment) => segment.label).join(', ')}). The headline total and the `
      + `shareable link describe "${pricedSegments[0].label}" only; every configuration is priced `
      + `from the same live rates and listed as its own scenario. `
      + (pricedSegments[0].kind === 'period'
        ? 'The periods are consecutive, so their totals must not be added together.'
        : 'The environments are concurrent, so their totals do add up to the estate.'),
    );
  }

  await onProgress?.({ stage: 'narrating', message: 'Writing up assumptions and warnings' });
  try {
    modelCalls += 1;
    const facts = [
      `Region priced: ${defaultRegion}.`,
      `Groups priced: ${priced.length - misses} of ${priced.length}.`,
      `Machines covered: ${priced.reduce((sum, entry) => sum + entry.group.count, 0)}.`,
      reportedTotal !== null
        ? `The client's own file modelled ${round2(reportedTotal)} per month; our live-rate total is ${round2(baselineTotal)}.`
        : 'The client\'s file stated no monthly total to compare against.',
      rightsizedTotal !== null
        ? `A right-sized scenario was also priced at ${round2(rightsizedTotal)} per month.`
        : '',
      misses ? `Unpriced groups and why:\n${priced.filter((entry) => entry.miss).map((entry) => `- ${labelOf(entry.group)}: ${entry.miss}`).join('\n')}` : '',
      saved.warning ? `Estimate validation: ${saved.warning}` : 'A validated shareable calculator.aws link was created.',
      record.workbook?.facts?.length
        ? `The client's own stated assumptions:\n${record.workbook.facts.slice(0, 40).map((fact) => `- ${fact.label}: ${fact.value}`.slice(0, 300)).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');

    const reply = await askModel(client, {
      system: NARRATE_SYSTEM,
      user: facts,
      maxTokens: NARRATE_MAX_TOKENS,
      tier: 'HAIKU_4_5',
    });
    const parsed = parseJsonObject(reply);
    notes.assumptions.push(...stringList(parsed.assumptions));
    notes.warnings.push(...stringList(parsed.warnings));
  } catch (error) {
    // The estimate is already complete and correct at this point; losing the prose is
    // a cosmetic degradation and must never fail the run.
    console.warn(`Narrative call failed (${(error as Error).message}); using derived notes only.`);
    notes.warnings.push('The written commentary could not be generated; the figures and the derived notes below are unaffected.');
  }

  for (const scenario of savedSegments) {
    if (scenario.warning) notes.warnings.push(scenario.warning);
  }

  // Per-server rows for the Excel export, allocated from the baseline groups -- the
  // committed configuration, which is what the shareable link and monthlyTotal describe.
  const serverRows = toServers(priced, priceable);
  const servers = serverRows.length && serverRows.length <= MAX_SERVER_ROWS
    ? serverRows
    : undefined;
  if (serverRows.length > MAX_SERVER_ROWS) {
    notes.assumptions.push(
      `The Excel workbook lists priced groups rather than one row per server: this estimate covers `
      + `${serverRows.length} machines, more than a single stored estimate can carry per-server detail for. `
      + `Group rows carry the same rates and the same totals.`,
    );
  }

  // --- 6. Assemble. ---------------------------------------------------------------
  // One scenario per priced segment, but only when there is a choice to present: a single
  // configuration is the estimate itself, and listing it as its own alternative says nothing.
  const scenarios: CalculationResult['scenarios'] = pricedSegments.length > 1
    ? pricedSegments.map((segment, index) => ({
      key: segment.key,
      label: segment.label,
      kind: segment.kind,
      status: savedSegments[index].status,
      monthly: savedSegments[index].status === 'COMPLETED' ? savedSegments[index].snapshot?.monthly ?? null : null,
      upfront: savedSegments[index].status === 'COMPLETED' ? savedSegments[index].snapshot?.upfront ?? null : null,
      total_12_months: savedSegments[index].status === 'COMPLETED' ? savedSegments[index].snapshot?.total12Months ?? null : null,
      url: savedSegments[index].url,
      requirement_checks: savedSegments[index].requirementChecks,
      validation_errors: savedSegments[index].validationErrors,
      saved_snapshot_hash: savedSegments[index].snapshot?.hash,
      manifest: savedSegments[index].manifest,
      detail: segment.detail,
      // Which commitment this column was priced on, over which services. Per scenario
      // because a fiscal-year sheet can state a different purchase model in every column,
      // and a reader comparing two scenarios needs to know whether they differ by size,
      // by year, or by pricing model.
      ...segmentPricing(segment.priced),
      // Only for environment bands. A fiscal year is not an environment, and a guessed
      // production/lower split is worse than none: a reader would filter and subtotal on it.
      ...(segment.kind === 'environment'
        ? { environment_group: environmentGroupOf(segment.label) }
        : {}),
    }))
    : [];

  const allValidationErrors = savedSegments.flatMap((entry) => entry.validationErrors);
  const outcomeStatus: PipelineOutcome['status'] = savedSegments.every((entry) => entry.status === 'COMPLETED')
    ? 'COMPLETED'
    : savedSegments.every((entry) => entry.status === 'FAILED') ? 'FAILED' : 'PARTIAL';

  const result: CalculationResult = {
    url: saved.url,
    currency: 'USD',
    monthlyTotal: saved.status === 'COMPLETED' ? saved.snapshot?.monthly ?? null : null,
    lineItems: toLineItems(priced),
    environments: toEnvironments(priced, record),
    scenarios,
    reportedMonthlyTotal: reportedTotal === null ? null : round2(reportedTotal),
    // Deduplicated: the derived notes and the model's prose overlap by design.
    assumptions: [...new Set(notes.assumptions)],
    warnings: [...new Set(notes.warnings)],
    servers,
    ebsRatePerGbMonth: priced.find((entry) => entry.storageRatePerGbMonth !== undefined)
      ?.storageRatePerGbMonth,
    validationErrors: [...new Set(allValidationErrors)],
    diagnostics: {
      BUILD_SHA: process.env.BUILD_SHA || process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || 'unknown',
      ADAPTER_REGISTRY_VERSION,
      MCP_PACKAGE_VERSION,
    },
  };

  console.log(
    `Pipeline complete in ${Math.round((Date.now() - startedAt) / 1000)}s: `
    + `${modelCalls} model call(s), ${toolCalls.length} lookup(s), url=${saved.url ? 'yes' : 'no'}.`,
  );

  return { result, status: outcomeStatus, iterations: modelCalls, toolCalls };
}
