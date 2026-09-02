import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { IepStack } from '../lib/infrastructure-stack';

/**
 * Verification-email delivery is the one setting whose misconfiguration is invisible
 * until users stop being able to sign up: SignUp returns success whether or not the
 * code was ever sent. Two things are pinned here.
 *
 * First, that leaving COGNITO_SES_FROM_ADDRESS unset keeps the pool on
 * EmailSendingAccount: COGNITO_DEFAULT and never on DEVELOPER. That is what makes the
 * SES work safe to deploy ahead of the DNS and sandbox-exit steps it depends on — an
 * accidental unconditional switch would point the pool at a sandboxed SES that rejects
 * every unverified recipient, breaking sign-up for everyone rather than for the subset
 * behind a mail gateway.
 *
 * Second, that message-delivery logging stays wired, since without it a failed send
 * leaves no trace anywhere to diagnose from.
 *
 * Synthesising re-bundles every Lambda in the stack, so the three configurations are
 * built once here and shared. Adding a fourth costs another full bundle — fold new
 * assertions into an existing config where the settings do not conflict.
 */

const SES_VARS = [
  'COGNITO_SES_FROM_ADDRESS',
  'COGNITO_SES_FROM_NAME',
  'COGNITO_SES_REPLY_TO_ADDRESS',
  'COGNITO_SES_REGION',
  'COGNITO_SES_VERIFIED_DOMAIN',
] as const;

type SesEnv = Partial<Record<(typeof SES_VARS)[number], string>>;

const saved: Record<string, string | undefined> = {};

/** Clears every COGNITO_SES_* var first, so no template depends on the ambient shell or a local .env. */
function synth(env: SesEnv = {}): Template {
  for (const key of SES_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  // Bundling every Lambda three times over dominates the runtime of this file and none
  // of these assertions look at an asset, so opt the stack out of asset staging. Also
  // removes any Docker requirement for the MCP sidecar's container image.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new IepStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
  });
  return Template.fromStack(stack);
}

/**
 * CDK composes the SES SourceArn with the AWS::Partition pseudo-parameter, so what
 * synthesises is an Fn::Join and not the flat string the deployed template shows.
 * Flattening to text keeps these assertions about which identity is referenced rather
 * than about the token wrapping it.
 */
function sourceArnText(template: Template): string {
  const [pool] = Object.values(template.findResources('AWS::Cognito::UserPool'));
  return JSON.stringify((pool as { Properties: { EmailConfiguration?: { SourceArn?: unknown } } })
    .Properties.EmailConfiguration?.SourceArn);
}

/** Cognito provider — the deployed default, and the state this must stay in until SES is ready. */
let defaultProvider: Template;
/** Bare from-address: no verified domain, so SES identity is the address itself. */
let sesAddressIdentity: Template;
/** Every optional lever set at once, including a domain identity in a pinned remote region. */
let sesDomainIdentity: Template;

beforeAll(() => {
  for (const key of SES_VARS) saved[key] = process.env[key];

  defaultProvider = synth();
  sesAddressIdentity = synth({ COGNITO_SES_FROM_ADDRESS: 'no-reply@mail.example.com' });
  sesDomainIdentity = synth({
    COGNITO_SES_FROM_ADDRESS: 'no-reply@mail.example.com',
    COGNITO_SES_FROM_NAME: 'Minfy Interviews',
    COGNITO_SES_REPLY_TO_ADDRESS: 'support@example.com',
    COGNITO_SES_VERIFIED_DOMAIN: 'mail.example.com',
    COGNITO_SES_REGION: 'us-east-1',
  });
}, 300_000);

afterAll(() => {
  for (const key of SES_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('Cognito email delivery', () => {
  test('stays on the Cognito-hosted sender when COGNITO_SES_FROM_ADDRESS is unset', () => {
    // From and SourceArn are what a half-configured SES switch would leave behind, so
    // their absence is the assertion that matters as much as the provider name.
    defaultProvider.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: {
        EmailSendingAccount: 'COGNITO_DEFAULT',
        From: Match.absent(),
        SourceArn: Match.absent(),
      },
    });
  });

  test('switches to our own SES once a from-address is supplied', () => {
    sesAddressIdentity.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({
        EmailSendingAccount: 'DEVELOPER',
        From: 'Interview Evaluation Platform <no-reply@mail.example.com>',
      }),
    });
    expect(sourceArnText(sesAddressIdentity)).toContain(
      ':ses:ap-south-1:123456789012:identity/no-reply@mail.example.com',
    );
  });

  test('carries the sender name, reply-to, and pinned SES region', () => {
    sesDomainIdentity.hasResourceProperties('AWS::Cognito::UserPool', {
      EmailConfiguration: Match.objectLike({
        From: 'Minfy Interviews <no-reply@mail.example.com>',
        ReplyToEmailAddress: 'support@example.com',
      }),
    });
    expect(sourceArnText(sesDomainIdentity)).toContain(':ses:us-east-1:');
  });

  test('points SourceArn at the domain identity when a verified domain is given', () => {
    // A domain-verified identity has no per-address identity to reference, so an ARN
    // derived from the from-address alone would name something that does not exist.
    expect(sourceArnText(sesDomainIdentity)).toContain(
      ':ses:us-east-1:123456789012:identity/mail.example.com',
    );
    expect(sourceArnText(sesDomainIdentity)).not.toContain('identity/no-reply@');
  });
});

describe('Cognito message-delivery logging', () => {
  test('exports userNotification errors to CloudWatch under either email provider', () => {
    // ERROR + userNotification is the only combination that reports message delivery,
    // and it must stay on however email is being sent.
    for (const template of [defaultProvider, sesDomainIdentity]) {
      template.hasResourceProperties('AWS::Cognito::LogDeliveryConfiguration', {
        LogConfigurations: [
          Match.objectLike({ EventSource: 'userNotification', LogLevel: 'ERROR' }),
        ],
      });
    }
  });

  test('logs to an unencrypted vendedlogs group with a bounded retention', () => {
    // The /aws/vendedlogs prefix keeps delivery clear of the 5120-character ceiling on
    // log-group resource policies; Cognito also rejects a KMS-encrypted group, so no
    // KmsKeyId may appear here.
    defaultProvider.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('^/aws/vendedlogs/cognito/'),
      RetentionInDays: 90,
      KmsKeyId: Match.absent(),
    });
  });
});
