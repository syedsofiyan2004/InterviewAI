import fs from 'fs';
import { planSegments, resourcesFromCanonicalModel, materializePlanResources } from './lambdas/calculator-orchestrator/pipeline';

const canonical = JSON.parse(fs.readFileSync('zz-calc-0b1157-canonical.json', 'utf8'));
const record = JSON.parse(fs.readFileSync('zz-calc-0b1157-summary.json', 'utf8'));
const resources = resourcesFromCanonicalModel(canonical);
const planned = materializePlanResources(resources, { requirements: [], scenarios: record.scenarios } as any);
const bands = canonical.scenarios.map((s: any) => ({ key: s.key, label: s.label, kind: s.kind, resource_count: 0, sheet: 'Digital Assets' }));
const { segments, unmatched } = planSegments(record.scenarios, planned, bands, new Map(), []);
console.log(JSON.stringify({
  resources: resources.length,
  plannedScenarioCounts: planned.reduce((acc: any, r: any) => { acc[r.scenario || 'NO'] = (acc[r.scenario || 'NO'] || 0) + 1; return acc; }, {}),
  bands,
  segments: segments.map(s => ({ key: s.key, label: s.label, kind: s.kind, groups: s.groups.length })),
  unmatched,
}, null, 2));
