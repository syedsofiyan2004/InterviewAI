import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  MicrosoftGraphTeamsIntegration,
  TeamsIntegrationError,
} from '../lambdas/api-handler/intelligence-integrations';

const secretsMock = mockClient(SecretsManagerClient);
const priorSecretArn = process.env.MS_TEAMS_SECRET_ARN;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Microsoft Graph meeting safety', () => {
  beforeAll(() => {
    process.env.MS_TEAMS_SECRET_ARN = 'arn:aws:secretsmanager:ap-south-1:123456789012:secret:test-teams';
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1' }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    secretsMock.restore();
    restoreEnv('MS_TEAMS_SECRET_ARN', priorSecretArn);
  });

  test('does not select a sole calendar event without candidate evidence', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      if (url.includes('/calendarView?')) {
        return jsonResponse({ value: [{
          id: 'unrelated-event',
          subject: 'Weekly engineering standup',
          start: { dateTime: '2026-08-11T10:45:00Z', timeZone: 'UTC' },
          attendees: [{ emailAddress: { address: 'someone.else@minfytech.com' } }],
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/unrelated' },
        }] });
      }
      if (url.includes('/onlineMeetings?')) return jsonResponse({ value: [{ id: 'unrelated-meeting' }] });
      if (url.includes('/transcripts?')) return jsonResponse({ value: [{ id: 'transcript-1' }] });
      if (url.includes('/transcripts/transcript-1/content')) return new Response('WEBVTT\n\nUnrelated meeting', { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(new MicrosoftGraphTeamsIntegration().getTranscript({
      scheduledAt: '2026-08-11T10:45:00Z',
      candidateName: 'Kamlesh Pradhan',
      candidateEmail: 'kamlesh@example.com',
      jobTitle: 'Full Stack Developer',
      organizerEmail: 'organizer@minfytech.com',
    })).rejects.toThrow(new TeamsIntegrationError(
      'No Teams meeting with this candidate was found around the Keka interview time. Add the exact Teams meeting link in Keka or verify the candidate attendee details.',
    ));
  });

  test('accepts a calendar event with exact candidate attendee evidence', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      if (url.includes('/calendarView?')) {
        return jsonResponse({ value: [{
          id: 'candidate-event',
          subject: 'Technical interview',
          start: { dateTime: '2026-08-11T10:45:00Z', timeZone: 'UTC' },
          attendees: [{ emailAddress: { address: 'kamlesh@example.com' } }],
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/candidate' },
        }] });
      }
      if (url.includes('/onlineMeetings?')) return jsonResponse({ value: [{ id: 'candidate-meeting' }] });
      if (url.includes('/transcripts?')) return jsonResponse({ value: [{ id: 'transcript-1' }] });
      if (url.includes('/transcripts/transcript-1/content')) return new Response('WEBVTT\n\nCandidate interview', { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const transcript = await new MicrosoftGraphTeamsIntegration().getTranscript({
      scheduledAt: '2026-08-11T10:45:00Z',
      candidateName: 'Kamlesh Pradhan',
      candidateEmail: 'kamlesh@example.com',
      jobTitle: 'Full Stack Developer',
      organizerEmail: 'organizer@minfytech.com',
    });

    expect(transcript.rawText).toBe('Candidate interview');
  });

  test('rejects candidate evidence outside the scheduled time tolerance', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      if (url.includes('/calendarView?')) {
        return jsonResponse({ value: [{
          id: 'distant-candidate-event',
          subject: 'Technical interview',
          start: { dateTime: '2026-08-11T18:45:00Z', timeZone: 'UTC' },
          attendees: [{ emailAddress: { address: 'kamlesh@example.com' } }],
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/distant' },
        }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(new MicrosoftGraphTeamsIntegration().getTranscript({
      scheduledAt: '2026-08-11T10:45:00Z',
      candidateName: 'Kamlesh Pradhan',
      candidateEmail: 'kamlesh@example.com',
      jobTitle: 'Full Stack Developer',
      organizerEmail: 'organizer@minfytech.com',
    })).rejects.toThrow('No Teams meeting with this candidate was found around the Keka interview time');
  });

  test('does not treat candidate-name substrings inside unrelated words as evidence', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      if (url.includes('/calendarView?')) {
        return jsonResponse({ value: [{
          id: 'substring-event',
          subject: 'Planning fleet review',
          start: { dateTime: '2026-08-11T10:45:00Z', timeZone: 'UTC' },
          attendees: [],
          onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/unrelated' },
        }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(new MicrosoftGraphTeamsIntegration().getTranscript({
      scheduledAt: '2026-08-11T10:45:00Z',
      candidateName: 'Ann Lee',
      organizerEmail: 'organizer@minfytech.com',
    })).rejects.toThrow('No Teams meeting with this candidate was found around the Keka interview time');
  });

  test('returns recording content as a stream without materialising an array buffer', async () => {    const arrayBuffer = jest.fn(async () => new ArrayBuffer(1024));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.close();
      },
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      if (url.includes('/recordings?')) return jsonResponse({ value: [{ id: 'recording-1' }] });
      if (url.includes('/recordings/recording-1/content')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '4' }),
          body,
          arrayBuffer,
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const recording: any = await new MicrosoftGraphTeamsIntegration().getRecording({
      meetingId: 'meeting-1',
      organizerEmail: 'organizer@minfytech.com',
    });

    expect(recording.stream).toBeDefined();
    expect(recording.contentLength).toBe(4);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

/**
 * The recording + AWS Transcribe route only runs when the error that killed the
 * direct transcript says it may. The UI promises "if Microsoft Graph cannot
 * provide it, MiMo will use the meeting recording" — so the flag has to be set on
 * every failure that means the transcript is unobtainable, not just a 404.
 *
 * It shipped wired to 404 only, so a tenant whose transcript permission or
 * Application Access Policy was missing got a 403 and never reached AWS Transcribe
 * at all. That is the bug these tests hold closed.
 */
describe('Which transcript failures may fall back to the recording', () => {
  /** Answers everything up to the named transcript/recording call. */
  function graphUpTo(handler: (url: string) => Response | undefined) {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({ id: 'organizer-user-id' });
      const answer = handler(url);
      if (answer) return answer;
      throw new Error(`Unexpected URL: ${url}`);
    });
  }

  const withMeeting = {
    meetingId: 'meeting-1',
    organizerEmail: 'organizer@minfytech.com',
    candidateName: 'Kamlesh Pradhan',
  };

  async function transcriptFailure(): Promise<TeamsIntegrationError> {
    try {
      await new MicrosoftGraphTeamsIntegration().getTranscript(withMeeting);
    } catch (err) {
      return err as TeamsIntegrationError;
    }
    throw new Error('Expected getTranscript to fail');
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a 403 listing transcripts allows the recording fallback', async () => {
    graphUpTo((url) => (url.includes('/transcripts?') ? jsonResponse({}, 403) : undefined));

    const err = await transcriptFailure();

    expect(err.message).toContain('denied access to the Teams transcript');
    expect(err.recordingFallbackAllowed).toBe(true);
  });

  test('a 403 downloading the transcript allows the recording fallback', async () => {
    graphUpTo((url) => {
      if (url.includes('/transcripts?')) return jsonResponse({ value: [{ id: 'transcript-1' }] });
      if (url.includes('/transcripts/transcript-1/content')) return jsonResponse({}, 403);
      return undefined;
    });

    const err = await transcriptFailure();

    expect(err.recordingFallbackAllowed).toBe(true);
  });

  test('a 404 still allows it', async () => {
    graphUpTo((url) => (url.includes('/transcripts?') ? jsonResponse({}, 404) : undefined));

    expect((await transcriptFailure()).recordingFallbackAllowed).toBe(true);
  });

  test('rejected credentials do not — retrying against the recording would fail identically', async () => {
    graphUpTo((url) => (url.includes('/transcripts?') ? jsonResponse({}, 401) : undefined));

    expect((await transcriptFailure()).recordingFallbackAllowed).toBe(false);
  });

  test('a 403 resolving the organiser does not — the meeting was never identified', async () => {
    // Falling back here would mean fetching "the recording" of a meeting we could
    // not confirm, which is how the wrong meeting gets transcribed.
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) return jsonResponse({ access_token: 'graph-token', expires_in: 3600 });
      if (url.includes('/users/organizer%40minfytech.com?')) return jsonResponse({}, 403);
      throw new Error(`Unexpected URL: ${url}`);
    });

    expect((await transcriptFailure()).recordingFallbackAllowed).toBe(false);
  });

  test('a 403 on the recording itself does not re-arm the fallback', async () => {
    // The end of the line: the fallback has already been taken, and marking this
    // as fallback-eligible would invite a second attempt at the same denial.
    graphUpTo((url) => (url.includes('/recordings?') ? jsonResponse({}, 403) : undefined));

    try {
      await new MicrosoftGraphTeamsIntegration().getRecording(withMeeting);
      throw new Error('Expected getRecording to fail');
    } catch (err) {
      expect((err as TeamsIntegrationError).message).toContain('denied access to the Teams recording');
      expect((err as TeamsIntegrationError).recordingFallbackAllowed).toBe(false);
    }
  });
});
