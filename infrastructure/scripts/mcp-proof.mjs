/**
 * The three end-to-end MCP proofs, run against the deployed sidecar.
 *
 * Each proof takes a CANONICAL semantic resource — the shape MIMO's parser will produce —
 * maps it onto the field ids the MCP's own `get_service_fields` reports, and asks the MCP to
 * build and save the estimate. Nothing here computes a price: the whole point is that the
 * Calculator is the pricing authority and MIMO only hands it validated semantics.
 *
 * Field ids are written out here rather than fetched per run because these three proofs are
 * fixtures with known services; the production path resolves them from get_service_fields so
 * a catalog change cannot silently misprice. See scripts/mcp-probe.mjs for the raw schema.
 *
 * Usage: node scripts/mcp-proof.mjs [1|2|3|all]
 */
import { callTool } from './mcp-probe.mjs';

const REGION = 'ap-south-1';

/** Canonical Fargate resource, exactly as the requirement states it. Per-day stays per-day. */
const FARGATE_CANONICAL = {
  service: 'AWS Fargate',
  region: REGION,
  taskCount: 10,
  taskFrequency: 'perDay',
  vcpuPerTask: 1,
  memoryGbPerTask: 2,
  duration: 730,
  durationUnit: 'hours',
};

/**
 * Canonical Fargate to the calculator's Fargate fields.
 *
 * `numberOfTasks` is a frequency field whose options include perDay, so the source frequency
 * is carried across untouched: converting 10/day into 300/month before handing it over would
 * be MIMO inventing arithmetic the Calculator is about to do itself.
 *
 * Memory is a MUTEX FAMILY, not one field: smallMemory, memoryStandardFargateOnDemand,
 * smallMemory_8 and smallMemory_16 are each gated by the vCPU tier, and populating the wrong
 * one fails the `one-of-mutex` lint predicate. Which one applies is therefore not assumed --
 * `memoryField` is supplied by the caller, who learns it from the schema or from the lint's
 * own "requires variant" message on a first attempt.
 */
function fargateConfig(canonical, label, memoryField = 'smallMemory') {
  const memory = memoryField === 'smallMemory'
    // The small tier is a plain dropdown of GB values; the standard tier is a fileSize field
    // whose unit format the schema states as "{value}|{size}|{frequency}", default "gb|NA".
    ? String(canonical.memoryGbPerTask)
    : { value: String(canonical.memoryGbPerTask), unit: 'gb|NA' };
  return {
    region: canonical.region,
    description: label,
    numberOfTasks: { value: String(canonical.taskCount), unit: canonical.taskFrequency },
    taskDuration: { value: String(canonical.duration), unit: canonical.durationUnit },
    vcpuPerTask: String(canonical.vcpuPerTask),
    [memoryField]: memory,
  };
}

/**
 * The variant field a `one-of-mutex` lint failure names, or undefined when it named none.
 *
 * This is the correction signal the bounded operator loop runs on: the MCP does not merely
 * refuse, it says which field the gating value requires, so attempt two is a targeted fix
 * rather than another guess.
 */
function requiredVariant(errorText) {
  // The lint text arrives as an unparsed JSON payload, so its inner quotes are still escaped.
  // Unescaping first keeps the pattern readable and stops a \" from hiding the field name.
  const match = /requires variant "([^"]+)"/.exec(String(errorText || '').replace(/\\"/g, '"'));
  return match ? match[1] : undefined;
}

/**
 * EC2 with an explicit commitment.
 *
 * The pricingStrategy OBJECT form is mandatory: the catalog's own trap entry records that the
 * shorthand strings "reserved"/"instanceSavings" may silently fall back to On-Demand or save
 * a $0 line. `term` is always stated because an omitted term defaults to 3 Year.
 */
function ec2Config({ instanceType, count, commitment, label }) {
  return {
    region: REGION,
    instanceType,
    tenancy: 'shared',
    selectedOS: 'linux',
    workload: count,
    utilization: '100',
    pricingStrategy: commitment
      ? { model: commitment.model, term: commitment.term, upfrontPayment: commitment.upfrontPayment }
      : 'ondemand',
    description: label,
  };
}

const lambdaConfig = (label) => ({
  region: REGION,
  description: label,
  selectArchitectureRequests: '1',
  // Required even with no provisioned concurrency configured: the lint's
  // required-field-presence predicate refuses the save without it.
  selectArchitectureConcurrency: '1',
  numberOfRequests: { value: '2', unit: 'millionPerMonth' },
  // A bare numeric string, not a unit object: the catalog records that an older field name
  // was accepted by the save API and then ignored by the pricing engine, giving a $0 line.
  durationOfEachRequest: '200',
  // fileSize units are always "<size>|<freq>" — a bare "mb" is rejected at add time.
  sizeOfMemoryAllocated: { value: '512', unit: 'mb|NA' },
});

const s3Config = (label) => ({
  region: REGION,
  description: label,
  s3StandardStorageSize: { value: '500', unit: 'gb|month' },
});

/** One build, reported as pass or fail with the URL or the MCP's own error text. */
async function build(name, services) {
  const result = await callTool('build_estimate', {
    name,
    services: JSON.stringify(services),
  });
  if (result.isError) return { ok: false, detail: result.text.slice(0, 900) };
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    return { ok: false, detail: `unparseable result: ${result.text.slice(0, 400)}` };
  }
  if (!parsed.sharable_url) {
    // A structured envelope with no URL is the MCP telling us which services still need
    // field discovery. Surfaced verbatim, because that text IS the correction signal.
    return { ok: false, detail: JSON.stringify(parsed).slice(0, 1200), raw: parsed };
  }
  return { ok: true, url: parsed.sharable_url, raw: parsed };
}

/** Reads the saved estimate back, so a claim about what was saved is evidence, not hope. */
async function verify(url) {
  const result = await callTool('import_estimate', { estimate_id: url, format: 'json' });
  if (result.isError) return { ok: false, detail: result.text.slice(0, 400) };
  try {
    return { ok: true, estimate: JSON.parse(result.text) };
  } catch {
    return { ok: false, detail: 'saved estimate did not parse as JSON' };
  }
}

/** Every service the saved estimate contains, with the pricing wording it saved. */
function savedServices(estimate) {
  const rows = [];
  for (const group of Object.values(estimate?.groups || {})) {
    for (const service of Object.values(group.services || {})) {
      const components = service.calculationComponents || {};
      const strategy = components.pricingStrategy?.value ?? components.pricingStrategy;
      rows.push({
        serviceCode: service.serviceCode,
        description: service.description,
        pricing: strategy ? JSON.stringify(strategy) : 'no pricing component (On-Demand only service)',
      });
    }
  }
  return rows;
}

/**
 * One Fargate build with at most one correction, which is the operator contract in miniature.
 *
 * Attempt one uses the memory field the schema's `minimalConfig` shows. If the lint refuses
 * and names the variant the vCPU tier actually gates, attempt two uses that field and nothing
 * else changes. A third attempt is not made: two is the cap, and a failure that survives a
 * targeted correction is a real missing-input problem, not a retry problem.
 */
async function buildFargate(name, label, group = 'On-Demand') {
  let memoryField = 'smallMemory';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const built = await build(name, [{
      service: 'awsFargate',
      group,
      config: fargateConfig(FARGATE_CANONICAL, label, memoryField),
    }]);
    if (built.ok) {
      if (attempt > 1) console.log(`corrected on attempt ${attempt}: memory field ${memoryField}`);
      return built;
    }
    const variant = requiredVariant(built.detail);
    if (!variant || variant === memoryField) return built;
    console.log(`attempt ${attempt} refused; MCP names variant "${variant}" — retrying with it`);
    memoryField = variant;
  }
  return { ok: false, detail: 'two attempts exhausted' };
}

async function proof1() {
  console.log('\n=== PROOF 1: one Fargate resource, On-Demand ===');
  console.log('canonical:', JSON.stringify(FARGATE_CANONICAL));
  const built = await buildFargate(
    'MIMO proof 1 - Fargate On-Demand',
    '10 tasks/day, 1 vCPU, 2 GB, 730 h',
  );
  if (!built.ok) return console.log('FAILED:', built.detail), false;
  console.log('link:', built.url);
  const back = await verify(built.url);
  if (!back.ok) return console.log('saved but unreadable:', back.detail), false;
  console.table(savedServices(back.estimate));
  return true;
}

async function proof2() {
  console.log('\n=== PROOF 2: EC2, 1-Year Compute Savings Plan ===');
  console.log('(EC2 is the CSP-eligible service the Calculator exposes; Fargate has no commitment field at all)');
  const built = await build('MIMO proof 2 - EC2 1Y Compute Savings Plan', [{
    service: 'ec2Enhancement',
    group: '1-Year Compute Savings Plan',
    config: ec2Config({
      instanceType: 'm6i.large',
      count: 2,
      commitment: { model: 'computeSavings', term: '1 Year', upfrontPayment: 'None' },
      label: '2 x m6i.large, 1-Year Compute Savings Plan, No Upfront',
    }),
  }]);
  if (!built.ok) return console.log('FAILED:', built.detail), false;
  console.log('link:', built.url);
  const back = await verify(built.url);
  if (!back.ok) return console.log('saved but unreadable:', back.detail), false;
  const rows = savedServices(back.estimate);
  console.table(rows);
  // The whole point of the proof: the saved blob must still say computeSavings/1 Year. A
  // fallback to On-Demand is the exact regression 1.3.0 fixes upstream.
  const held = rows.some((row) => /computeSavings|compute-savings/i.test(row.pricing) && /1 Year|1yr/i.test(row.pricing));
  console.log(held ? 'COMMITMENT HELD: computeSavings / 1 Year' : 'COMMITMENT LOST — saved as something else (see table)');
  return held;
}

async function proof3() {
  console.log('\n=== PROOF 3: EC2 + Fargate + Lambda + S3, 3-Year Compute Savings Plan scenario ===');
  const GROUP = '3-Year Compute Savings Plan';
  /** The whole scenario rebuilt for one attempt, so a correction re-sends a consistent set. */
  const servicesWith = (memoryField) => [
    {
      service: 'ec2Enhancement',
      group: GROUP,
      config: ec2Config({
        instanceType: 'm6i.xlarge',
        count: 4,
        commitment: { model: 'computeSavings', term: '3 Year', upfrontPayment: 'None' },
        label: '4 x m6i.xlarge, 3-Year Compute Savings Plan, No Upfront',
      }),
    },
    {
      service: 'awsFargate',
      group: GROUP,
      config: fargateConfig(
        FARGATE_CANONICAL,
        '10 tasks/day, 1 vCPU, 2 GB - On-Demand (no commitment offered)',
        memoryField,
      ),
    },
    {
      service: 'aWSLambda',
      group: GROUP,
      config: lambdaConfig('2M requests/month, 200 ms, 512 MB - On-Demand (no commitment offered)'),
    },
    {
      service: 'amazonS3Standard',
      group: GROUP,
      config: s3Config('500 GB standard storage - On-Demand'),
    },
  ];

  let memoryField = 'smallMemory';
  let built;
  for (let attempt = 1; attempt <= 2; attempt++) {
    built = await build('MIMO proof 3 - mixed 3Y CSP', servicesWith(memoryField));
    if (built.ok) break;
    const variant = requiredVariant(built.detail);
    if (!variant || variant === memoryField) break;
    console.log(`attempt ${attempt} refused; MCP names variant "${variant}" — retrying with it`);
    memoryField = variant;
  }
  if (!built.ok) return console.log('FAILED:', built.detail), false;
  console.log('link:', built.url);
  const back = await verify(built.url);
  if (!back.ok) return console.log('saved but unreadable:', back.detail), false;
  const rows = savedServices(back.estimate);
  console.table(rows);
  const ec2Committed = rows.some((r) => r.serviceCode === 'ec2Enhancement'
    && /computeSavings|compute-savings/i.test(r.pricing) && /3 Year|3yr/i.test(r.pricing));
  const others = rows.filter((r) => r.serviceCode !== 'ec2Enhancement');
  const othersUncommitted = others.every((r) => !/savings|reserved/i.test(r.pricing));
  console.log(`EC2 committed at 3-Year CSP: ${ec2Committed}`);
  console.log(`Non-eligible services present: ${others.length} (${others.map((r) => r.serviceCode).join(', ')})`);
  console.log(`All non-eligible services left uncommitted: ${othersUncommitted}`);
  return ec2Committed && others.length === 3 && othersUncommitted;
}

const which = process.argv[2] || 'all';
const results = {};
if (which === '1' || which === 'all') results.proof1 = await proof1();
if (which === '2' || which === 'all') results.proof2 = await proof2();
if (which === '3' || which === 'all') results.proof3 = await proof3();
console.log('\n=== SUMMARY ===');
console.log(results);
