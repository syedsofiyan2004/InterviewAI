import pathlib

path = pathlib.Path('lib/infrastructure-stack.ts')
src = path.read_text(encoding='utf-8')

before = """      environment: {
        CALCULATOR_TABLE_NAME: calculatorTable.tableName,
        CALCULATOR_SIDECAR_FUNCTION_NAME: calculatorSidecar.functionName,
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        PLATFORM_VERSION: `v1.0.0-calculator-${Date.now()}`,
      },"""
after = """      environment: {
        CALCULATOR_TABLE_NAME: calculatorTable.tableName,
        CALCULATOR_SIDECAR_FUNCTION_NAME: calculatorSidecar.functionName,
        // A landscape too large for a 400KB DynamoDB item has its parsed rows written
        // to S3 by the route; the orchestrator reads them back from here.
        BUCKET_NAME: filesBucket.bucketName,
        BEDROCK_SONNET_5_PROFILE_ARN: process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5',
        PLATFORM_VERSION: `v1.0.0-calculator-${Date.now()}`,
      },"""
assert src.count(before) == 1
src = src.replace(before, after, 1)

before = """    calculatorTable.grantReadWriteData(calculatorOrchestrator);
    calculatorSidecar.grantInvoke(calculatorOrchestrator);"""
after = """    calculatorTable.grantReadWriteData(calculatorOrchestrator);
    calculatorSidecar.grantInvoke(calculatorOrchestrator);
    // Read only: the orchestrator consumes the parsed row spill, it never writes to
    // the bucket. The route owns both writing that object and deleting it.
    filesBucket.grantRead(calculatorOrchestrator);"""
assert src.count(before) == 1
src = src.replace(before, after, 1)

path.write_text(src, encoding='utf-8')
print('ok')
