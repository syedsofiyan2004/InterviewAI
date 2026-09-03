/**
 * Which commitment the Calculator can actually apply to one service, read off its schema.
 *
 * Nothing in here knows that "EC2 supports Savings Plans" or that "Fargate does not". It knows
 * three ways the Calculator expresses a commitment — a `pricingStrategy` field with an option
 * list, a columnFormIPM row with a `TermType` selector, or nothing — and it reads which one a
 * service has from `get_service_fields` at run time. A service that gains a commitment option
 * in a future Calculator release becomes eligible with no code change; a service that loses
 * one stops being quoted a discount it can no longer buy.
 *
 * Two rules are absolute. The requested instrument is never swapped for another: a Savings
 * Plan request is never answered with a Reserved Instance, or the reverse, or a different
 * term. And a service that cannot take the requested commitment is priced On-Demand and SAYS
 * so, in a sentence a client can read, because a scenario labelled "3-Year Compute Savings
 * Plan" over a total that is part committed and part On-Demand is a number whose basis is
 * unstated.
 */

import {
  SCENARIO_LABELS,
  calculatorPricingStrategy,
  requiresDedicatedTenancy,
  type PricingScenarioKind,
} from '../../schema/canonical-resource';
import type { McpField, McpFieldsPayload } from './mcp-schema';
import type { PricingIntent, PricingResolution, SemanticResource } from './types';

/** The `pricingStrategy` option value each scenario kind needs to find in the field. */
const OPTION_FOR_KIND: Record<PricingScenarioKind, string> = {
  'on-demand': 'on-demand',
  spot: 'spot',
  'compute-savings-1yr': 'compute-savings',
  'compute-savings-3yr': 'compute-savings',
  'ec2-instance-savings-1yr': 'instance-savings',
  'ec2-instance-savings-3yr': 'instance-savings',
  'standard-ri-1yr': 'standard',
  'standard-ri-3yr': 'standard',
  'convertible-ri-1yr': 'convertible',
  'convertible-ri-3yr': 'convertible',
};

const isComputeSavings = (kind: PricingScenarioKind) => kind.startsWith('compute-savings');
const isReserved = (kind: PricingScenarioKind) => requiresDedicatedTenancy(kind);
const termYears = (kind: PricingScenarioKind): 1 | 3 => (kind.includes('3yr') ? 3 : 1);

/** The field the Calculator's EC2-style services carry their commitment in, if any. */
export function pricingStrategyField(payload: McpFieldsPayload): McpField | undefined {
  return (payload.fields || []).find((field) => field.id === 'pricingStrategy'
    || /pricingstrategy/i.test(field.type || ''));
}

/** The columnFormIPM field whose row carries a `TermType` selector, if any. */
export function termTypeColumnForm(payload: McpFieldsPayload, preferred?: McpField): McpField | undefined {
  const candidates = (payload.fields || []).filter((field) => field.type === 'columnFormIPM'
    && (field.row || []).some((cell) => cell.selectorId === 'TermType'));
  if (preferred && candidates.includes(preferred)) return preferred;
  return candidates[0];
}

/**
 * Options a `pricingStrategy` field lists, as lower-case tokens.
 *
 * The EC2 field lists them as `{label, value}` rather than `{id, label}`; both shapes are read.
 */
function strategyOptions(field: McpField): string[] {
  return (field.options || [])
    .map((option) => String(option.value ?? option.id ?? '').toLowerCase())
    .filter(Boolean);
}

export interface PricingApplication {
  resolution: PricingResolution;
  /** Top-level config fields to set, e.g. `pricingStrategy`. */
  topLevel: Record<string, unknown>;
  /** Cells to set inside a columnFormIPM row, keyed by selectorId. */
  columnCells: Record<string, string>;
}

const onDemandResolution = (
  resource: SemanticResource,
  intent: PricingIntent,
  via: PricingResolution['via'],
  reason: string,
): PricingResolution => ({
  resourceId: resource.resourceId,
  service: resource.service,
  requested: intent.kind,
  resolved: 'on-demand',
  reason,
  via,
});

/**
 * The commitment this service will actually be configured with, and how to write it.
 *
 * Reads the schema, never a service list. See the module comment for the two absolute rules.
 */
export function resolvePricing(
  payload: McpFieldsPayload,
  resource: SemanticResource,
  intent: PricingIntent,
  columnForm?: McpField,
): PricingApplication {
  const requestedLabel = SCENARIO_LABELS[intent.kind];

  if (intent.kind === 'on-demand') {
    const strategy = pricingStrategyField(payload);
    return {
      resolution: {
        resourceId: resource.resourceId,
        service: resource.service,
        requested: 'on-demand',
        resolved: 'on-demand',
        reason: 'On-Demand was requested.',
        via: strategy ? 'pricingStrategy' : termTypeColumnForm(payload, columnForm) ? 'columnFormIPM' : 'none',
      },
      topLevel: strategy ? { pricingStrategy: 'ondemand' } : {},
      columnCells: termTypeColumnForm(payload, columnForm) ? { TermType: 'OnDemand' } : {},
    };
  }

  const strategy = pricingStrategyField(payload);
  if (strategy) {
    const options = strategyOptions(strategy);
    const wanted = OPTION_FOR_KIND[intent.kind];
    if (!options.includes(wanted)) {
      return {
        resolution: onDemandResolution(resource, intent, 'pricingStrategy',
          `${resource.service} offers ${options.filter((option) => option !== 'on-demand').join(', ') || 'no commitment'} in the AWS Pricing Calculator, not ${requestedLabel}; priced On-Demand rather than substituting another instrument.`),
        topLevel: { pricingStrategy: 'ondemand' },
        columnCells: {},
      };
    }
    if (isReserved(intent.kind)) {
      const tenancy = String(resource.configuration.tenancy ?? 'shared').toLowerCase();
      if (tenancy !== 'dedicated' && tenancy !== 'host') {
        // The catalog's own trap: Standard and Convertible RIs are hidden under shared
        // tenancy and a save may silently fall back. Stated, not worked around.
        return {
          resolution: onDemandResolution(resource, intent, 'pricingStrategy',
            `${requestedLabel} is only offered on dedicated or host tenancy in the AWS Pricing Calculator, and ${resource.service} here is ${tenancy} tenancy; priced On-Demand. A Savings Plan scenario commits shared-tenancy compute.`),
          topLevel: { pricingStrategy: 'ondemand' },
          columnCells: {},
        };
      }
    }
    return {
      resolution: {
        resourceId: resource.resourceId,
        service: resource.service,
        requested: intent.kind,
        resolved: intent.kind,
        reason: `AWS Pricing Calculator offers ${requestedLabel} for ${resource.service}.`,
        via: 'pricingStrategy',
      },
      topLevel: { pricingStrategy: calculatorPricingStrategy(intent.kind, intent.upfrontPayment) },
      columnCells: {},
    };
  }

  const form = termTypeColumnForm(payload, columnForm);
  if (form) {
    const termTypes = (form.selectorValues?.TermType || []).map((value) => value.toLowerCase());
    if (isComputeSavings(intent.kind) || intent.kind.startsWith('ec2-instance-savings') || intent.kind === 'spot') {
      return {
        resolution: onDemandResolution(resource, intent, 'columnFormIPM',
          `${resource.service} is not eligible for ${requestedLabel}; the AWS Pricing Calculator offers ${termTypes.length ? termTypes.join(', ') : 'no commitment'} for it. Priced On-Demand.`),
        topLevel: {},
        columnCells: { TermType: 'OnDemand' },
      };
    }
    if (!termTypes.includes('reserved')) {
      return {
        resolution: onDemandResolution(resource, intent, 'columnFormIPM',
          `The AWS Pricing Calculator offers no Reserved pricing for ${resource.service} (available: ${termTypes.join(', ') || 'On-Demand only'}); priced On-Demand.`),
        topLevel: {},
        columnCells: { TermType: 'OnDemand' },
      };
    }
    if (intent.kind.startsWith('convertible')) {
      return {
        resolution: onDemandResolution(resource, intent, 'columnFormIPM',
          `${resource.service} offers Standard Reserved pricing only; ${requestedLabel} was requested, so it is priced On-Demand rather than substituted.`),
        topLevel: {},
        columnCells: { TermType: 'OnDemand' },
      };
    }
    const lease = pickSelector(form, 'LeaseContractLength', termYears(intent.kind) === 1 ? ['1yr', '1 year', '1'] : ['3yr', '3 year', '3']);
    const purchase = pickSelector(form, 'PurchaseOption', intent.upfrontPayment === 'All'
      ? ['All Upfront', 'all upfront']
      : intent.upfrontPayment === 'Partial' ? ['Partial Upfront', 'partial upfront'] : ['No Upfront', 'no upfront']);
    return {
      resolution: {
        resourceId: resource.resourceId,
        service: resource.service,
        requested: intent.kind,
        resolved: intent.kind,
        reason: `AWS Pricing Calculator offers Reserved pricing for ${resource.service}.`,
        via: 'columnFormIPM',
      },
      topLevel: {},
      columnCells: { TermType: 'Reserved', LeaseContractLength: lease, PurchaseOption: purchase },
    };
  }

  const caveat = isComputeSavings(intent.kind) && /fargate|lambda/i.test(resource.service)
    ? ' Compute Savings Plans do discount this service in AWS billing, but the Pricing Calculator cannot model it, so this line is an upper bound.'
    : '';
  return {
    resolution: onDemandResolution(resource, intent, 'none',
      `The AWS Pricing Calculator exposes no commitment option for ${resource.service}; priced On-Demand.${caveat}`),
    topLevel: {},
    columnCells: {},
  };
}

/** A selector value by preference, falling back to the first preference when the list is empty. */
function pickSelector(form: McpField, selectorId: string, preferences: string[]): string {
  const values = form.selectorValues?.[selectorId] || [];
  if (!values.length) return preferences[0];
  for (const preference of preferences) {
    const hit = values.find((value) => value.toLowerCase() === preference.toLowerCase());
    if (hit) return hit;
  }
  return preferences[0];
}

/**
 * The mixed-pricing statement for one scenario, fit to print.
 *
 * Present whenever a commitment was requested, whether or not anything took it: "nothing in
 * this scenario could be committed" is as important a sentence as "EC2 is committed".
 */
export function mixedPricingScope(resolutions: PricingResolution[], intent: PricingIntent): string | undefined {
  // Per resolution rather than per scenario: a sheet-specified scenario asks for a different
  // commitment on every row, and each request is answered on its own terms.
  const requestedCommitment = resolutions.filter((entry) => entry.requested !== 'on-demand');
  if (intent.kind === 'on-demand' && !requestedCommitment.length) return undefined;
  const names = (entries: PricingResolution[]) => [...new Set(entries.map((entry) => entry.service))].join(', ');
  const parts: string[] = [];
  const byKind = new Map<PricingScenarioKind, PricingResolution[]>();
  for (const entry of requestedCommitment) {
    const list = byKind.get(entry.requested) || [];
    list.push(entry);
    byKind.set(entry.requested, list);
  }
  for (const [kind, entries] of byKind) {
    const label = SCENARIO_LABELS[kind];
    const held = entries.filter((entry) => entry.resolved === kind);
    parts.push(held.length
      ? `${label} applies to: ${names(held)}.`
      : `No service in this scenario could take ${label} in the AWS Pricing Calculator.`);
  }
  const onDemand = resolutions.filter((entry) => entry.resolved === 'on-demand' && entry.requested !== 'on-demand');
  if (onDemand.length) {
    parts.push(`Remaining On-Demand: ${names(onDemand)}.`);
    parts.push(...new Set(onDemand.map((entry) => entry.reason)));
  }
  const requestedOnDemand = resolutions.filter((entry) => entry.requested === 'on-demand');
  if (requestedOnDemand.length && requestedCommitment.length) parts.push(`Priced On-Demand as the source states: ${names(requestedOnDemand)}.`);
  return parts.join(' ');
}
