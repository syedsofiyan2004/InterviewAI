import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import type { APIGatewayProxyEvent } from 'aws-lambda';

process.env.KEKA_INTEGRATION_MODE = 'live';
process.env.TEAMS_INTEGRATION_MODE = 'live';

const getInterviewData = jest.fn();
const getTranscript = jest.fn();

jest.mock('../lambdas/api-handler/intelligence-integrations', () => ({
  ...jest.requireActual('../lambdas/api-handler/intelligence-integrations'),
  createKekaIntegration: () => ({ getInterviewData }),
  createTeamsIntegration: () => ({ getTranscript }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambdas/api-handler/index') as typeof import('../lambdas/api-handler/index');

const ddbMock = mockClient(ddbDocClient);

function intelligenceRecord() {
  return {
    intelligence_id: 'intel-saritha',
    owner_user_id: 'owner-1',
    owner_email: 'owner@minfytech.com',
    created_at: Date.now(),
    updated_at: Date.now(),
    source_mode: 'keka_live',
    status: 'questions_generated',
    keka: {
      mode: 'live',
      syncStatus: 'synced',
      jobId: 'job-1',
      candidateId: 'candidate-1',
      interviewId: 'keka-interview-1',
    },
    teams: {
      mode: 'live',
      transcriptStatus: 'failed',
      scheduledAt: '2026-09-02T10:30:00.000Z',
      organizerEmail: 'venkata.matta@minfytech.com',
      error: 'No Teams meeting with this candidate was found around the Keka interview time.',
    },
    job: { title: 'Azure SME', description: 'Azure role', requiredSkills: [] },
    candidate: { name: 'Saritha k', email: 'saritha.1909@gmail.com' },
    panel: [],
  };
}

function syncEvent(): Partial<APIGatewayProxyEvent> {
  return {
    httpMethod: 'POST',
    resource: '/intelligence-interviews/{id}/sync-teams-transcript',
    pathParameters: { id: 'intel-saritha' },
    body: null,
    requestContext: {
      authorizer: { claims: { sub: 'owner-1', email: 'owner@minfytech.com' } },
    } as any,
  };
}

beforeEach(() => {
  ddbMock.reset();
  getInterviewData.mockReset();
  getTranscript.mockReset();
  ddbMock.on(GetCommand).resolves({ Item: intelligenceRecord() });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(ScanCommand).resolves({
    Items: [{
      keka_interview_id: 'keka-interview-1',
      meeting_url: 'https://teams.microsoft.com/l/meetup-join/saritha',
      organizer_email: 'venkata.matta@minfytech.com',
      scheduled_at: Date.parse('2026-09-02T10:30:00.000Z'),
      panelist_email: 'srikar.deshmukh@minfytech.com',
    }],
  });
  getInterviewData.mockResolvedValue({
    job: { title: 'Azure SME', description: 'Azure role', requiredSkills: [] },
    candidate: { name: 'Saritha k', email: 'saritha.1909@gmail.com' },
    panel: [],
    scheduledAt: '2026-09-02T10:30:00.000Z',
    organizerEmail: 'venkata.matta@minfytech.com',
  });
  getTranscript.mockResolvedValue({
    rawText: 'Saritha answered Azure questions.',
    meetingId: 'meeting-1',
    organizerUserId: 'organizer-user-1',
  });
});

test('syncing an old Keka workspace backfills the Teams link from the scheduled row', async () => {
  const response = await handler(syncEvent() as any);

  expect(response.statusCode).toBe(200);
  expect(getTranscript).toHaveBeenCalledWith(expect.objectContaining({
    meetingUrl: 'https://teams.microsoft.com/l/meetup-join/saritha',
    organizerEmail: 'venkata.matta@minfytech.com',
    candidateName: 'Saritha k',
    candidateEmail: 'saritha.1909@gmail.com',
  }));
  expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
    TableName: 'test-intelligence',
    Item: expect.objectContaining({
      status: 'transcript_ready',
      teams: expect.objectContaining({
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/saritha',
        transcriptStatus: 'synced',
      }),
      transcript: expect.objectContaining({
        rawText: 'Saritha answered Azure questions.',
      }),
    }),
  });
});
