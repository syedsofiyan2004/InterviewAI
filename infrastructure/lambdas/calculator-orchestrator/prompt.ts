import type {
  CalculationRecord,
  CalculationResource,
  EnvironmentHours,
  WorkbookInsights,
} from '../../schema/calculator';
import { materializeContextualResourceSpecs } from '../shared/estimate-planning';

/**
 * Assembles what the model is asked to price.
 *
 * Two things drive the shape of this file, and both come from real uploads rather
 * than from taste:
 *
 * 1. GROUPING, not enumeration. A migration model lists every machine by name --
 *    the worked example has 110 rows, and a few thousand is normal for a data-centre
 *    exit. Sending them verbatim spends the whole context on repetition (dozens of
 *    identical m6a.xlarge/Windows/12x5 lines) and makes the model price the same
 *    configuration dozens of times, which is slow, expensive, and inconsistent
 *    between rows it should have priced identically. So identical machines are folded
 *    into one line carrying a count, and the count is what gets multiplied.
 *
 * 2. EVERYTHING THE SHEET SAID, not just its table. A client model states the things
 *    that govern the whole estimate exactly once, in prose or a label/value block:
 *    the target region, the licensing position, the schedule, the FX rate, the rates
 *    it assumed. Dropping them prices the right machines under the wrong assumptions
 *    and reports no error, which is the worst failure mode this feature has.
 *
 * The client's own rates and totals are included but fenced off in wording: they exist
 * so the report can show a variance against live AWS prices, and a model built months
 * ago is priced at rates that have since moved. Presenting its arithmetic back as the
 * answer would hide exactly the discrepancy the estimate exists to find.
 */

/**
 * Ceilings, set to match the analyser's own (MAX_FACTS/MAX_RATES/... in
 * api-handler/calculator-workbook.ts) so that in practice nothing the analyser
 * decided to keep is dropped again here.
 *
 * They are enforced anyway rather than trusted, because `record.workbook` arrives off
 * a stored DynamoDB item that some earlier version of the analyser wrote, and because
 * the announcements below are the difference between a bounded prompt and a silently
 * partial estimate. Every one of them says so in the prompt when it bites.
 *
 * The real workbook carries 63 facts and 45 rates, and a first cut of this file capped
 * facts at 40 -- which quietly dropped "a dedicated Transit Gateway cross-region
 * attachment for DR replication", "AWS Backup retained as a distinct line item" and the
 * domain-controller sizing. All three cost money. Hence the ceilings sit where the
 * analyser's do, and per-item character limits do the bounding instead.
 */
const MAX_GROUP_LINES = 120;
const MAX_FREE_TEXT_ROWS = 60;
const MAX_FACT_LINES = 80;
const MAX_RATE_LINES = 150;
const MAX_REPORTED_LINES = 60;
const MAX_EXCERPTS = 16;
/** Per-item, not per-section: one enormous cell must not crowd out forty small ones. */
const FACT_CHARS = 400;
const EXCERPT_CHARS = 1_000;

/** A billing month, matching HOURS_PER_MONTH in tool-loop.ts and the analyser. */
const HOURS_PER_MONTH = 730;

/** One line of the scenario table: every machine on it is configured identically. */
export interface ResourceGroup {
  environment?: string;
  service: string;
  size?: string;
  os?: string;
  vcpu?: number;
  ramGb?: number;
  purchaseModel?: string;
  region?: string;
  hoursPerDay: number;
  hoursPerMonth?: number;
  /** Machines in this group, honouring a quantity column. */
  count: number;
  /** Sheet rows folded into it, which is not the same number. */
  rows: number;
  /** Summed across the group -- GB-month is linear, so a total prices exactly. */
  diskGb: number;
  /** A few machine names, so a reader can find the group in their own sheet. */
  names: string[];
  /**
   * Indices, into the array this group was folded from, of every row inside it.
   *
   * Kept because `names` is capped at three and a group is otherwise a dead end: the
   * TCO workbook needs one row per server, and that is only derivable if a priced group
   * can still point back at the machines it stands for. Indices rather than copies, so
   * a group stays small on a stored item.
   */
  members: number[];
  /** What the sheet itself said this group costs per month, summed. */
  reportedMonthly: number;
  /**
   * The dimensions this group is billed on, each with its unit declared, summed across
   * the rows folded into it.
   *
   * Present only on rows the canonical normaliser has been through. Summing is exact
   * because every canonical unit is per-month and linear -- two rows of 40 GB-hours are
   * 80 GB-hours -- and the amounts arrive already scaled for their own row's count, so
   * they must NOT be multiplied by `count` again the way `diskGb` is.
   *
   * This is what lets a usage-driven resource be priced at all. Before it, a group was
   * only ever machines and hours, so a Fargate task or an S3 bucket reached the pricer as
   * a count with no dimension and got hours assumed for it.
   */
  quantities?: Array<{ unit: string; amount: number; basis: string; conversions: string[] }>;
  /** Canonical evidence retained for service adapters that must distinguish billing variants. */
  details?: string[];
}

/** How many machines one row stands for. A quantity column is common and load-bearing. */
export function countOf(resource: CalculationResource): number {
  const parsed = Number(String(resource.quantity ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(10_000, Math.round(parsed));
}

const trimmed = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

/**
 * Folds one row's declared quantities into the group it joined.
 *
 * Kept out of the two branches above rather than inlined twice, because the first row of a
 * group and its tenth have to be treated identically: an accumulator that ran only on the
 * merge path would silently drop whichever row happened to create the group, and a group of
 * one -- the common case for a managed service -- would end up with no dimensions at all
 * and price as nothing.
 *
 * Amounts are added per unit and billing basis. Two different meters often share a unit
 * (S3 PUT and GET requests, QuickSight authors and readers), so collapsing by unit alone
 * changes the service configuration while retaining a plausible-looking total. `basis` and
 * `conversions` are taken from the first row that
 * contributed the same meter and not re-stated per row: they describe what the dimension IS
 * ("task vCPU", "divided the per-year figure by 12"), which is a property of the group's
 * shape rather than of one sheet row, and concatenating a hundred identical sentences would
 * make the report's workings line unreadable.
 */
function addQuantities(group: ResourceGroup, resource: CalculationResource): void {
  if (!resource.quantities?.length) return;
  const quantities = group.quantities ?? (group.quantities = []);
  for (const quantity of resource.quantities) {
    if (!Number.isFinite(quantity.amount)) continue;
    const billingBasis = String(quantity.basis || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const existing = quantities.find((entry) => entry.unit === quantity.unit
      && String(entry.basis || '').trim().toLowerCase().replace(/\s+/g, ' ') === billingBasis);
    if (existing) existing.amount += quantity.amount;
    else {
      quantities.push({
        unit: quantity.unit,
        amount: quantity.amount,
        basis: quantity.basis,
        conversions: [...(quantity.conversions ?? [])],
      });
    }
  }
}

/**
 * Folds rows into groups for one sizing.
 *
 * `sizing` picks which of the row's two targets to group on, which is the whole
 * mechanism behind the two scenarios: the same rows, grouped twice, once by the
 * lift-and-shift target and once by the right-sizing recommendation.
 */
export function groupResources(
  resources: CalculationResource[],
  hoursFor: Map<string, number>,
  sizing: 'baseline' | 'rightsized',
): ResourceGroup[] {
  const groups = new Map<string, ResourceGroup>();
  const contextualResources = materializeContextualResourceSpecs(resources);

  for (const [index, resource] of contextualResources.entries()) {
    const recommended = sizing === 'rightsized' ? trimmed(resource.right_sized_size) : undefined;
    const size = recommended ?? trimmed(resource.size);

    // Where a row was right-sized, its baseline vCPU/RAM describe the machine it is
    // moving AWAY from. Printing those beside the recommended instance would contradict
    // it -- "r6a.large, 16 vCPU / 128 GB" -- and invite the model to override the size
    // it was given. So the spec is inherited only when the sizing did not change; a
    // recommendation with no stated spec shows the instance type alone, which is
    // authoritative on its own.
    const inheritSpec = !recommended || recommended === trimmed(resource.size);
    const vcpu = sizing === 'rightsized'
      ? resource.right_sized_vcpu ?? (inheritSpec ? resource.vcpu : undefined)
      : resource.vcpu;
    const ramGb = sizing === 'rightsized'
      ? resource.right_sized_ram_gb ?? (inheritSpec ? resource.ram_gb : undefined)
      : resource.ram_gb;

    const service = trimmed(resource.service) ?? 'Amazon EC2';
    const environment = trimmed(resource.environment);
    const hoursPerDay = resource.hoursPerDay
      ?? hoursFor.get((environment ?? '').toLowerCase())
      ?? 24;

    // Disk is summed rather than keyed on: two machines of the same size with
    // different data volumes are one compute line, and GB-month prices linearly so
    // the total is exact. Specs ARE keyed on, because a row with no instance type
    // needs its vCPU/RAM to be sized at all -- and where a size is present they are
    // determined by it, so keying on them cannot fragment the group.
    // A SageMaker row names a deployable model pool. Different pools can carry different
    // instance counts, while the Calculator real-time template only represents one uniform
    // instances-per-endpoint value. Preserve that semantic identity in the grouping key so
    // unequal pools cannot collapse into a fractional endpoint shape.
    const semanticResourceIdentity = /sagemaker|custom model hosting/i.test(service)
      ? trimmed(resource.name) ?? trimmed(resource.metric) ?? ''
      : /\bfargate\b/i.test(service)
        ? trimmed(resource.metric) ?? trimmed(resource.name) ?? ''
        : '';
    const key = [
      environment ?? '', service, size ?? '', trimmed(resource.os) ?? '',
      vcpu ?? '', ramGb ?? '', trimmed(resource.purchase_model) ?? '',
      trimmed(resource.region) ?? '', resource.hoursPerMonth ?? '', hoursPerDay,
      semanticResourceIdentity,
    ].join('|');

    // A metric-only sibling may inherit an instance class so it can join the owning
    // service group, but that must not turn an I/O or storage row into another node.
    // Explicit quantity still counts (for example a DR secondary-node row).
    const inheritedShape = !resources[index]?.size && Boolean(resource.size);
    const count = inheritedShape && !resource.quantity ? 0 : countOf(resource);
    const fargate = /\bfargate\b/i.test(service);
    const hours = resource.hoursPerMonth ?? (hoursPerDay / 24) * HOURS_PER_MONTH;
    const syntheticQuantities: NonNullable<CalculationResource['quantities']> = [];
    if (fargate && resource.quantity
      && !resource.quantities?.some((entry) => entry.unit === 'vCPU-hours/month')
      && vcpu !== undefined) syntheticQuantities.push({
      unit: 'vCPU-hours/month', amount: count * hours * vcpu, basis: 'task vCPU',
      conversions: [`${count} task(s) x ${hours} runtime hours x ${vcpu} vCPU`],
    });
    if (fargate && resource.quantity
      && !resource.quantities?.some((entry) => entry.unit === 'GB-hours/month')
      && ramGb !== undefined) syntheticQuantities.push({
      unit: 'GB-hours/month', amount: count * hours * ramGb, basis: 'task memory',
      conversions: [`${count} task(s) x ${hours} runtime hours x ${ramGb} GB memory`],
    });
    const meteredResource = syntheticQuantities.length
      ? { ...resource, quantities: [...(resource.quantities || []), ...syntheticQuantities] }
      : resource;
    const existing = groups.get(key);
    if (existing) {
      existing.count += count;
      existing.rows += 1;
      existing.diskGb += (resource.disk_gb ?? 0) * count;
      existing.reportedMonthly += resource.reported_monthly ?? 0;
      if (existing.names.length < 3 && resource.name) existing.names.push(resource.name);
      existing.members.push(Number(resource.plan_resource_id ?? index));
      const detail = [resource.metric, resource.notes, resource.raw, ...(resource.attributes || []).map((entry) => `${entry.label}: ${entry.value}`)]
        .filter(Boolean).join(' | ');
      if (detail && (existing.details?.length || 0) < 50) (existing.details ??= []).push(detail);
      addQuantities(existing, meteredResource);
      continue;
    }

    groups.set(key, {
      environment,
      service,
      size,
      os: trimmed(resource.os),
      vcpu,
      ramGb,
      purchaseModel: trimmed(resource.purchase_model),
      region: trimmed(resource.region),
      hoursPerDay,
      hoursPerMonth: resource.hoursPerMonth,
      count,
      rows: 1,
      diskGb: (resource.disk_gb ?? 0) * count,
      names: resource.name ? [resource.name] : [],
      members: [Number(resource.plan_resource_id ?? index)],
      reportedMonthly: resource.reported_monthly ?? 0,
      details: [[resource.metric, resource.notes, resource.raw, ...(resource.attributes || []).map((entry) => `${entry.label}: ${entry.value}`)]
        .filter(Boolean).join(' | ')].filter(Boolean),
    });
    addQuantities(groups.get(key)!, meteredResource);
  }

  // Biggest groups first, so a truncation cap drops the least money.
  return [...groups.values()].sort((a, b) => b.count - a.count || (b.diskGb - a.diskGb));
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Shortened with a visible marker, so a reader can tell a trim from a short cell. */
const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}...` : text;

export function renderGroup(group: ResourceGroup, index: number): string {
  const spec = group.vcpu !== undefined || group.ramGb !== undefined
    ? `${group.vcpu ?? '?'} vCPU / ${group.ramGb ?? '?'} GB RAM`
    : '';
  const schedule = group.hoursPerMonth !== undefined
    ? `${round(group.hoursPerMonth)} hrs/month`
    : `${group.hoursPerDay} hrs/day`;

  const fields = [
    `${group.count} x ${group.size || spec || 'unspecified size'}`,
    group.service,
    group.size ? spec : '',
    group.os,
    group.purchaseModel,
    schedule,
    group.environment ? `env=${group.environment}` : '',
    group.region ? `region=${group.region}` : '',
    group.diskGb > 0 ? `disk=${round(group.diskGb)} GB total` : '',
    group.names.length ? `e.g. ${group.names.join(', ')}` : '',
    group.reportedMonthly > 0 ? `client-modelled ${round(group.reportedMonthly)}/mo` : '',
  ].filter(Boolean);

  return `${index + 1}. ${fields.join(' | ')}`;
}

/** Everything the workbook said that is not a resource row. */
function renderWorkbook(insights: WorkbookInsights, parts: string[]): void {
  parts.push('', `UPLOADED WORKBOOK${insights.file_name ? `: ${insights.file_name}` : ''}`);

  if (insights.sheets.length) {
    parts.push(`Sheets read: ${insights.sheets.map((sheet) => `${sheet.name} (${sheet.detail})`).join('; ')}`);
  }
  if (insights.primary_region) parts.push(`Target region stated in the workbook: ${insights.primary_region}`);
  if (insights.dr_region) parts.push(`DR region stated in the workbook: ${insights.dr_region}`);
  if (insights.currency) {
    parts.push(insights.fx_rate
      ? `The workbook reports money in ${insights.currency} at an assumed rate of ${insights.fx_rate}.`
      : `The workbook reports money in ${insights.currency}.`);
  }
  if (insights.server_count) {
    parts.push(`Machines listed: ${insights.server_count}${insights.dr_eligible_count ? ` (${insights.dr_eligible_count} marked DR-eligible)` : ''}`);
  }
  if (insights.total_disk_gb) parts.push(`Total attached storage across the inventory: ${round(insights.total_disk_gb)} GB`);

  if (insights.facts.length) {
    parts.push(
      '',
      'What the workbook states about itself. These are the client\'s own assumptions and constraints -- honour them unless a tool result contradicts one, and say so in assumptions when you do:',
      ...insights.facts.slice(0, MAX_FACT_LINES).map((fact) => `- [${fact.sheet}] ${fact.label}: ${clip(fact.value, FACT_CHARS)}`),
    );
    if (insights.facts.length > MAX_FACT_LINES) {
      parts.push(`(${insights.facts.length - MAX_FACT_LINES} further statement(s) not shown.)`);
    }
  }

  if (insights.rate_card.length) {
    parts.push(
      '',
      'Rates the CLIENT assumed. For COMPARISON ONLY -- never price anything from these. Every figure you report must come from get_aws_price, because a model built months ago is priced at rates that have since moved, and the variance is the point:',
      ...insights.rate_card.slice(0, MAX_RATE_LINES).map((rate) => `- [${rate.sheet}] ${rate.item}${rate.unit ? ` (${rate.unit})` : ''}: ${rate.rate}`),
    );
    if (insights.rate_card.length > MAX_RATE_LINES) {
      parts.push(`(${insights.rate_card.length - MAX_RATE_LINES} further rate(s) not shown.)`);
    }
  }

  if (insights.reported.length) {
    parts.push(
      '',
      'Monthly figures the workbook calculated for itself, per sheet. Do NOT add these together: they are separate models of separate things, and one sheet is often the CURRENT platform\'s spend rather than the AWS target:',
      ...insights.reported.slice(0, MAX_REPORTED_LINES).map((entry) => `- [${entry.sheet}] ${entry.label}: ${round(entry.monthly)}`),
    );
    if (insights.reported.length > MAX_REPORTED_LINES) {
      parts.push(`(${insights.reported.length - MAX_REPORTED_LINES} further figure(s) not shown.)`);
    }
  }

  if (insights.reported_monthly_total) {
    parts.push(
      '',
      `The workbook's own inventory rows foot to ${round(insights.reported_monthly_total)} per month. Report this verbatim as reportedMonthlyTotal so the two can be compared; it is what the client believed before we checked, not an answer.`,
    );
  }

  if (insights.excerpts.length) {
    parts.push(
      '',
      'Parts of the workbook that were not structured enough to read as a table, passed through verbatim in case they carry something the columns did not:',
      ...insights.excerpts.slice(0, MAX_EXCERPTS).map((excerpt) => `--- ${excerpt.sheet} ---\n${clip(excerpt.text, EXCERPT_CHARS)}`),
    );
    if (insights.excerpts.length > MAX_EXCERPTS) {
      parts.push(`(${insights.excerpts.length - MAX_EXCERPTS} further block(s) not shown.)`);
    }
  }
}

/**
 * Builds the user turn for the estimate loop.
 *
 * `resources` is passed in rather than read off the record because a large landscape
 * lives in S3, not on the DynamoDB item -- see resources_s3_key. The caller resolves
 * that; this function only ever sees the full list.
 */
export function buildPrompt(record: CalculationRecord, resources: CalculationResource[]): string {
  const parts: string[] = [];
  const environments: EnvironmentHours[] = record.environment_hours || [];
  const hoursFor = new Map(environments.map((entry) => [entry.name.trim().toLowerCase(), entry.hoursPerDay]));

  if (environments.length) {
    parts.push(
      'Runtime hours per environment (apply these as the utilization for time-billed resources):',
      ...environments.map((entry) => `- ${entry.name}: ${entry.hoursPerDay} hours/day`),
    );
  }

  if (record.prompt) {
    parts.push('', 'Workload description:', record.prompt);
  }

  if (record.workbook) renderWorkbook(record.workbook, parts);

  // A row with neither a service nor a size was never structured; it reaches the model
  // as the text it was, which is strictly better than dropping it.
  const priceable = resources.filter((resource) => resource.service || resource.size || resource.vcpu !== undefined);
  const freeText = resources.filter((resource) => !priceable.includes(resource));

  if (priceable.length) {
    const baseline = groupResources(priceable, hoursFor, 'baseline');
    const shown = baseline.slice(0, MAX_GROUP_LINES);

    parts.push(
      '',
      `SCENARIO 1 -- BASELINE: ${priceable.length} row(s) from the uploaded sheet, folded into ${baseline.length} group(s) of identically-configured machines.`,
      'Every line is a GROUP. Price ONE machine of it, multiply by the count, and set the calculator quantity to that count. Do not price the members separately.',
      ...shown.map(renderGroup),
    );
    if (baseline.length > shown.length) {
      const dropped = baseline.slice(MAX_GROUP_LINES);
      const machines = dropped.reduce((sum, group) => sum + group.count, 0);
      parts.push(
        `(${dropped.length} smaller group(s) covering ${machines} machine(s) are not listed. Add a warning saying that many machines were not priced -- do not silently omit them.)`,
      );
    }

    // Only worth a second table when the sheet actually recommended different sizes.
    // On the worked example 30 of 110 rows do, so the two scenarios share most lines.
    const hasRightSizing = priceable.some((resource) => resource.right_sized_size);
    if (hasRightSizing) {
      const rightsized = groupResources(priceable, hoursFor, 'rightsized').slice(0, MAX_GROUP_LINES);
      parts.push(
        '',
        `SCENARIO 2 -- RIGHT-SIZED: the same machines at the sizes the workbook recommends, in ${rightsized.length} group(s). Rows with no recommendation keep their baseline size.`,
        'Price this scenario from the same live rates and report its monthly total in scenarios[]. Do NOT build a second calculator.aws estimate for it: the shareable link and monthlyTotal describe the BASELINE, which is the configuration the client has agreed to.',
        ...rightsized.map(renderGroup),
      );
    }

    parts.push(
      '',
      'Pricing the groups:',
      `- Where a group states hrs/month, use that figure directly: monthly = rate x hrsPerMonth x count. Do not re-derive it from hours per day -- "On-Demand 12x5" is exactly 260 hrs/month, and no whole number of hours a day expresses it.`,
      `- Where a group states hrs/day, monthly = rate x ${HOURS_PER_MONTH} x (hrsPerDay / 24) x count.`,
      '- Where a group carries a purchase model ("3-Yr No Upfront", "Savings Plan", "On-Demand"), price it on that term and say which in workings. Do not quote On-Demand for a committed-term row; the commitment is most of the saving.',
      '- Price each group\'s disk as one storage line for its total GB. Set timeBilled false on it: storage costs the same whether the machine is running or not.',
      '- Group every line into a folder named after its environment, so the report\'s subtotals can be attributed.',
      '- Where a group has a spec but no instance type, choose the smallest current-generation instance that meets its vCPU and RAM, and record that choice in assumptions.',
    );
  }

  if (freeText.length) {
    parts.push(
      '',
      `Rows that could not be read as structured resources (${freeText.length}). Interpret them as text and price what you reasonably can; add a warning for anything you cannot:`,
      ...freeText.slice(0, MAX_FREE_TEXT_ROWS).map((resource, index) => `${index + 1}. ${resource.raw}`),
    );
    if (freeText.length > MAX_FREE_TEXT_ROWS) {
      parts.push(`(${freeText.length - MAX_FREE_TEXT_ROWS} further unstructured row(s) not shown.)`);
    }
  }

  if (record.input_warnings?.length) {
    parts.push(
      '',
      'Problems found while reading the sheet. Carry any that affect the estimate into warnings so the client sees them:',
      ...record.input_warnings.map((warning) => `- ${warning}`),
    );
  }

  if (record.region) {
    parts.push('', `Default region where a row does not state one: ${record.region}.`);
  } else if (record.workbook?.primary_region) {
    parts.push('', `No region was chosen on the form, so use the one the workbook states (${record.workbook.primary_region}) and record that in assumptions.`);
  }

  return parts.join('\n');
}
