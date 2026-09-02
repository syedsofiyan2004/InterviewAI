import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient } from '../../shared/aws';
import type { CalculationRecord } from '../../../schema/calculator';
import { buildCalculatorReadTools, progressLines, scenarioLines } from './calculator-tools';
import { renderInventoryRow, renderLineItem, renderServerRow } from './calculator-rows';
import {
  boundedRows,
  clampContext,
  formatDate,
  joinSections,
  line,
  money,
  section,
  type EntityContext,
  type EntityContextResult,
} from './shared';

const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;

/**
 * Load an estimate, enforcing ownership.
 *
 * The gate is a copy of `loadOwned` in api-handler/calculator-routes.ts rather than an
 * import: that module reads an APIGatewayProxyEvent for its claims, and this Lambda has
 * no such event — its identity comes from a token it verified itself. The rule is
 * identical and deliberately so: an estimate belonging to somebody else is refused here,
 * with no admin fallback.
 *
 * What is *not* identical any more is the wording. This used to return "not found" for a
 * stranger's estimate so it could not be used to probe which ids exist; it now reports
 * `not_owner`, which discloses nothing the REST layer does not — see the comment on
 * `EntityContextResult` in shared.ts, and the failure branch in chat/index.ts that turns
 * these reasons into status codes.
 *
 * There is no soft-delete case: a deleted estimate is deleted outright, so a missing item
 * is the only way it can be gone.
 */
export async function loadCalculation(entityId: string, userId: string): Promise<EntityContextResult> {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: entityId },
  }));
  const item = result.Item as CalculationRecord | undefined;
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.owner_user_id !== userId) return { ok: false, reason: 'not_owner' };
  // No `no_result` case either: an estimate that has not been priced yet is still worth
  // talking about — the inventory and the request are already there — and the builder
  // below says "not priced yet" where the totals would be.
  return { ok: true, entity: buildCalculatorContext(item) };
}

/**
 * What the chat knows about an estimate.
 *
 * Ordered by how often it is asked about: the totals first, then the priced lines with
 * their arithmetic, then the inventory. The `workings` string on each line is included
 * in full — it is the difference between the chat being able to say "that is 730 hours
 * at $0.096" and it having to say "the model produced $70.08".
 *
 * What is deliberately NOT here, and why, since the 24,000-character budget is what decides
 * it. Everything below is reachable through a read-only tool instead, which is strictly
 * better than a block entry: it costs nothing on the turns nobody asks about it.
 *
 *  - The workbook's rate card, facts, excerpts and exclusions. A real client model carries
 *    tens of assumed rates and pages of prose; the block states that a workbook exists, what
 *    it named as the region and what it thought the total was, and `read_workbook_detail`
 *    fetches the rest. Whole excerpts here would routinely be the largest thing in the block.
 *  - Inventory rows past 40, priced lines past 30, servers past 30. Each cut-off says how
 *    many it left out — see `boundedRows` — and `list_inventory_rows`,
 *    `list_priced_line_items` and `list_server_allocation` reach the rest.
 *  - `resources_s3_key`, `input_s3_key` and the owner id. Storage plumbing, and the reason
 *    these blocks are hand-built rather than serialised from the record.
 *  - `progress_history` in full. The trail is up to 80 entries and the only questions asked
 *    of it — where is it, how long left, has it stalled — are answered by the one sentence
 *    `progress-eta.ts` derives from it.
 *
 * `now` is a parameter so the run's remaining-time prose is testable, and so the block is a
 * function of the record plus an instant rather than of the wall clock.
 */
export function buildCalculatorContext(record: CalculationRecord, now = Date.now()): EntityContext {
  const result = record.result;
  const currency = result?.currency || 'USD';

  const overview = section('Estimate', [
    line('Name', record.name),
    line('Status', record.status),
    line('Region', record.region || 'not specified'),
    line('Created', formatDate(record.created_at)),
    line('Last updated', formatDate(record.updated_at)),
    line('Monthly total', result ? money(result.monthlyTotal, currency) : 'not priced yet'),
    line('Annual total', typeof result?.monthlyTotal === 'number'
      ? money(result.monthlyTotal * 12, currency)
      : null),
    line("Client sheet's own monthly total", typeof result?.reportedMonthlyTotal === 'number'
      ? money(result.reportedMonthlyTotal, currency)
      : null),
    line('Saved calculator.aws link', result?.url || null),
    line('Failure', record.error_message || null),
  ]);

  /**
   * Where the run is, or when it finished.
   *
   * Absent before this: the record has carried `progress_stage` and a stage message all
   * along, and the view page polls them, but the chat could not answer "is it still running"
   * at all — the single most likely question to be asked of an estimate that is still going,
   * and the one the user opens the chat during rather than after. Every word of the stage and
   * the time comes from `shared/progress-eta.ts`; see `progressLines`.
   */
  const progress = section('Where this run is', progressLines(record, now));

  /**
   * Revision lineage.
   *
   * A revision is a new row rather than an edit, so an estimate reached from the chat's own
   * Apply button is a DIFFERENT record from the one the conversation started against. Without
   * this the model cannot say what was changed or what it was changed from, and a user asking
   * "what did we alter last time" got "I cannot see that" about a fact sitting on the record.
   */
  const lineage = section('Revision history', [
    line('This estimate revises', record.revision_of || null),
    line('Revision number', record.revision_number ?? null),
    line('The change that produced it', record.revision_instruction || null),
  ]);

  /**
   * The priced scenarios, each with its own link.
   *
   * The whole reason this section had to exist: `result.scenarios` was never included, so a
   * multi-scenario estimate — a lift-and-shift beside a right-sized target, or a five-year
   * banded capacity model — appeared to the chat as one number and one link. It could
   * neither discuss what was already priced nor extend it, which makes the matrix work this
   * upgrade is for impossible to even talk about.
   */
  const scenarios = section('Priced scenarios (each has its own link)', scenarioLines(record, currency));

  const request = section('What was asked for', [
    record.prompt ? record.prompt.slice(0, 2000) : null,
    line('Uploaded resource list', record.input_file_name || null),
    line('Rows parsed from that list', record.resource_count ?? (record.resources?.length || null)),
    line('Runtime hours', (record.environment_hours || [])
      .map(hours => `${hours.name} ${hours.hoursPerDay}h/day`)
      .join(', ') || null),
  ]);

  const environments = section('Cost by environment', [
    (result?.environments || []).length
      ? boundedRows(
        result!.environments,
        env => `- ${env.name} (${env.hoursPerDay}h/day): ${money(env.monthly, currency)} per month`,
        20,
        'environments',
      )
      : null,
  ]);

  // The three long listings below share their renderers with the read-only slice tools —
  // see calculator-rows.ts. A row must read identically whether the model met it in this
  // block or fetched it later, or it cannot tell that the two are the same machine.
  const lineItems = section('Priced line items (rate x quantity, as calculated)', [
    (result?.lineItems || []).length
      ? `${boundedRows(
        result!.lineItems,
        (item, index) => renderLineItem(item, index, currency),
        30,
        'line items',
      )}\nUse list_priced_line_items to read any line not shown here.`
      : null,
  ]);

  /**
   * The inventory rows, indexed.
   *
   * The index is printed because it is the handle `propose_estimate_change` uses to
   * name a row — without it the model can describe a machine but cannot address it.
   */
  const resources = section('Inventory rows (row index is how you address a row in a change)', [
    (record.resources || []).length
      ? `${boundedRows(
        record.resources,
        renderInventoryRow,
        40,
        'inventory rows',
      )}\nUse list_inventory_rows for any row not shown, or summarise_inventory to count across all of them.`
      : null,
    record.resources_truncated
      ? `Note: this page holds a sample. The full list of ${record.resource_count} rows was priced but is not all shown here.`
      : null,
  ]);

  const servers = section('Per-server allocation (as exported to the Excel workbook)', [
    (result?.servers || []).length
      ? `${boundedRows(
        result!.servers!,
        server => renderServerRow(server, currency),
        30,
        'servers',
      )}\nUse list_server_allocation to read any server not shown here.`
      : null,
  ]);

  /**
   * What the uploaded workbook governed, as a summary with a pointer.
   *
   * Only the fields that change how the whole estimate should be read — the region it named,
   * the currency and FX rate it assumed, what it thought it totalled, and the COUNT of the
   * things a reader may want to interrogate. The rate card, the facts, the excerpts and the
   * exclusions are fetched by `read_workbook_detail` rather than pasted, because a real
   * client model carries enough of all four to crowd the priced lines out of the block.
   *
   * The exclusions count is stated even though the list is not: a row the parser refused to
   * price is the one omission that must never be silent, and a count is enough for the model
   * to know there is something to go and read.
   */
  const workbook = section('The uploaded workbook (use read_workbook_detail for any section)', [
    line('File', record.workbook?.file_name || record.input_file_name || null),
    line('Region it named', record.workbook?.primary_region || null),
    line('DR region it named', record.workbook?.dr_region || null),
    line('Currency it used', record.workbook?.currency || null),
    line('FX rate it assumed', record.workbook?.fx_rate ?? null),
    line('Monthly total it reported', typeof record.workbook?.reported_monthly_total === 'number'
      ? money(record.workbook.reported_monthly_total, record.workbook.currency || currency)
      : null),
    line('Machines it counted', record.workbook?.server_count || null),
    line('Total disk it listed', record.workbook?.total_disk_gb ? `${record.workbook.total_disk_gb} GB` : null),
    line('Sheets read', record.workbook?.sheets?.length || null),
    line('Rates on its rate card', record.workbook?.rate_card?.length || null),
    line('Labelled facts found', record.workbook?.facts?.length || null),
    line('Scenario bands detected', record.workbook?.bands?.length || null),
    line('Rows it excluded from pricing', record.workbook?.exclusions?.length || null),
    line('Unit conversions applied', record.workbook?.conversions?.length || null),
  ]);

  const notes = section('Assumptions and warnings', [
    (result?.assumptions || []).length
      ? `Assumptions:\n${result!.assumptions.map(a => `- ${a}`).join('\n')}`
      : null,
    (result?.warnings || []).length
      ? `Warnings:\n${result!.warnings.map(w => `- ${w}`).join('\n')}`
      : null,
    (record.input_warnings || []).length
      ? `Input warnings:\n${record.input_warnings.map(w => `- ${w}`).join('\n')}`
      : null,
    typeof result?.ebsRatePerGbMonth === 'number'
      ? line('gp3 storage rate used', `${currency} ${result.ebsRatePerGbMonth}/GB-month`)
      : null,
  ]);

  return {
    title: record.name,
    editable: true,
    readTools: buildCalculatorReadTools(record),
    // Order is the clamp's priority list: `clampContext` trims the tail, so the short,
    // high-value sections come first and the workbook summary comes last — it is the only
    // section here that a tool can fetch back in full if it does get cut.
    context: clampContext(joinSections([
      overview,
      progress,
      lineage,
      scenarios,
      request,
      environments,
      lineItems,
      resources,
      servers,
      notes,
      workbook,
    ])),
  };
}
