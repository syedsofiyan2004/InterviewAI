import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DeleteTranscriptionJobCommand, StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Readable } from 'node:stream';
import { ddbDocClient } from '../lambdas/shared/aws';
import { TeamsIntegrationError } from '../lambdas/api-handler/intelligence-integrations';

jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation(() => ({ done: jest.fn().mockResolvedValue({}) })),
}));

const getRecording = jest.fn();

jest.mock('../lambdas/api-handler/intelligence-integrations', () => ({
  ...jest.requireActual('../lambdas/api-handler/intelligence-integrations'),
  createTeamsIntegration: () => ({ getRecording }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambdas/api-handler/index') as typeof import('../lambdas/api-handler/index');

const ddbMock = mockClient(ddbDocClient);
const transcribeMock = mockClient(TranscribeClient);
const s3Mock = mockClient(S3Client);

const item = {
  intelligence_id: 'intelligence-1',
  owner_user_id: 'user-1',
  created_at: Date.now(),
  updated_at: Date.now(),
  source_mode: 'keka_live',
  status: 'questions_generated',
  keka: { mode: 'live', syncStatus: 'synced' },
  teams: { mode: 'live', transcriptStatus: 'transcribing', lastSyncAt: Date.now() },
  job: { title: 'Full Stack Developer', description: 'Build applications.', requiredSkills: [] },
  candidate: { name: 'Kamlesh Pradhan' },
  panel: [{ interviewerId: 'employee-1', name: 'Panel Member' }],
};

describe('Teams recording transcription worker concurrency', () => {
  beforeEach(() => {
    ddbMock.reset();
    transcribeMock.reset();
    s3Mock.reset();
    getRecording.mockReset();
    ddbMock.on(GetCommand).resolves({ Item: item });
    ddbMock.on(UpdateCommand).resolves({ Attributes: item });
  });

  test('claims the worker and conditionally records failure without replacing the full item', async () => {
    getRecording.mockRejectedValue(new TeamsIntegrationError('No matching recording exists.'));

    const response = await handler({
      __internalTask: 'teams-recording-transcription',
      intelligenceId: 'intelligence-1',
    } as any);

    expect(response.statusCode).toBe(502);
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0].args[0].input.ConditionExpression).toContain('transcriptStatus');
    expect(updates.at(-1)?.args[0].input.ConditionExpression).toContain('recordingWorkerToken');
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  test('cancels the job and deletes uploaded objects when the final state write loses a race', async () => {
    const conditionalError = Object.assign(new Error('state changed'), { name: 'ConditionalCheckFailedException' });
    const latest = {
      ...item,
      status: 'transcript_ready',
      transcript: { rawText: 'Manual transcript won.', source: 'manual', uploadedAt: Date.now() },
      teams: { ...item.teams, transcriptStatus: 'synced' },
    };
    ddbMock.on(GetCommand)
      .resolvesOnce({ Item: item })
      .resolvesOnce({ Item: latest });
    ddbMock.on(UpdateCommand)
      .resolvesOnce({ Attributes: item })
      .rejectsOnce(conditionalError);
    getRecording.mockResolvedValue({
      stream: Readable.from([Buffer.from([1, 2, 3, 4])]),
      contentType: 'video/mp4',
      contentLength: 4,
      extension: 'mp4',
      recordingId: 'recording-1',
      meetingId: 'meeting-1',
      organizerUserId: 'organizer-1',
    });
    transcribeMock.on(StartTranscriptionJobCommand).resolves({});
    transcribeMock.on(DeleteTranscriptionJobCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const response = await handler({
      __internalTask: 'teams-recording-transcription',
      intelligenceId: 'intelligence-1',
    } as any);

    expect(response.statusCode).toBe(200);
    expect(transcribeMock).toHaveReceivedCommand(DeleteTranscriptionJobCommand);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});
