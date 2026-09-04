import {
  CalculationResultSchema,
  type CalculationRecord,
  type CalculationResult,
  type CalculationScenario,
} from '../../schema/calculator';
import { getFileContent } from './aws';

/**
 * DynamoDB has a hard 400 KB item limit. Calculator records also contain the parsed
 * workbook and review plan, so the render copy of a result is intentionally kept well
 * below that ceiling while the lossless result is stored in S3.
 */
export const MAX_INLINE_CALCULATION_RESULT_BYTES = 96 * 1024;

export function calculationResultKey(ownerUserId: string, calculationId: string): string {
  return `users/${ownerUserId}/calculator/${calculationId}/result.json`;
}

const unique = (values: string[] | undefined, limit: number): string[] | undefined => {
  if (!values) return undefined;
  return [...new Set(values)].slice(0, limit);
};

function compactScenario(scenario: CalculationScenario): CalculationScenario {
  const {
    manifest: _manifest,
    requirement_checks: _requirementChecks,
    validation_errors: _validationErrors,
    ...renderFields
  } = scenario;
  return renderFields;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Produces the copy used by the polling/view APIs. It preserves prices, links and
 * scenario labels, but removes execution evidence that the UI never renders. The full
 * result remains available through result_s3_key for deterministic exports and audits.
 */
export function compactCalculationResult(result: CalculationResult): CalculationResult {
  const compact = CalculationResultSchema.parse({
    ...result,
    scenarios: result.scenarios.map(compactScenario),
    servers: undefined,
    assumptions: unique(result.assumptions, 40) || [],
    warnings: unique(result.warnings, 40) || [],
    validationErrors: unique(result.validationErrors, 20),
  });

  if (byteLength(compact) <= MAX_INLINE_CALCULATION_RESULT_BYTES) return compact;

  compact.assumptions = compact.assumptions.slice(0, 15);
  compact.warnings = compact.warnings.slice(0, 15);
  compact.validationErrors = compact.validationErrors?.slice(0, 10);
  compact.environments = compact.environments.slice(0, 100);

  while (compact.lineItems.length && byteLength(compact) > MAX_INLINE_CALCULATION_RESULT_BYTES) {
    compact.lineItems = compact.lineItems.slice(0, Math.floor(compact.lineItems.length / 2));
  }
  if (compact.lineItems.length < result.lineItems.length) {
    compact.warnings = [
      ...compact.warnings,
      `The page shows ${compact.lineItems.length} of ${result.lineItems.length} cost lines; the complete result is preserved for downloads.`,
    ];
  }

  while (compact.scenarios.length && byteLength(compact) > MAX_INLINE_CALCULATION_RESULT_BYTES) {
    compact.scenarios = compact.scenarios.slice(0, Math.floor(compact.scenarios.length / 2));
  }
  if (compact.scenarios.length < result.scenarios.length) {
    compact.warnings = [
      ...compact.warnings,
      `The page shows ${compact.scenarios.length} of ${result.scenarios.length} scenarios; the complete result is preserved for downloads.`,
    ];
  }

  if (byteLength(compact) > MAX_INLINE_CALCULATION_RESULT_BYTES) {
    return CalculationResultSchema.parse({
      url: compact.url,
      currency: compact.currency,
      monthlyTotal: compact.monthlyTotal,
      reportedMonthlyTotal: compact.reportedMonthlyTotal,
      ebsRatePerGbMonth: compact.ebsRatePerGbMonth,
      lineItems: [],
      environments: [],
      scenarios: [],
      assumptions: [],
      warnings: ['This result is too large to display inline; the complete result is preserved for downloads.'],
      validationErrors: compact.validationErrors?.slice(0, 3),
    });
  }

  return CalculationResultSchema.parse(compact);
}

/**
 * S3 key functions for per-scenario durable artifacts.
 *
 * Spec layout:
 *   calculator/{ownerId}/{calculationId}/
 *     manifests/{scenarioId}.json
 *     mcp/{scenarioId}-request.json
 *     mcp/{scenarioId}-response.json
 *     mcp/{scenarioId}-saved-snapshot.json
 *     validation/{scenarioId}.json
 *     results/{scenarioId}.json
 *     exports/cleaned-estimate.xlsx
 *
 * These keys let per-scenario debug artifacts be found, diffed, and audited after the
 * fact without loading the monolithic result blob. The result.json is retained as the
 * authoritative combined result; these are per-scenario supplement.
 */
const scenarioPrefix = (ownerUserId: string, calculationId: string, scenarioId: string) =>
  `users/${ownerUserId}/calculator/${calculationId}`;

export function scenarioResultKey(ownerUserId: string, calculationId: string, scenarioId: string): string {
  return `${scenarioPrefix(ownerUserId, calculationId, scenarioId)}/results/${scenarioId}.json`;
}

export function scenarioMcpResponseKey(ownerUserId: string, calculationId: string, scenarioId: string): string {
  return `${scenarioPrefix(ownerUserId, calculationId, scenarioId)}/mcp/${scenarioId}-response.json`;
}

export function scenarioMcpSnapshotKey(ownerUserId: string, calculationId: string, scenarioId: string): string {
  return `${scenarioPrefix(ownerUserId, calculationId, scenarioId)}/mcp/${scenarioId}-saved-snapshot.json`;
}

export function scenarioValidationKey(ownerUserId: string, calculationId: string, scenarioId: string): string {
  return `${scenarioPrefix(ownerUserId, calculationId, scenarioId)}/validation/${scenarioId}.json`;
}

/** S3 key for the cleaned Excel export — generated only after validated Calculator result exists. */
export function calculationExportKey(ownerUserId: string, calculationId: string): string {
  return `users/${ownerUserId}/calculator/${calculationId}/exports/cleaned-estimate.xlsx`;
}

/** Read the authoritative result, falling back to inline data for legacy estimates. */
export async function loadFullCalculationResult(
  bucketName: string,
  record: CalculationRecord,
): Promise<CalculationResult | null> {
  if (record.result_s3_key) {
    const stored = JSON.parse(await getFileContent(bucketName, record.result_s3_key));
    return CalculationResultSchema.parse(stored);
  }
  if (!record.result) return null;
  return CalculationResultSchema.parse(record.result);
}
