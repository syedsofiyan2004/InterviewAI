import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockClient } from './aws';
import type { CalculationResource } from '../../schema/calculator';

const MODEL_ID = process.env.CALCULATOR_FORMATTER_MODEL_ID || 'global.anthropic.claude-sonnet-5';
const AWS_SERVICE = /\b(amazon|aws)\s+(ec2|rds|aurora|ecs|lambda|ebs|s3|opensearch|elasticache|redshift|sagemaker|dynamodb)\b/i;

type Decision = {
  groupId: string;
  awsService?: string;
  instanceSize?: string;
  availability?: 'Multi-AZ' | 'Single-AZ';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI formatter did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/** One bounded semantic pass. It enriches only fields supported by workbook evidence. */
export async function applyAiWorkbookFormatting(resources: CalculationResource[]): Promise<{
  resources: CalculationResource[];
  applied: number;
  warnings: string[];
}> {
  const groups = new Map<string, { id: string; sample: CalculationResource; indexes: number[] }>();
  resources.forEach((resource, index) => {
    const needsService = !AWS_SERVICE.test(resource.service || '');
    const needsSize = !resource.size && Boolean(resource.vcpu || resource.ram_gb);
    if (!needsService && !needsSize) return;
    const key = [resource.service, resource.section, resource.environment, resource.vcpu, resource.ram_gb, resource.os, resource.disk_gb]
      .map((value) => String(value ?? '').toLowerCase()).join('|');
    const existing = groups.get(key);
    if (existing) existing.indexes.push(index);
    else groups.set(key, { id: `g${groups.size + 1}`, sample: resource, indexes: [index] });
  });
  if (!groups.size) return { resources, applied: 0, warnings: [] };

  const selected = [...groups.values()].slice(0, 120);
  const payload = selected.map((group) => ({
    groupId: group.id,
    count: group.indexes.length,
    source: `${group.sample.sheet || 'Input'}!${group.sample.row || group.indexes[0] + 1}`,
    name: group.sample.name,
    sourceService: group.sample.service,
    section: group.sample.section,
    environment: group.sample.environment,
    vcpu: group.sample.vcpu,
    memoryGiB: group.sample.ram_gb,
    os: group.sample.os,
    storageGiB: group.sample.disk_gb,
    notes: group.sample.notes,
    raw: String(group.sample.raw || '').slice(0, 500),
  }));
  const prompt = `You are the workbook-formatting stage for an AWS estimate. Interpret these source-linked resource groups. Return JSON only: {"decisions":[{"groupId":"g1","awsService":"Amazon EC2","instanceSize":"m7i.large","availability":"Multi-AZ|Single-AZ","confidence":"high|medium|low","reason":"..."}]}. Resolve an AWS service from context. Choose an instance class only when vCPU, memory and OS support it; choose the smallest current general/compute/memory AWS class that meets both, preserving architecture when known. Production RDS/Aurora is Multi-AZ and non-production is Single-AZ unless source evidence overrides it. Omit fields you cannot support. Do not invent usage, quantity, storage, region, engine or traffic. Low confidence decisions are advisory and will not be applied.\n\n${JSON.stringify(payload)}`;
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] }),
  }));
  const body = JSON.parse(new TextDecoder().decode(response.body)) as { content?: Array<{ text?: string }> };
  const parsed = extractJson(body.content?.map((item) => item.text || '').join('') || '') as { decisions?: Decision[] };
  const decisions = new Map((parsed.decisions || []).filter((item) => item && item.confidence !== 'low').map((item) => [item.groupId, item]));
  const enriched = resources.map((resource) => ({ ...resource }));
  let applied = 0;
  for (const group of selected) {
    const decision = decisions.get(group.id);
    if (!decision) continue;
    for (const index of group.indexes) {
      const row = enriched[index];
      if (decision.awsService && !AWS_SERVICE.test(row.service || '')) row.service = decision.awsService;
      if (decision.instanceSize && !row.size) row.size = decision.instanceSize;
      if (decision.availability) row.configuration = { ...(row.configuration || {}), Availability: decision.availability };
      row.notes = [row.notes, `AI formatter (${decision.confidence}): ${decision.reason}`].filter(Boolean).join(' | ');
      applied++;
    }
  }
  return {
    resources: enriched,
    applied,
    warnings: groups.size > selected.length ? [`AI formatter reviewed ${selected.length} of ${groups.size} distinct unresolved configurations; remaining groups stay highlighted.`] : [],
  };
}
