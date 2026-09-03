/**
 * Post-build verification: did the Calculator end up holding what was asked for?
 *
 * Seven questions, each a plain yes or no. Were all requested resources added? Did the MCP's
 * own validation pass? Is there a calculator.aws URL? Did the page render totals? Can the saved
 * estimate be read back? Do the values that CAN be read back still say what was sent? Did the
 * requested pricing model resolve the way it was recorded?
 *
 * What it deliberately does not do is compare the Calculator's saved JSON against a handwritten
 * expectation of it. A service sent as `amazonS3Standard` comes back inside an
 * `amazonSimpleStorageServiceGroup` envelope; a `{value: "2"}` comes back as `2`; the builder
 * injects tenancy and monitoring fields nobody sent. None of that is a defect, and the old
 * validator that called it PARTIAL made every honest estimate look broken. Here a value that
 * cannot be read back is NEEDS_REVIEW, a value that reads back DIFFERENT is a real finding,
 * and only a resource that genuinely failed to be added is PARTIAL.
 */

import { resourceIdFromDescription } from './field-mapping';
import type {
  ExecutorStatus,
  PricingResolution,
  RenderedTotals,
  ResourceOutcome,
  SemanticResource,
  VerificationFinding,
} from './types';

export interface SavedService {
  key: string;
  serviceCode?: string;
  description?: string;
  group?: string;
  components: Record<string, unknown>;
}

/** Every service in a saved estimate, flattened out of its groups and sub-service envelopes. */
export function savedServices(estimate: unknown): SavedService[] {
  const out: SavedService[] = [];
  const root = estimate as { groups?: Record<string, { name?: string; services?: Record<string, unknown> }>; services?: Record<string, unknown> } | undefined;
  const visit = (key: string, service: unknown, group?: string) => {
    const record = service as Record<string, unknown> | undefined;
    if (!record) return;
    const subServices = record.subServices as unknown[] | undefined;
    if (Array.isArray(subServices) && subServices.length) {
      subServices.forEach((child, index) => visit(`${key}:${index}`, { ...(child as Record<string, unknown>), description: (child as Record<string, unknown>).description ?? record.description }, group));
    }
    out.push({
      key,
      serviceCode: typeof record.serviceCode === 'string' ? record.serviceCode : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
      group,
      components: (record.calculationComponents as Record<string, unknown>) || (record.config as Record<string, unknown>) || {},
    });
  };
  for (const [groupKey, group] of Object.entries(root?.groups || {})) {
    for (const [key, service] of Object.entries(group?.services || {})) visit(key, service, group?.name || groupKey);
  }
  for (const [key, service] of Object.entries(root?.services || {})) visit(key, service);
  return out;
}

/** `{value: X}` wrappers removed and numeric strings read as numbers, recursively. */
export function normalizeSaved(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSaved);
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'value') return normalizeSaved(record.value);
  // The EC2 builder saves a count as {workloadType: "consistent", data: "4"}: the number is
  // in `data`, the rest is the Calculator's own framing. Only the number was sent.
  if ('data' in record && keys.every((key) => key === 'data' || key === 'workloadType')) return normalizeSaved(record.data);
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalizeSaved(child)]));
}

const same = (a: unknown, b: unknown) => JSON.stringify(normalizeSaved(a)) === JSON.stringify(normalizeSaved(b));

/**
 * Whether a saved pricing component still says the requested model and term.
 *
 * The saved shape is `{selectedOption, term, upfrontPayment, model}` where ours was
 * `{model, term, upfrontPayment}`; only the fields both carry are compared.
 */
function pricingHeld(sent: unknown, saved: unknown): boolean | undefined {
  if (sent === undefined) return undefined;
  const savedValue = normalizeSaved(saved) as Record<string, unknown> | string | undefined;
  if (typeof sent === 'string') {
    if (savedValue === undefined) return undefined;
    if (typeof savedValue === 'string') return savedValue.toLowerCase().replace(/[^a-z]/g, '') === sent.toLowerCase().replace(/[^a-z]/g, '');
    const option = String(savedValue.selectedOption ?? savedValue.model ?? '').toLowerCase().replace(/[^a-z]/g, '');
    return option === sent.toLowerCase().replace(/[^a-z]/g, '');
  }
  if (!savedValue || typeof savedValue !== 'object') return savedValue === undefined ? undefined : false;
  const want = sent as { model?: string; term?: string; upfrontPayment?: string };
  const modelOk = !want.model || String(savedValue.model ?? '').toLowerCase() === want.model.toLowerCase()
    || String(savedValue.selectedOption ?? '').toLowerCase().replace(/[^a-z]/g, '') === want.model.toLowerCase().replace(/[^a-z]/g, '');
  const termOk = !want.term || String(savedValue.term ?? '').replace(/\s/g, '').toLowerCase() === want.term.replace(/\s/g, '').toLowerCase();
  const upfrontOk = !want.upfrontPayment || String(savedValue.upfrontPayment ?? '').toLowerCase() === want.upfrontPayment.toLowerCase();
  return modelOk && termOk && upfrontOk;
}

export interface VerificationInput {
  resources: SemanticResource[];
  outcomes: ResourceOutcome[];
  pricing: PricingResolution[];
  mcpValidation: { ran: boolean; passed: boolean; detail?: string };
  url?: string;
  savedEstimate?: unknown;
  readBackError?: string;
  totals: RenderedTotals;
}

export interface Verdict {
  status: ExecutorStatus;
  findings: VerificationFinding[];
  summary: string;
}

export function verifyEstimate(input: VerificationInput): Verdict {
  const findings: VerificationFinding[] = [];
  const critical = (check: VerificationFinding['check'], message: string, resourceId?: string) => findings.push({ check, severity: 'critical', message, resourceId });
  const review = (check: VerificationFinding['check'], message: string, resourceId?: string) => findings.push({ check, severity: 'review', message, resourceId });
  const info = (check: VerificationFinding['check'], message: string, resourceId?: string) => findings.push({ check, severity: 'info', message, resourceId });

  // 1. Every requested resource was added.
  const notAdded = input.outcomes.filter((outcome) => outcome.status !== 'ADDED');
  for (const outcome of notAdded) {
    const last = outcome.attempts[outcome.attempts.length - 1];
    critical('resources-added', outcome.status === 'MISSING_INPUT'
      ? `${outcome.service} (${outcome.resourceId}) could not be configured: missing ${(outcome.missingInputs || []).join(', ')}.`
      : `${outcome.service} (${outcome.resourceId}) was refused by the Calculator after ${outcome.attempts.length} attempt(s)${last?.error ? `: ${last.error.slice(0, 300)}` : '.'}`,
    outcome.resourceId);
  }
  const added = input.outcomes.filter((outcome) => outcome.status === 'ADDED');

  // 2. No usable estimate at all is FAILED, before anything else is worth checking.
  if (!input.url || added.length === 0) {
    if (!input.url) critical('url', 'No calculator.aws URL was produced.');
    return { status: 'FAILED', findings, summary: !input.url ? 'No AWS Pricing Calculator estimate was saved.' : 'No requested resource could be added to the estimate.' };
  }
  if (!/^https:\/\/[^/]*calculator\.aws\//.test(input.url)) critical('url', `The saved link is not a calculator.aws URL: ${input.url}`);

  // 3. The MCP's own validation.
  if (!input.mcpValidation.ran) review('mcp-validation', 'validate_estimate was not run.');
  else if (!input.mcpValidation.passed) critical('mcp-validation', `validate_estimate did not pass: ${(input.mcpValidation.detail || '').slice(0, 400)}`);

  // 4. Totals.
  if (input.totals.source === 'none') review('totals', 'The Calculator page could not be rendered, so monthly, upfront and 12-month totals were not read back.');
  else if ((input.totals.monthly ?? 0) === 0 && (input.totals.upfront ?? 0) === 0) critical('totals', 'The Calculator rendered a $0 estimate for a non-empty resource list, which means at least one service rehydrated with a default that prices to nothing.');
  else info('totals', `Calculator totals read back: monthly ${input.totals.monthly}, upfront ${input.totals.upfront}, 12-month ${input.totals.total12Months}.`);

  // 5 & 6. Read-back, and the values that can be compared.
  if (!input.savedEstimate) {
    review('read-back', `The saved estimate could not be read back, so its contents were not verified${input.readBackError ? `: ${input.readBackError}` : '.'}`);
  } else {
    const saved = savedServices(input.savedEstimate);
    // Fewer services saved than added means the Calculator kept the URL and dropped resources —
    // the $4,601/month-off-the-link bug — and that is a real loss, not a naming difference.
    const dropped = saved.length < added.length;
    for (const outcome of added) {
      const match = saved.find((service) => resourceIdFromDescription(service.description) === outcome.resourceId);
      if (!match) {
        // Sent and accepted, but not visible on read-back. With the service count intact a
        // parent-envelope merge can hide a child behind its parent's description, so that is
        // review; with the count short, something was genuinely discarded.
        (dropped ? critical : review)('read-back', `${outcome.service} (${outcome.resourceId}) was added but could not be located in the saved estimate by its description${dropped ? `; the estimate holds ${saved.length} service(s) for ${added.length} added` : ''}.`, outcome.resourceId);
        continue;
      }
      const sent = outcome.finalConfig || {};
      for (const [key, value] of Object.entries(sent)) {
        if (key === 'region' || key === 'description') continue;
        const savedValue = match.components[key];
        if (key === 'pricingStrategy') {
          const held = pricingHeld(value, savedValue);
          if (held === false) critical('pricing-resolution', `${outcome.service} (${outcome.resourceId}): the saved pricing is ${JSON.stringify(savedValue)}, not the requested ${JSON.stringify(value)}.`, outcome.resourceId);
          else if (held === undefined) review('pricing-resolution', `${outcome.service} (${outcome.resourceId}): the saved estimate carries no readable pricing component to confirm ${JSON.stringify(value)}.`, outcome.resourceId);
          continue;
        }
        if (savedValue === undefined) {
          review('semantic-values', `${outcome.service} (${outcome.resourceId}): "${key}" is not readable in the saved estimate.`, outcome.resourceId);
          continue;
        }
        if (!same(value, savedValue)) {
          const unitChanged = typeof value === 'object' && value !== null && 'unit' in (value as Record<string, unknown>)
            && (normalizeSaved(savedValue) as Record<string, unknown> | undefined)?.unit !== (value as Record<string, unknown>).unit;
          // A changed unit is the silent-mispricing case and is never merely "for review".
          (unitChanged ? critical : review)('semantic-values',
            `${outcome.service} (${outcome.resourceId}): "${key}" was sent as ${JSON.stringify(value)} and saved as ${JSON.stringify(savedValue)}.`, outcome.resourceId);
        }
      }
    }
  }

  // 7. Pricing resolution recorded per service, stated when it differs from the request.
  for (const entry of input.pricing) {
    if (entry.requested !== entry.resolved) info('pricing-resolution', `${entry.service} (${entry.resourceId}): requested ${entry.requested}, resolved ${entry.resolved} — ${entry.reason}`, entry.resourceId);
  }

  const criticals = findings.filter((finding) => finding.severity === 'critical');
  const reviews = findings.filter((finding) => finding.severity === 'review');
  const status: ExecutorStatus = criticals.length ? 'PARTIAL' : reviews.length ? 'NEEDS_REVIEW' : 'COMPLETED';
  const summary = status === 'COMPLETED'
    ? `All ${added.length} resource(s) are in the saved estimate and every readable value matches what was sent.`
    : status === 'NEEDS_REVIEW'
      ? `The estimate is complete; ${reviews.length} propert${reviews.length === 1 ? 'y' : 'ies'} could not be independently read back.`
      : `${criticals.length} problem(s) found: ${criticals[0].message}`;
  return { status, findings, summary };
}
