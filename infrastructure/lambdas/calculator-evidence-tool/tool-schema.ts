/**
 * The `get_workbook_evidence` tool schema advertised to the AgentCore Gateway.
 *
 * Deliberately in its own module with no imports. The CDK construct reads this at synth
 * time to build the Gateway target's inlinePayload, and the handler reads it too, so
 * there is one definition rather than two that drift. Importing it from the handler
 * instead would drag the AWS SDK clients and the shared/aws.js side effects into `cdk
 * synth` for no reason.
 *
 * MIMO owns this schema, and that is the point: the evidence is MIMO's, so describing it
 * here is correct. The Calculator tools are the opposite case — their schemas belong to
 * the Pricing Calculator MCP and are discovered from it, never written down here.
 */
export const GET_WORKBOOK_EVIDENCE_TOOL = {
  name: 'get_workbook_evidence',
  description: [
    'Fetch customer workbook evidence for this calculation from MIMO.',
    'Use this whenever the evidence you hold may be incomplete: you were given an index',
    'rather than full evidence, a sheet is referenced but not present, or a total does not',
    'reconcile with the rows you can see.',
    'Filter by chunkId, sheet, row range, environment or fiscal period.',
    'If the reply says moreAvailable, call again with nextChunkId until it does not.',
    'Rows are never discarded — anything not returned is still retrievable.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      calculationId: { type: 'string', description: 'The calculation id given to you in the task.' },
      chunkId: { type: 'string', description: 'A chunkId from the evidence index, e.g. "0003".' },
      sheet: { type: 'string', description: 'Restrict to one sheet name.' },
      rowsFrom: { type: 'integer', description: 'First workbook row number to return, inclusive.' },
      rowsTo: { type: 'integer', description: 'Last workbook row number to return, inclusive.' },
      environment: { type: 'string', description: 'Restrict to an environment hint, e.g. "Production".' },
      fiscalPeriod: { type: 'string', description: 'Restrict to a fiscal period hint, e.g. "FY27".' },
      costRelevantOnly: { type: 'boolean', description: 'Return only rows that look like billable lines.' },
    },
    required: ['calculationId'],
  },
} as const;
