import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  MomOutputError,
  parseMomModelOutput,
} from '../lambdas/mom-processor/output-parser';

const validResult = {
  title: 'Minfy-Intranet Go Live Prep',
  date: 'Not specified',
  overall_summary: 'The team reviewed go-live readiness and confirmed the remaining actions.',
  attendees: [],
  agenda_items: ['Go-live readiness'],
  discussion_points: [],
  risks: [],
  next_steps: ['Complete the remaining readiness checks'],
  previous_actions: [],
};

function bedrockPayload(text: string, stopReason = 'end_turn') {
  return {
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
  };
}

function bedrockResponse(payload: object) {
  return { body: new TextEncoder().encode(JSON.stringify(payload)) } as any;
}

describe('MOM model output parser', () => {
  test('accepts valid tagged JSON without repair', () => {
    const result = parseMomModelOutput(bedrockPayload(
      `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
    ));

    expect(result.value).toEqual(validResult);
    expect(result.repaired).toBe(false);
  });

  test('accepts transcript-grounded reports with empty optional content sections', () => {
    const emptyReport = {
      ...validResult,
      agenda_items: [],
      discussion_points: [],
      risks: [],
      next_steps: [],
    };

    const result = parseMomModelOutput(bedrockPayload(
      `<mom_json>${JSON.stringify(emptyReport)}</mom_json>`,
    ));

    expect(result.value).toEqual(emptyReport);
    expect(result.repaired).toBe(false);
  });

  test('repairs a missing comma without changing the report fields', () => {
    const malformed = JSON.stringify(validResult).replace(
      '"date":"Not specified",',
      '"date":"Not specified"',
    );

    const result = parseMomModelOutput(bedrockPayload(`<mom_json>${malformed}</mom_json>`));

    expect(result.value).toEqual(validResult);
    expect(result.repaired).toBe(true);
  });

  test('classifies schema-invalid output as retryable without exposing its content', () => {
    expect(() => parseMomModelOutput(bedrockPayload(
      '<mom_json>{"title":"Private transcript content"}</mom_json>',
    ))).toThrow(expect.objectContaining<Partial<MomOutputError>>({
      name: 'MomOutputError',
      kind: 'validation',
    }));
  });

  test('rejects a max-token response even when repair could make it schema-valid', () => {
    const truncatedButRepairable = JSON.stringify(validResult).slice(0, -2);

    expect(() => parseMomModelOutput(bedrockPayload(
      `<mom_json>${truncatedButRepairable}</mom_json>`,
      'max_tokens',
    ))).toThrow(expect.objectContaining<Partial<MomOutputError>>({
      name: 'MomOutputError',
      kind: 'truncated',
    }));
  });
});

describe('MOM Bedrock recovery', () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  let analyzeTranscript: typeof import('../lambdas/mom-processor/index').analyzeTranscript;

  beforeAll(() => {
    process.env.MOM_MODEL_ID = 'global.anthropic.claude-sonnet-5';
    ({ analyzeTranscript } = require('../lambdas/mom-processor/index'));
  });

  beforeEach(() => {
    bedrockMock.reset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('keeps the successful path to one model call', async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockResponse(bedrockPayload(
      `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
    )));

    await expect(analyzeTranscript('Meeting', 'Transcript')).resolves.toEqual(validResult);
    expect(bedrockMock).toHaveReceivedCommandTimes(InvokeModelCommand, 1);
  });

  test('requires transcript evidence instead of forced section counts', async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockResponse(bedrockPayload(
      `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
    )));

    await analyzeTranscript('Meeting', 'Transcript');

    const requestBody = JSON.parse(String(
      bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input.body,
    ));
    const prompt = requestBody.messages[0].content[0].text as string;

    expect(prompt).not.toMatch(/List 3-6 agenda_items/i);
    expect(prompt).not.toMatch(/5-9 logical themes/i);
    expect(prompt).not.toMatch(/Write 4-8 next_steps/i);
    expect(prompt).toContain('Do not split, pad, or add themes to reach a target count.');
    expect(prompt).toContain('Use [] when the transcript contains no supported discussion points.');
    expect(prompt).toContain('Do not convert suggestions, observations, risks, or open questions into action items.');
    expect(prompt).toContain('Use [] when no explicit next steps or follow-up commitments were discussed.');
  });

  test('allows only evidence-based broad role inference and preserves action state', async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockResponse(bedrockPayload(
      `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
    )));

    await analyzeTranscript('Meeting', 'Transcript');

    const requestBody = JSON.parse(String(
      bedrockMock.commandCalls(InvokeModelCommand)[0].args[0].input.body,
    ));
    const prompt = requestBody.messages[0].content[0].text as string;

    expect(prompt).toContain('infer a broad functional meeting role only when repeated responsibilities or multiple independent transcript cues support it');
    expect(prompt).toContain('Do not infer seniority, HR grade, or an official job title');
    expect(prompt).toContain('Use "Participant" when the evidence is weak or ambiguous');
    expect(prompt).toContain('Preserve whether work is already completed, in progress, or still planned');
    expect(prompt).toContain('Do not turn completed work into a new action item');
  });

  test('repairs a structural error without paying for a retry', async () => {
    const malformed = JSON.stringify(validResult).replace(
      '"date":"Not specified",',
      '"date":"Not specified"',
    );
    bedrockMock.on(InvokeModelCommand).resolves(bedrockResponse(bedrockPayload(
      `<mom_json>${malformed}</mom_json>`,
    )));

    await expect(analyzeTranscript('Meeting', 'Transcript')).resolves.toEqual(validResult);
    expect(bedrockMock).toHaveReceivedCommandTimes(InvokeModelCommand, 1);
  });

  test('retries an invalid first response and returns the valid second response', async () => {
    bedrockMock.on(InvokeModelCommand)
      .resolvesOnce(bedrockResponse(bedrockPayload('<mom_json>{"title":}</mom_json>')))
      .resolvesOnce(bedrockResponse(bedrockPayload(
        `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
      )));

    await expect(analyzeTranscript('Meeting', 'Transcript')).resolves.toEqual(validResult);
    expect(bedrockMock).toHaveReceivedCommandTimes(InvokeModelCommand, 2);
    const retryBody = JSON.parse(String(
      bedrockMock.commandCalls(InvokeModelCommand)[1].args[0].input.body,
    ));
    const retryPrompt = retryBody.messages[0].content[0].text as string;
    expect(retryPrompt.indexOf('automatic retry 2 of 3')).toBeLessThan(
      retryPrompt.indexOf('<meeting_transcript>'),
    );
    expect(retryPrompt).toContain('</meeting_transcript>');
  });

  test('retries instead of accepting an apparently valid max-token response', async () => {
    bedrockMock.on(InvokeModelCommand)
      .resolvesOnce(bedrockResponse(bedrockPayload(
        `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
        'max_tokens',
      )))
      .resolvesOnce(bedrockResponse(bedrockPayload(
        `<mom_json>${JSON.stringify(validResult)}</mom_json>`,
      )));

    await expect(analyzeTranscript('Meeting', 'Transcript')).resolves.toEqual(validResult);
    expect(bedrockMock).toHaveReceivedCommandTimes(InvokeModelCommand, 2);
  });

  test('returns a stable error after all structural retries are exhausted', async () => {
    bedrockMock.on(InvokeModelCommand).resolves(bedrockResponse(bedrockPayload(
      '<mom_json>{"title":}</mom_json>',
      'end_turn',
    )));

    await expect(analyzeTranscript('Meeting', 'Transcript')).rejects.toThrow(
      'The AI response could not be validated after 3 automatic attempts. Please retry.',
    );
    expect(bedrockMock).toHaveReceivedCommandTimes(InvokeModelCommand, 3);
  });
});
