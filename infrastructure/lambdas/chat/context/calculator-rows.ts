import type { CalculationRecord } from '../../../schema/calculator';
import { money } from './shared';

/**
 * How one row of an estimate is written out for the model — in one place, used by both
 * readers of it.
 *
 * Why this is its own module rather than closures inside the context builder. The context
 * block and the read-only inventory tools describe the SAME rows, and two renderers would
 * describe them two ways: the block printing `row 7, web-01, size=m5.xlarge` while a tool
 * printed whatever its author happened to write. A model reading both then has to decide
 * whether they are the same machine.
 *
 * The row index is a parameter, and it is ABSOLUTE. A tool returns a slice, and a slice
 * rendered with its own 0-based offset hands the model row numbers that address different
 * machines — the one mistake here that produces a wrong estimate silently instead of an
 * error, because `propose_estimate_change` addresses a machine by that index and nothing
 * downstream can tell a mis-numbered row from an intended one.
 */

type PricedResult = NonNullable<CalculationRecord['result']>;

export type InventoryRow = CalculationRecord['resources'][number];
export type PricedLineItem = PricedResult['lineItems'][number];
export type PricedServer = NonNullable<PricedResult['servers']>[number];
export type PricedScenario = PricedResult['scenarios'][number];

export function renderInventoryRow(row: InventoryRow, index: number): string {
  const bits = [
    `row ${index}`,
    row.name || row.service || 'unnamed',
    row.environment ? `scope=${row.environment}` : '',
    row.scenario ? `scenario=${row.scenario}` : '',
    row.size ? `size=${row.size}` : '',
    row.quantity ? `qty=${row.quantity}` : '',
    row.os ? `os=${row.os}` : '',
    row.vcpu ? `vcpu=${row.vcpu}` : '',
    row.ram_gb ? `ram=${row.ram_gb}GB` : '',
    row.disk_gb ? `disk=${row.disk_gb}GB` : '',
    row.purchase_model ? `pricing=${row.purchase_model}` : '',
    row.hoursPerMonth ? `${row.hoursPerMonth}h/mo` : '',
    row.region ? `region=${row.region}` : '',
    // A usage driver is not a machine, and a row carrying one priced as though it were is
    // the failure lambdas/shared/unit-contract.ts exists to prevent. Printed so the model
    // can see which rows are metered rather than sized.
    typeof row.usage_amount === 'number' ? `usage=${row.usage_amount}${row.usage_unit ? ` ${row.usage_unit}` : ''}` : '',
  ].filter(Boolean);
  return `- ${bits.join(', ')}`;
}

/**
 * `workings` is printed in full and on its own line.
 *
 * It is the difference between the chat being able to say "that is 730 hours at $0.096"
 * and having to say "the pipeline produced $70.08" — and the second answer is the one a
 * client conversation cannot use.
 */
export function renderLineItem(item: PricedLineItem, index: number, currency: string): string {
  const parts = [`${index + 1}. ${item.service}`];
  if (item.detail) parts.push(item.detail);
  parts.push(`${money(item.monthly, currency)}/mo`);
  if (item.environment) parts.push(`env=${item.environment}`);
  const head = parts.join(' | ');
  return item.workings ? `${head}\n   workings: ${item.workings}` : head;
}

export function renderServerRow(server: PricedServer, currency: string): string {
  return [
    `- ${server.name}`,
    server.instance ? `instance=${server.instance}` : '',
    server.environment ? `scope=${server.environment}` : '',
    server.os ? `os=${server.os}` : '',
    server.purchaseModel ? `pricing=${server.purchaseModel}` : '',
    `ec2=${money(server.computeMonthly, currency)}/mo`,
    `ebs=${money(server.storageMonthly, currency)}/mo`,
  ].filter(Boolean).join(', ');
}

/**
 * One priced scenario, with its own link.
 *
 * The link is on the same line as the total on purpose. A five-year banded model produces
 * one link per year, and a reader budgeting for FY27-28 needs the pair together — a list
 * of totals followed by a separate list of URLs is not something a person can match up
 * without counting, and neither is it something a model can.
 *
 * `kind` is printed because it decides whether the totals may be added at all: `sizing`
 * scenarios are one workload costed twice, `period` scenarios run in sequence, and only
 * `environment` scenarios genuinely sum. See CalculationScenarioSchema.
 */
export function renderScenario(scenario: PricedScenario, currency: string): string {
  const bits = [
    `- ${scenario.label} (key=${scenario.key})`,
    scenario.kind ? `kind=${scenario.kind}` : '',
    `${money(scenario.monthly, currency)}/mo`,
    scenario.url ? `link: ${scenario.url}` : 'no link was exported for this scenario',
  ].filter(Boolean);
  const head = bits.join(' | ');
  return scenario.detail ? `${head}\n   ${scenario.detail}` : head;
}
