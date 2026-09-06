/**
 * Neutral workbook evidence passed to the AgentCore calculator agent.
 *
 * This is NOT a Calculator configuration object.
 * It contains only what the workbook said — sheet names, row numbers,
 * column headers and raw values — plus the user's plain-English instructions.
 *
 * Claude and the MCP tools decide what that means for the Calculator.
 * No Calculator field IDs, service keys, or adapter logic may appear here.
 */

export interface WorkbookEvidenceRow {
  rowNumber: number;
  /** Column header → cell value, as the workbook stated them. */
  values: Record<string, unknown>;
  /** A1-style cell address for each column header (optional, for audit). */
  sourceCells?: Record<string, string>;
}

export interface WorkbookEvidenceSheet {
  name: string;
  rows: WorkbookEvidenceRow[];
}

export interface WorkbookEvidence {
  fileName: string;
  /** SHA-256 of the original file bytes, for deduplication and audit. */
  fileHash: string;
  sheets: WorkbookEvidenceSheet[];
  /** Free-text instructions the user supplied alongside the file. */
  userInstructions?: string[];
}

/**
 * The payload MIMO sends to the AgentCore Harness (InvokeInlineAgent).
 *
 * scenarioLabel   – e.g. "FY 26-27 On-Demand", "Dev environment"
 * workbookEvidence – lossless but compact sheet/row/value representation
 * userInstructions – any clarifications or constraints the user stated
 * calculationId    – the MIMO calculation record this belongs to (for tracing)
 */
export interface AgentCalculatorInput {
  calculationId: string;
  scenarioLabel: string;
  workbookEvidence: WorkbookEvidence;
  userInstructions?: string[];
}

/**
 * The result the AgentCore agent returns to MIMO.
 *
 * The `status` field drives MIMO's calculation status machine.
 * COMPLETED requires a real calculator.aws URL.
 */
export type AgentCalculatorResult =
  | {
      status: 'COMPLETED';
      estimateId: string;
      calculatorUrl: string;
      monthly: number | null;
      upfront: number | null;
      total12Months: number | null;
      assumptions: string[];
      warnings: string[];
      servicesConfigured: string[];
      mcpToolsUsed: string[];
    }
  | {
      status: 'NEEDS_INPUT';
      questions: Array<{
        field: string;
        prompt: string;
        context?: string;
      }>;
    }
  | {
      status: 'FAILED';
      errorCategory: 'MCP_ERROR' | 'AGENT_TIMEOUT' | 'SCHEMA_ERROR' | 'UNKNOWN';
      message: string;
    };
