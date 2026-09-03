import {
  fetchServiceDefinition,
  type DefinitionComponent,
} from '../lambdas/calculator-orchestrator/calculator-definitions.js';
const lambda = await fetchServiceDefinition('aWSLambda');
const c = lambda?.components.find((x: DefinitionComponent) => x.id === 'sizeOfMemoryAllocated');
console.log(JSON.stringify(c, null, 2).slice(0, 1500));
console.log('--- subTypes present in lambda def ---');
console.log([...new Set(lambda?.components.map((x: DefinitionComponent) => x.subType))].join(', '));
const fg = await fetchServiceDefinition('awsFargate');
const m = fg?.components.find((x: DefinitionComponent) => x.id === 'memoryStandardFargateOnDemand');
console.log('--- fargate memory component ---');
console.log(JSON.stringify(m, null, 2).slice(0, 900));
