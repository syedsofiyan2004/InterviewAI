import type { CalculationRecord } from '../../../schema/calculator';
import { estimateProgress, formatRange } from '../../shared/progress-eta';
import {
  choiceArg,
  intArg,
  matches,
  textArg,
  toolResultText,
  TOOL_ROW_LIMIT,
  type ReadOnlyTool,
} from '../tools';
import {
  renderInventoryRow,
  renderLineItem,
  renderScenario,
  renderServerRow,
} from './calculator-rows';
import { boundedRows, formatDate, money } from './shared';

/**
 * The read-only tools an estimate conversation can investigate itself with.
 *
 * Why these exist at all. The context block is a fixed summary under a 24,000-character
 * budget, and a real client inventory does not fit in it: 40 of 412 rows are listed, 30 of
 * the priced lines, 30 of the per-server allocations. Everything past those cut-offs was
 * simply unanswerable — the model could see that it had been truncated (the block says so)
 * but had no way to go and look, so the honest answer to "which of the DR boxes are still
 * on-demand" was "I cannot see them". That is the gap these close.
 *
 * Every tool here is bound to ONE record, captured when the tool set is built — which is
 * after `loadCalculation` has checked `owner_user_id`. None of them accepts an argument
 * naming a record, none of them performs a read, and so none of them can be steered onto
 * another estimate or another user's data by anything the model emits. See `ReadOnlyTool`.
 *
 * They read `record.resources` as stored, which on a very large upload is a bounded SAMPLE
 * with the full list in S3 (`resources_s3_key`). The sample is not silently presented as the
 * whole: `inventoryNote` states the shortfall on every slice. Fetching the S3 copy was
 * considered and rejected — it would put a network read inside a turn the user is watching
 * stream, and a few thousand rows cannot be shown through a 6,000-character tool result
 * anyway, so `summarise_inventory` answers the questions a slice cannot far more cheaply.
 */

/** Fewer than the row cap, because each priced line carries a `workings` line of its own. */
const DEFAULT_LINE_ITEM_COUNT = 20;

/** How many groups a summary lists before it says how many it left out. */
const SUMMARY_GROUP_LIMIT = 40;

/** The workbook sections worth exposing, and how many entries of each to default to. */
const WORKBOOK_SECTIONS = ['rate_card', 'facts', 'reported', 'excerpts', 'exclusions', 'conversions', 'bands', 'sheets'] as const;
type WorkbookSection = typeof WORKBOOK_SECTIONS[number];

const INVENTORY_GROUPINGS = ['environment', 'size', 'os', 'purchase_model', 'region', 'scenario', 'service'] as const;
type InventoryGrouping = typeof INVENTORY_GROUPINGS[number];

/**
 * What the stored rows are, when they are not all of them.
 *
 * Returned with every inventory slice rather than only the first, because the model may
 * reach a slice several turns after the caveat and would otherwise treat the sample as the
 * inventory — which is the specific failure `boundedRows` was written to prevent, and it
 * does not stop being a failure just because the truncation happened before the chat.
 */
function inventoryNote(record: CalculationRecord): string {
  const held = record.resources?.length || 0;
  const total = record.resource_count ?? held;
  if (!record.resources_truncated && total <= held) return '';
  return `\nNote: only ${held} of the ${total} parsed rows are stored on this record; the rest were priced `
    + 'but cannot be listed here. Use summarise_inventory for questions about the full set, and say plainly '
    + 'that individual rows beyond this sample cannot be shown.';
}

/** Applies the optional filters every slice tool offers, keeping each row's real index. */
function filterRows(
  record: CalculationRecord,
  args: Record<string, unknown>,
): Array<{ row: CalculationRecord['resources'][number]; index: number }> {
  const environment = textArg(args, 'environment');
  const match = textArg(args, 'match');
  return (record.resources || [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (!environment || matches(row.environment, environment)))
    .filter(({ row }) => (
      !match
      || matches(row.name, match)
      || matches(row.service, match)
      || matches(row.size, match)
      || matches(row.os, match)
      || matches(row.purchase_model, match)
    ));
}

/** "rows 40-79 of 412" — so a slice can never be mistaken for the whole list. */
function sliceHeading(noun: string, start: number, shown: number, total: number, filtered: boolean): string {
  const scope = filtered ? ` (filtered from ${noun})` : '';
  if (!total) return `No ${noun} matched${scope}.`;
  const last = Math.min(total, start + shown) - 1;
  return `${noun} ${start}-${last} of ${total}${scope}:`;
}

function inventorySliceTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'list_inventory_rows',
    spec: {
      toolSpec: {
        name: 'list_inventory_rows',
        description:
          'Read a slice of this estimate\'s parsed inventory rows, with the row index used to address a row in a '
          + 'change proposal. Use this when the context block says rows were not listed, or to check specific machines. '
          + 'Read-only: it looks at this estimate and nothing else.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start: { type: 'number', description: 'First row index to return, 0-based. Defaults to 0.' },
              count: { type: 'number', description: `How many rows, up to ${TOOL_ROW_LIMIT}. Defaults to ${TOOL_ROW_LIMIT}.` },
              environment: { type: 'string', description: 'Optional: only rows whose scope/environment contains this text.' },
              match: { type: 'string', description: 'Optional: only rows whose name, service, size, OS or purchase model contains this text.' },
            },
          },
        },
      },
    },
    run(args) {
      const rows = filterRows(record, args);
      const start = intArg(args, 'start', 0, 0, Math.max(0, rows.length));
      const count = intArg(args, 'count', TOOL_ROW_LIMIT, 1, TOOL_ROW_LIMIT);
      const slice = rows.slice(start, start + count);
      const filtered = rows.length !== (record.resources?.length || 0);
      const body = boundedRows(
        slice,
        ({ row, index }) => renderInventoryRow(row, index),
        TOOL_ROW_LIMIT,
        'inventory rows',
      );
      return toolResultText(
        sliceHeading('inventory rows', start, slice.length, rows.length, filtered) + inventoryNote(record),
        body,
      );
    },
  };
}

function inventorySummaryTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'summarise_inventory',
    spec: {
      toolSpec: {
        name: 'summarise_inventory',
        description:
          'Count and total this estimate\'s inventory rows grouped by one field — environment, size, OS, purchase '
          + 'model, region, scenario or service. Answers "how many" and "how much disk" across the WHOLE inventory, '
          + 'including rows too numerous to list. Read-only.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              group_by: {
                type: 'string',
                enum: [...INVENTORY_GROUPINGS],
                description: 'Which field to group by. Defaults to environment.',
              },
            },
          },
        },
      },
    },
    run(args) {
      const groupBy = choiceArg<InventoryGrouping>(args, 'group_by', INVENTORY_GROUPINGS, 'environment');
      const buckets = new Map<string, { rows: number; machines: number; diskGb: number }>();
      for (const row of record.resources || []) {
        const key = String((row as Record<string, unknown>)[groupBy] ?? 'not stated');
        const bucket = buckets.get(key) || { rows: 0, machines: 0, diskGb: 0 };
        bucket.rows += 1;
        // `quantity` counts machines and defaults to one where a sheet gave no column, so a
        // row without it still counts as a machine rather than as none.
        bucket.machines += Number(row.quantity) || 1;
        bucket.diskGb += (Number(row.disk_gb) || 0) * (Number(row.quantity) || 1);
        buckets.set(key, bucket);
      }
      const groups = [...buckets.entries()].sort((a, b) => b[1].machines - a[1].machines);
      const body = boundedRows(
        groups,
        ([key, bucket]) => `- ${key}: ${bucket.rows} row(s), ${bucket.machines} machine(s), ${Math.round(bucket.diskGb)} GB disk`,
        SUMMARY_GROUP_LIMIT,
        'groups',
      );
      return toolResultText(
        `Inventory grouped by ${groupBy}, over the ${record.resources?.length || 0} rows stored on this record.`
        + inventoryNote(record),
        body,
      );
    },
  };
}

function lineItemTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'list_priced_line_items',
    spec: {
      toolSpec: {
        name: 'list_priced_line_items',
        description:
          'Read a slice of the priced line items with their workings — the arithmetic that produced each figure, '
          + 'rate by quantity. Use this to quote or check a number the context block did not list. Read-only.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start: { type: 'number', description: 'First line item to return, 0-based. Defaults to 0.' },
              count: { type: 'number', description: `How many, up to ${TOOL_ROW_LIMIT}. Defaults to ${DEFAULT_LINE_ITEM_COUNT}.` },
              environment: { type: 'string', description: 'Optional: only lines in environments containing this text.' },
              match: { type: 'string', description: 'Optional: only lines whose service or detail contains this text.' },
            },
          },
        },
      },
    },
    run(args) {
      const result = record.result;
      if (!result) return 'This estimate has not been priced yet, so there are no line items to read.';
      const currency = result.currency || 'USD';
      const environment = textArg(args, 'environment');
      const match = textArg(args, 'match');
      const items = result.lineItems
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !environment || matches(item.environment, environment))
        .filter(({ item }) => !match || matches(item.service, match) || matches(item.detail, match));
      const start = intArg(args, 'start', 0, 0, Math.max(0, items.length));
      const count = intArg(args, 'count', DEFAULT_LINE_ITEM_COUNT, 1, TOOL_ROW_LIMIT);
      const slice = items.slice(start, start + count);
      const body = boundedRows(
        slice,
        ({ item, index }) => renderLineItem(item, index, currency),
        TOOL_ROW_LIMIT,
        'line items',
      );
      return toolResultText(
        sliceHeading('line items', start, slice.length, items.length, items.length !== result.lineItems.length),
        body,
      );
    },
  };
}

function serverAllocationTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'list_server_allocation',
    spec: {
      toolSpec: {
        name: 'list_server_allocation',
        description:
          'Read a slice of the per-server allocation — one row per machine with its instance type, purchase model '
          + 'and its share of the group price, as exported to the Excel workbook. Read-only.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              start: { type: 'number', description: 'First server to return, 0-based. Defaults to 0.' },
              count: { type: 'number', description: `How many, up to ${TOOL_ROW_LIMIT}.` },
              environment: { type: 'string', description: 'Optional: only servers whose scope contains this text.' },
              match: { type: 'string', description: 'Optional: only servers whose name or instance type contains this text.' },
            },
          },
        },
      },
    },
    run(args) {
      const servers = record.result?.servers;
      if (!servers?.length) {
        // Absent for two quite different reasons, and the model must not report the second
        // as the first: an unpriced estimate has no allocation yet, whereas a large one had
        // it omitted deliberately to keep the DynamoDB item under 400KB.
        return record.result
          ? 'This estimate carries no per-server allocation — the inventory was too large to store one, so only '
            + 'group-level line items exist. The totals are unaffected.'
          : 'This estimate has not been priced yet, so there is no per-server allocation.';
      }
      const currency = record.result?.currency || 'USD';
      const environment = textArg(args, 'environment');
      const match = textArg(args, 'match');
      const rows = servers
        .filter(server => !environment || matches(server.environment, environment))
        .filter(server => !match || matches(server.name, match) || matches(server.instance, match));
      const start = intArg(args, 'start', 0, 0, Math.max(0, rows.length));
      const count = intArg(args, 'count', TOOL_ROW_LIMIT, 1, TOOL_ROW_LIMIT);
      const slice = rows.slice(start, start + count);
      const body = boundedRows(slice, server => renderServerRow(server, currency), TOOL_ROW_LIMIT, 'servers');
      return toolResultText(
        sliceHeading('servers', start, slice.length, rows.length, rows.length !== servers.length),
        body,
      );
    },
  };
}

/**
 * Where the run is and how much longer it has — from `shared/progress-eta.ts` and nowhere
 * else.
 *
 * The prose is passed through verbatim, and this tool deliberately hands back no raw
 * millisecond figures for the model to re-phrase. A stage name and a time range are exactly
 * the two things it would otherwise be most willing to invent, and an invented "should be
 * done in about a minute" is the failure that module's docstring is about: it teaches the
 * user the number means nothing, after which they cannot tell a slow run from a hung one.
 *
 * Exposed as a tool as well as sitting in the context block because a long turn outlives its
 * own context. A block built at the start of a turn that then spends ninety seconds in the
 * loop is describing the past, and "is it done yet" asked at the end of that turn has to be
 * answered against the clock now.
 */
function progressTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'pipeline_progress',
    spec: {
      toolSpec: {
        name: 'pipeline_progress',
        description:
          'Read how far through the pricing pipeline this estimate is and how much longer it is expected to take. '
          + 'Use this for "is it still running" and "how long" — and use its wording, never your own estimate of the '
          + 'time. Read-only.',
        inputSchema: { json: { type: 'object', properties: {} } },
      },
    },
    run() {
      const progress = estimateProgress(record, Date.now());
      return toolResultText('Pipeline state, as of now:', [
        `Status: ${record.status}`,
        `Stage: ${progress.stageLabel} (step ${progress.stageNumber} of ${progress.stageCount})`,
        `Say this to the user, in these words: ${progress.prose}`,
        progress.remainingHighMs > 0
          ? `Time left: ${formatRange(progress.remainingLowMs, progress.remainingHighMs)} (confidence: ${progress.confidence})`
          : '',
        progress.stalled ? 'This run looks stalled — nothing has written to it for several minutes.' : '',
        record.progress_message ? `Last message from the pipeline: ${record.progress_message}` : '',
      ].filter(Boolean).join('\n'));
    },
  };
}

/**
 * What the uploaded workbook said, beyond its rows.
 *
 * One tool with a section argument rather than eight tools. The sections are read for the
 * same reason — checking the estimate against what the client's own model assumed — and
 * eight near-identical specs in the tool list would cost more of the model's attention than
 * the whole feature is worth.
 */
function workbookTool(record: CalculationRecord): ReadOnlyTool {
  return {
    name: 'read_workbook_detail',
    spec: {
      toolSpec: {
        name: 'read_workbook_detail',
        description:
          'Read one section of what the uploaded workbook said: rate_card (the rates the CLIENT assumed — never '
          + 'usable as an AWS price), facts, reported (the sheet\'s own monthly figures), excerpts, exclusions '
          + '(rows deliberately not priced, and why), conversions, bands or sheets. Read-only.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: [...WORKBOOK_SECTIONS], description: 'Which section. Defaults to facts.' },
              start: { type: 'number', description: 'First entry to return, 0-based. Defaults to 0.' },
              count: { type: 'number', description: `How many, up to ${TOOL_ROW_LIMIT}.` },
            },
          },
        },
      },
    },
    run(args) {
      const workbook = record.workbook;
      if (!workbook) return 'No workbook was uploaded for this estimate, so there is no workbook detail to read.';
      const section = choiceArg<WorkbookSection>(args, 'section', WORKBOOK_SECTIONS, 'facts');
      const currency = workbook.currency || record.result?.currency || 'USD';

      const rendered: string[] = (() => {
        switch (section) {
          case 'rate_card':
            return (workbook.rate_card || []).map(rate => (
              `- ${rate.item}: ${currency} ${rate.rate}${rate.unit ? ` per ${rate.unit}` : ''} (sheet ${rate.sheet}) — the client's assumed rate, not an AWS price`
            ));
          case 'facts':
            return (workbook.facts || []).map(fact => `- ${fact.label}: ${fact.value} (sheet ${fact.sheet})`);
          case 'reported':
            return (workbook.reported || []).map(row => `- ${row.label}: ${money(row.monthly, currency)}/mo (sheet ${row.sheet})`);
          case 'excerpts':
            return (workbook.excerpts || []).map(excerpt => `- sheet ${excerpt.sheet}: ${excerpt.text}`);
          case 'exclusions':
            return (workbook.exclusions || []).map(row => (
              `- ${row.metric}${row.scenario ? ` (${row.scenario})` : ''}: not priced — ${row.reason}`
            ));
          case 'conversions':
            return (workbook.conversions || []).map(text => `- ${text}`);
          case 'bands':
            return (workbook.bands || []).map(band => (
              `- ${band.label} (key=${band.key}, kind=${band.kind}, sheet ${band.sheet}${typeof band.resource_count === 'number' ? `, ${band.resource_count} rows` : ''})`
            ));
          case 'sheets':
            return (workbook.sheets || []).map(sheet => `- ${sheet.name} (${sheet.rows} rows): ${sheet.detail}`);
        }
      })();

      const start = intArg(args, 'start', 0, 0, Math.max(0, rendered.length));
      const count = intArg(args, 'count', TOOL_ROW_LIMIT, 1, TOOL_ROW_LIMIT);
      const slice = rendered.slice(start, start + count);
      const body = boundedRows(slice, entry => entry, TOOL_ROW_LIMIT, 'entries');
      return toolResultText(
        sliceHeading(`workbook ${section} entries`, start, slice.length, rendered.length, false),
        body,
      );
    },
  };
}

/**
 * Every read-only tool an estimate conversation gets, bound to this record.
 *
 * Built per request, because the binding to an authorised record IS the access control. A
 * module-level tool set taking a record id as an argument would be the same code with the
 * gate removed.
 */
export function buildCalculatorReadTools(record: CalculationRecord): ReadOnlyTool[] {
  return [
    inventorySliceTool(record),
    inventorySummaryTool(record),
    lineItemTool(record),
    serverAllocationTool(record),
    progressTool(record),
    workbookTool(record),
  ];
}

/**
 * The scenarios section of the context block, and the per-scenario links with it.
 *
 * Lives here rather than inline in the builder only so the scenario renderer, the link list
 * and the "may these totals be added" caveat stay together — they are one answer, and a
 * reader who gets the links without the caveat sums a five-year period model into a monthly
 * figure five times too big.
 */
export function scenarioLines(record: CalculationRecord, currency: string): (string | null)[] {
  const scenarios = record.result?.scenarios || [];
  if (!scenarios.length) return [];
  const kinds = new Set(scenarios.map(scenario => scenario.kind).filter(Boolean));
  return [
    boundedRows(scenarios, scenario => renderScenario(scenario, currency), 30, 'scenarios'),
    kinds.has('period')
      ? 'These are period scenarios: they run one after another, so adding their monthly totals gives a multi-year '
        + 'figure and not a monthly one.'
      : null,
    kinds.has('sizing')
      ? 'These are sizing scenarios: the same workload costed more than one way, so only one of them will ever be '
        + 'spent. Do not add them together.'
      : null,
    kinds.has('environment')
      ? 'These are environment scenarios: they run concurrently, so their monthly totals do add up.'
      : null,
  ];
}

/** Elapsed and remaining time for a live run, or the dates for a finished one. */
export function progressLines(record: CalculationRecord, now: number): (string | null)[] {
  const running = record.status === 'PROCESSING';
  if (!running) {
    // A finished estimate is deliberately NOT passed through estimateProgress. That module
    // falls back to `created_at` when the worker never stamped `progress_started_at`, so a
    // run completed last week reports "Finished in about 11000 minutes" — true, useless, and
    // exactly the kind of confident nonsense the rest of this block exists to avoid.
    return [
      record.status === 'FAILED' && record.error_message ? `Why it stopped: ${record.error_message}` : null,
      `Finished on: ${formatDate(record.updated_at)}`,
      record.iterations ? `Model turns the pipeline took: ${record.iterations}` : null,
      record.tool_call_count ? `Pricing tool calls it made: ${record.tool_call_count}` : null,
    ];
  }
  const progress = estimateProgress(record, now);
  return [
    `Stage: ${progress.stageLabel} (step ${progress.stageNumber} of ${progress.stageCount})`,
    record.progress_message ? `Last pipeline message: ${record.progress_message}` : null,
    // Verbatim from progress-eta.ts. The model is told, in the calculator rules, that this
    // sentence and pipeline_progress are the only permitted sources of a stage or a time.
    `Say this if asked how it is going: ${progress.prose}`,
    `This wording is already ${progress.confidence}-confidence and correct as of when this block was built; `
      + 'call pipeline_progress for the current position rather than adjusting it yourself.',
  ];
}
