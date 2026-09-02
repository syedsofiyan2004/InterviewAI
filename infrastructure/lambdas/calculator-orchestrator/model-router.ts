export type CalculatorModelTier = 'CODE' | 'HAIKU_4_5' | 'SONNET_4_6';

export type SemanticTaskKind =
  | 'label_mapping'
  | 'layout_relationship'
  | 'scenario_detection'
  | 'simple_change'
  | 'complex_change'
  | 'conflict_resolution';

export interface RoutingEvidence {
  candidateCount: number;
  hasConflictingSources: boolean;
  schemaCompleteness: number;
  deterministicRuleMatched: boolean;
  affectsResourceCount: number;
  affectsScenarioCount: number;
  priorAttemptFailed?: boolean;
}

export function chooseTier(task: SemanticTaskKind, evidence: RoutingEvidence): CalculatorModelTier {
  if (evidence.deterministicRuleMatched
    && !evidence.hasConflictingSources
    && evidence.schemaCompleteness === 1) return 'CODE';
  if (['label_mapping', 'scenario_detection', 'simple_change'].includes(task)
    && evidence.candidateCount <= 3
    && !evidence.hasConflictingSources
    && (evidence.affectsResourceCount <= 1 || evidence.affectsScenarioCount <= 1)
    && !evidence.priorAttemptFailed) return 'HAIKU_4_5';
  return 'SONNET_4_6';
}

const DEFAULT_FAST = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_REASONING = 'global.anthropic.claude-sonnet-4-6';

export function calculatorModelId(tier: Exclude<CalculatorModelTier, 'CODE'>): string {
  return tier === 'HAIKU_4_5'
    ? process.env.CALCULATOR_FAST_MODEL_ID || DEFAULT_FAST
    : process.env.CALCULATOR_REASONING_MODEL_ID || DEFAULT_REASONING;
}

export function calculatorChatTier(message: string): Exclude<CalculatorModelTier, 'CODE'> {
  const text = message.toLowerCase();
  const complex = /\b(compare|matrix|architecture|disaster recovery|\bdr\b|high availability|multi[- ]az|across|all scenarios|several|multiple)\b/.test(text)
    || (text.match(/\b(ec2|rds|aurora|fargate|opensearch|redshift|lambda|s3|cloudfront)\b/g)?.length || 0) > 1;
  return complex ? 'SONNET_4_6' : 'HAIKU_4_5';
}

