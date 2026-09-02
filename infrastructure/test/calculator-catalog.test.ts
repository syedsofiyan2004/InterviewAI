import {
  parseServiceCatalog,
  resolveConfigAgainstCatalog,
  validateConfigAgainstCatalog,
} from '../lambdas/calculator-orchestrator/calculator-catalog';

describe('live Calculator catalog contract', () => {
  test('resolves semantic labels to current opaque dropdown ids before validation', () => {
    const catalog = parseServiceCatalog({
      isError: false,
      text: JSON.stringify({
        serviceCode: 'amazonMQ', serviceName: 'Amazon MQ', fields: [{
          id: 'rabbitmqInstanceType', type: 'dropdown',
          options: [{ id: 'opaque-current-id', label: 'mq.t3.micro' }],
        }],
      }),
    });
    const config = resolveConfigAgainstCatalog(catalog, { rabbitmqInstanceType: 'mq.t3.micro' });
    expect(config.rabbitmqInstanceType).toBe('opaque-current-id');
    expect(validateConfigAgainstCatalog(catalog, config)).toEqual([]);
  });

  test('does not accept an unknown dropdown label', () => {
    const catalog = parseServiceCatalog({
      isError: false,
      text: JSON.stringify({
        serviceCode: 'service', serviceName: 'Service', fields: [{
          id: 'mode', type: 'dropdown', options: [{ id: 'known', label: 'Known' }],
        }],
      }),
    });
    expect(validateConfigAgainstCatalog(catalog, resolveConfigAgainstCatalog(catalog, { mode: 'invented' })))
      .toEqual(['service.mode is not a current catalog option.']);
  });
});
