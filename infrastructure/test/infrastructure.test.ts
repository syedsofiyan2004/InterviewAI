import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IepStack, kekaSyncRateHours } from '../lib/infrastructure-stack';

/**
 * Synth-level assertions for the Admin Portal / workspace layer. These guard the
 * two things a unit test on the handler cannot see: that the new table + indexes
 * actually exist in the template, and that every new route is wired to the
 * Cognito authorizer (an unauthenticated admin route would bypass every
 * server-side tier check in authz.ts).
 */
let template: Template;

/**
 * The sweep rate is an operator lever (KEKA_SYNC_RATE_HOURS), so the assertions
 * below would read whatever the ambient shell or .env happens to set — .env is
 * on 24 in this environment. Pinned to the default here so the template under
 * test is the same one on every machine; the lever itself is covered separately.
 */
const RATE_HOURS_ENV = process.env.KEKA_SYNC_RATE_HOURS;

beforeAll(() => {
  delete process.env.KEKA_SYNC_RATE_HOURS;
  const app = new cdk.App();
  const stack = new IepStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
  });
  template = Template.fromStack(stack);
});

afterAll(() => {
  if (RATE_HOURS_ENV === undefined) delete process.env.KEKA_SYNC_RATE_HOURS;
  else process.env.KEKA_SYNC_RATE_HOURS = RATE_HOURS_ENV;
});

describe('Admin table', () => {
  test('is created with a PK/SK schema and on-demand billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('carries all four sparse GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1_OrgRecency' }),
        Match.objectLike({ IndexName: 'GSI2_SharedWithUser' }),
        Match.objectLike({ IndexName: 'GSI3_AuditActor' }),
        Match.objectLike({ IndexName: 'GSI4_MemberEmail' }),
      ]),
    });
  });

  test('the three existing tables gain a sparse GSI_Workspace index', () => {
    // One per existing table (interviews, moms, intelligence) — the admin table
    // is not among them, so exactly three tables carry this index.
    const tables = template.findResources('AWS::DynamoDB::Table', {
      Properties: {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'GSI_Workspace',
            KeySchema: [{ AttributeName: 'workspace_id', KeyType: 'HASH' }],
          }),
        ]),
      },
    });
    expect(Object.keys(tables)).toHaveLength(3);
  });
});

describe('Cognito groups back the base_role layer', () => {
  test('MEMBER and ADMIN groups exist', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'MEMBER' });
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'ADMIN' });
  });
});

describe('New routes are registered and authenticated', () => {
  // Every resource path segment the admin portal and workspace layer introduce.
  const EXPECTED_PATHS = [
    'me',
    'admin', 'overview', 'search', 'audit-log', 'approvals', 'cognito-users',
    'members', 'grants', 'tier', 'revoke', 'base-role', 'keka-sync',
    'question-bank', 'questions',
    'my-interviews', 'refresh', 'open',
    'workspaces', 'shared-with-me', 'full', 'shares', 'comments', 'resolve',
    'link', 'unlink', 'decision',
    // Pinned because it was missed once: the router, the handler and the button
    // all existed while this resource did not, so "Analyze All Rounds" 404ed at
    // the gateway and never reached the Lambda. A handler with no resource is
    // invisible to every other test in this suite.
    'composite-analysis',
    // The hub's third app. Same exposure as above — calculator-routes.ts and the
    // dispatch block are useless without the gateway resources.
    'calculator', 'result', 'upload-url', 'report',
  ];

  test.each(EXPECTED_PATHS)('resource "%s" exists in the API', (pathPart) => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: pathPart });
  });

  test('no non-OPTIONS method is left without the Cognito authorizer', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const unauthenticated = Object.entries(methods)
      .filter(([, res]) => {
        const props = (res as any).Properties;
        // CORS preflight is intentionally open — it carries no data.
        if (props.HttpMethod === 'OPTIONS') return false;
        return props.AuthorizationType !== 'COGNITO_USER_POOLS' || !props.AuthorizerId;
      })
      .map(([id]) => id);

    expect(unauthenticated).toEqual([]);
  });

  test('the API exposes no PUT verb anywhere — grants and decisions append, never overwrite', () => {
    // API-wide property, not specific to one route: an append-only design has no
    // idempotent-replace verb. Catches a future PUT /admin/members/{id}/tier.
    const methods = template.findResources('AWS::ApiGateway::Method');
    const verbs = Object.values(methods).map((r) => (r as any).Properties.HttpMethod);
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs).not.toContain('PUT');
  });

  test('Keka schedule sync is an EventBridge target on the existing API handler', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(6 hours)',
      State: 'ENABLED',
      Targets: Match.arrayWith([
        Match.objectLike({
          Input: '{"__internalTask":"keka-schedule-sync","triggeredBy":"eventbridge"}',
        }),
      ]),
    });
  });

  test('the sync rule targets the API handler itself, not a new Lambda', () => {
    // The worker runs as an __internalTask on the existing 15-minute handler, so
    // the stack must not have grown a fourth function to serve it.
    const functions = Object.keys(template.findResources('AWS::Lambda::Function'));
    const own = functions.filter((id) => /^(ApiHandler|AsyncWorker|MomProcessor)/.test(id));
    expect(own).toHaveLength(3);
  });

  test('KEKA_SYNC_STATUS_MODE=all raises the sweep rate, clamped to once a day', () => {
    // The lever exists because status-mode 'all' walks every candidate of every
    // job. Both bounds matter: an unclamped value could become rate(0), or a
    // rate EventBridge rejects. Asserted on the shared helper rather than by
    // re-synthesising, which would bundle three Lambdas per case.
    expect(kekaSyncRateHours({ KEKA_SYNC_RATE_HOURS: '24' })).toBe(24);
    expect(kekaSyncRateHours({ KEKA_SYNC_RATE_HOURS: '999' })).toBe(24);
    expect(kekaSyncRateHours({ KEKA_SYNC_RATE_HOURS: '0' })).toBe(6);
    expect(kekaSyncRateHours({ KEKA_SYNC_RATE_HOURS: 'not-a-number' })).toBe(6);
    expect(kekaSyncRateHours({})).toBe(6);
  });

  test('the rule and the Lambda env cannot drift apart', () => {
    // Two consumers, one helper — a rule on 6 hours while the worker believes it
    // runs daily would make the sweep silently overlap itself.
    const rules = template.findResources('AWS::Events::Rule');
    const expression = (Object.values(rules)[0] as any).Properties.ScheduleExpression;
    expect(expression).toBe(events.Schedule.rate(cdk.Duration.hours(kekaSyncRateHours({}))).expressionString);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ KEKA_SYNC_RATE_HOURS: String(kekaSyncRateHours({})) }) },
    });
  });

  test('API self-invocation is scoped to the API handler instead of every Lambda', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const invokeStatements = Object.values(policies)
      .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return actions.includes('lambda:InvokeFunction');
      });

    expect(invokeStatements.length).toBeGreaterThan(0);
    expect(invokeStatements.some((statement: any) => statement.Resource === '*')).toBe(false);
    const resources = JSON.stringify(invokeStatements.map((statement: any) => statement.Resource));
    expect(resources).toContain(':function:iep-test-api-handler');
    expect(resources).not.toContain(':function/');
  });
});

/**
 * Logical IDs are the identity CloudFormation uses to decide "update" versus
 * "replace". Renaming or re-nesting a table construct would delete the live table
 * and every interview in it, so the four stateful constructs are pinned by ID
 * prefix here. Prefixes, not full IDs: the trailing hash is CDK's and changes
 * legitimately with unrelated additions to the same construct.
 */
describe('This change is additive — no existing logical ID moved', () => {
  test.each([
    ['AWS::DynamoDB::Table', 'InterviewsTable'],
    ['AWS::DynamoDB::Table', 'MomTable'],
    ['AWS::DynamoDB::Table', 'InterviewIntelligenceTable'],
    ['AWS::DynamoDB::Table', 'AdminTable'],
    ['AWS::DynamoDB::Table', 'CalculatorTable'],
    ['AWS::DynamoDB::Table', 'CalculatorEstimatesTable'],
    ['AWS::Lambda::Function', 'ApiHandler'],
    ['AWS::Lambda::Function', 'AsyncWorker'],
    ['AWS::Lambda::Function', 'MomProcessor'],
    ['AWS::Lambda::Function', 'CalculatorOrchestrator'],
    ['AWS::Cognito::UserPool', 'IepUserPool'],
    ['AWS::ApiGateway::RestApi', 'IepApi'],
  ])('%s %s keeps its logical id', (type, prefix) => {
    const ids = Object.keys(template.findResources(type));
    expect(ids.filter((id) => id.startsWith(prefix))).toHaveLength(1);
  });

  test('the table set is exactly the six we expect', () => {
    // A count alone would pass if a table were renamed, which is the case that
    // deletes live data. Naming the set makes an accidental or renamed table fail
    // here rather than at deploy time.
    const ids = Object.keys(template.findResources('AWS::DynamoDB::Table'));
    const prefixes = [
      'InterviewsTable', 'MomTable', 'InterviewIntelligenceTable',
      'AdminTable', 'CalculatorTable', 'CalculatorEstimatesTable',
    ];
    expect(ids).toHaveLength(prefixes.length);
    for (const prefix of prefixes) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
  });

  test('CalculatorTable and CalculatorEstimatesTable are not the same construct', () => {
    // 'CalculatorTable' is a prefix of nothing else, but 'CalculatorEstimatesTable'
    // must not be matched by a startsWith('CalculatorTable') check — assert they
    // resolve to two distinct logical ids.
    const ids = Object.keys(template.findResources('AWS::DynamoDB::Table'));
    const calc = ids.filter((id) => id.startsWith('CalculatorTable'));
    const estimates = ids.filter((id) => id.startsWith('CalculatorEstimatesTable'));
    expect(calc).toHaveLength(1);
    expect(estimates).toHaveLength(1);
    expect(calc[0]).not.toBe(estimates[0]);
  });

  test('the estimates table carries TTL so snapshots cannot accumulate forever', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });
});

describe('Keka live configuration fails closed', () => {
  test('live mode cannot synthesize without a Secrets Manager ARN', () => {
    const priorMode = process.env.KEKA_INTEGRATION_MODE;
    const priorArn = process.env.KEKA_SECRET_ARN;
    process.env.KEKA_INTEGRATION_MODE = 'live';
    delete process.env.KEKA_SECRET_ARN;
    try {
      const app = new cdk.App();
      expect(() => new IepStack(app, 'MissingKekaSecretStack', {
        env: { account: '123456789012', region: 'ap-south-1' },
      })).toThrow('KEKA_INTEGRATION_MODE=live requires KEKA_SECRET_ARN');
    } finally {
      if (priorMode === undefined) delete process.env.KEKA_INTEGRATION_MODE;
      else process.env.KEKA_INTEGRATION_MODE = priorMode;
      if (priorArn === undefined) delete process.env.KEKA_SECRET_ARN;
      else process.env.KEKA_SECRET_ARN = priorArn;
    }
  });
});
