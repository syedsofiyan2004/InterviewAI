/**
 * Turns the executor's preflight into Review questions on a plan.
 *
 * The initial plan already asks about what the WORKBOOK left unsaid. This adds what the
 * CALCULATOR will refuse to price without — read from the live schema of the service each
 * resource resolved to — so a reviewer sees, before anything is built, "Deployment option:
 * Single-AZ or Multi-AZ" with the Calculator's own choices in the dropdown, rather than
 * learning it from a PARTIAL estimate afterwards.
 *
 * Only questions whose answer the pipeline knows how to apply are added: an answer nobody
 * acts on is worse than no question. The mapping from a Calculator input to the plan's
 * requirement field goes through the semantic vocabulary (instance class, count, deployment,
 * engine, task frequency, task duration), never through a Calculator field id.
 */

import type { CalculationResource, EnvironmentHours } from '../../schema/calculator';
import type { EstimatePlanV2, PlanQuestion } from '../../schema/estimate-plan';
import { semanticKeysForLabel } from '../aws-calculator-mcp-executor/field-mapping';
import { preflightResources, type PreflightQuestion } from '../aws-calculator-mcp-executor/preflight';
import { toSemanticResources } from '../aws-calculator-mcp-executor/semantic-resources';
import type { McpGateway } from '../aws-calculator-mcp-executor/types';
import { groupResources } from '../calculator-orchestrator/prompt';

/** The plan requirement field a Calculator input answers, or undefined when none applies it. */
export function requirementFieldFor(question: PreflightQuestion): string | undefined {
  const label = question.label.toLowerCase();
  if (/instance type|ec2 instance|instance class|instance name|broker instance/.test(label)) return 'resource.instance_type';
  if (/number of nodes|^nodes$|number of instances|workload|number of .*(brokers|load balancers|gateways)/.test(label)) return 'resource.count';
  if (/deployment|multi-?az/.test(label)) return 'database.multi_az';
  if (/engine/.test(label)) return 'database.engine';
  if (/number of tasks|tasks or pods/.test(label)) return 'fargate.task_frequency';
  if (/average duration|task duration/.test(label)) return 'fargate.task_duration';
  return undefined;
}

/**
 * Which semantic keys each plan field already supplies, so a Calculator input the plan asks
 * for under its own name is not asked for a second time under the Calculator's.
 */
const SUPPLIED_KEYS: Record<string, string[]> = {
  'resource.instance_type': ['instanceType'],
  'resource.count': ['instanceCount', 'nodeCount'],
  'resource.hours_per_month': ['duration', 'utilizationPct'],
  'database.multi_az': ['deployment'],
  'database.engine': ['engine'],
  'fargate.task_frequency': ['taskCount'],
  'fargate.task_duration': ['duration'],
  'lambda.execution_profile': ['memoryMb', 'memoryGbPerTask', 'requestDurationMs'],
  'sagemaker.inference_configuration': ['instanceType', 'workloadType'],
  'cognito.tier': ['tier', 'monthlyTokenRequests'],
  'nat_gateway.configuration': ['mode', 'availabilityZoneCount', 'numberOfRegionalNatGateways', 'numberOfAvailabilityZonesRegionalNatGatewaysIsActiveIn'],
  'bedrock.model': ['model', 'provider'],
  'bedrock.tokens_per_call': ['inputTokens', 'outputTokens'],
  'quicksight.subscription_profile': ['spiceCapacityInGigabytes', 'spiceGb'],
};

/** "Number of models deployed" → numberOfModelsDeployed: a semantic key named from the label. */
export function semanticKeyFor(label: string): string {
  const words = label.replace(/\(.*?\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase())).join('');
}

export interface PreflightEnrichment {
  plan: EstimatePlanV2;
  added: number;
  /** Questions the Calculator raised that the plan cannot yet apply an answer to. */
  unapplied: PreflightQuestion[];
  mcpVersion?: string;
}

export async function enrichPlanWithCalculatorPreflight(
  plan: EstimatePlanV2,
  resources: CalculationResource[],
  defaultRegion: string,
  gateway: McpGateway,
  hours: EnvironmentHours[],
  budgetMs = 12_000,
): Promise<PreflightEnrichment> {
  const hoursFor = new Map(hours.map((entry) => [entry.name.trim().toLowerCase(), entry.hoursPerDay]));
  const priceable = resources.filter((row) => row.configuration?.['resource.exclude'] !== true && (row.service || row.size || row.vcpu !== undefined));
  const groups = groupResources(priceable, hoursFor, 'baseline');
  if (!groups.length) return { plan, added: 0, unapplied: [] };

  const semantic = toSemanticResources({ segmentKey: 'preflight', groups, defaultRegion });
  const report = await preflightResources(semantic, gateway, { budgetMs });

  /** Plan resource ids are the row's index in the parsed list; a group spans several rows. */
  const scopeOf = (resourceId: string): string[] => {
    const at = semantic.findIndex((resource) => resource.resourceId === resourceId);
    const members = at >= 0 ? groups[at].members : [];
    return members.map((member) => `resource:${member}`);
  };
  const overlaps = (a: string[], b: string[]) => a.some((scope) => b.includes(scope));

  const unresolved: PlanQuestion[] = [...plan.unresolved];
  const currentRevision = plan.revisions.find((revision) => revision.revisionId === plan.currentRevisionId);
  const existingChanges: Array<{ field: string; scope: string[] }> = [
    ...plan.unresolved.map((question) => ({ field: question.field, scope: question.scope })),
    ...(currentRevision?.requirements || []).map((requirement) => ({ field: requirement.field, scope: requirement.scope })),
  ];
  /** Whether a plan question or answered requirement already covers this resource. */
  const covers = (change: { field: string; scope: string[] }, resourceScope: string[], service: string, keys: string[]) => {
    const supplied = SUPPLIED_KEYS[change.field] || [];
    if (!supplied.some((key) => keys.includes(key))) return false;
    if (!change.scope.length || change.scope.includes('all-resources')) return true;
    if (overlaps(change.scope, resourceScope)) return true;
    return change.scope.some((scope) => scope.startsWith('service:')
      && service.toLowerCase().includes(scope.slice('service:'.length).toLowerCase()));
  };

  const unapplied: PreflightQuestion[] = [];
  let added = 0;
  for (const question of report.questions) {
    // An input the vocabulary has no word for — "Number of models deployed", "Endpoint hours
    // per day" — is still asked, under a field named from its own label. The pipeline stores
    // the answer on the resource and the executor hands it to the Calculator as stated.
    const field = requirementFieldFor(question) ?? `calculator.${semanticKeyFor(question.label)}`;
    if (field === 'calculator.') {
      unapplied.push(question);
      continue;
    }
    const scope = scopeOf(question.resourceId);
    // Asked once, however many rows share it. The plan already asking for Lambda's memory
    // under lambda.execution_profile covers the Calculator's "Amount of memory allocated" for
    // every Lambda row: a second question for the same number is noise the reviewer pays for.
    const keys = [...semanticKeysForLabel(question.label), semanticKeyFor(question.label)];
    if (existingChanges.some((change) => covers(change, scope, question.service, keys))) continue;
    const duplicate = unresolved.find((entry) => entry.field === field && (overlaps(entry.scope, scope) || entry.id.startsWith('calculator-preflight-')));
    if (duplicate) {
      // The plan already asks; the Calculator's choices make its dropdown, if it had none, and
      // the question now covers this row as well.
      if (!duplicate.options?.length && question.options?.length) duplicate.options = question.options.map((option) => option.label).slice(0, 20);
      for (const entry of scope) if (!duplicate.scope.includes(entry)) duplicate.scope.push(entry);
      continue;
    }
    unresolved.push({
      id: `calculator-preflight-${field}`.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 160),
      prompt: `${question.service}: ${question.label}${question.control === 'number' && question.units?.length ? ` (${question.units.map((unit) => unit.label).join(', ')})` : ''}`,
      field,
      scope,
      impact: 'high',
      ...(question.options?.length ? { options: question.options.map((option) => option.label).slice(0, 20) } : {}),
      resolved: false,
    });
    added += 1;
  }
  const status = added && (plan.status === 'READY' || plan.status === 'DRAFT') ? 'NEEDS_INPUT' : plan.status;
  return { plan: { ...plan, unresolved, status }, added, unapplied, mcpVersion: report.mcpVersion };
}
