// Environment consumed at module-load time by the Lambda handlers under test.
// validateEnv() in index.ts and processor/index.ts throws if any of these are
// unset, so they must be present before those modules are imported.
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
process.env.TABLE_NAME = 'test-interviews';
process.env.BUCKET_NAME = 'test-bucket';
process.env.QUEUE_URL = 'https://sqs.test/interviews';
process.env.MOM_TABLE_NAME = 'test-moms';
process.env.MOM_QUEUE_URL = 'https://sqs.test/moms';
process.env.INTELLIGENCE_TABLE_NAME = 'test-intelligence';
process.env.ADMIN_TABLE_NAME = 'test-admin';
process.env.CALCULATOR_TABLE_NAME = 'test-calculations';
// The chat table is read by the api-handler as well as the chat Lambda, now that
// conversations are listable — lambdas/chat/store.ts reads this at module load.
process.env.CHAT_TABLE_NAME = 'test-chat';
process.env.CALCULATOR_ORCHESTRATOR_FUNCTION_NAME = 'test-calculator-orchestrator';
process.env.CALCULATOR_SIDECAR_FUNCTION_NAME = 'test-calculator-sidecar';
// The AgentCore production path. calculator-agentcore-dispatch.ts reads these at module
// load, and isAgentCoreMode() is false without the state machine ARN — which would make
// the cutover tests silently exercise the legacy branch instead.
process.env.CALCULATOR_EXECUTION_STATE_MACHINE_ARN =
  'arn:aws:states:ap-south-1:123456789012:stateMachine:test-calculator-agentcore-exec';
process.env.CALCULATOR_EXECUTION_MODE = 'agentcore-runtime';
process.env.USER_POOL_ID = 'ap-south-1_test';
process.env.SEED_ADMIN_EMAIL = 'seed.admin@minfytech.com';
