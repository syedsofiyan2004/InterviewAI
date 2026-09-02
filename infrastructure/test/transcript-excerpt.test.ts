import { CONTEXT_CHAR_BUDGET } from '../lambdas/chat/context/shared';
import { TRANSCRIPT_EXCERPT_BUDGET, transcriptExcerpt } from '../lambdas/shared/transcript-excerpt';

/**
 * The transcript excerpt, and whether its marker can be trusted.
 *
 * Two properties carry the whole design. The first is that the excerpt is *two-ended*: a
 * `slice(0, budget)` would satisfy every length check in this file and throw away the half
 * of an interview where the outcome is stated, so the true first line and the true last
 * line are asserted directly rather than inferred from a size. The second is that the
 * omitted count is *exact*: the model is handed that number and will quote it, so a marker
 * that is merely plausible is worse than no marker at all.
 *
 * Every test feeds an already-normalised transcript unless the test is about
 * normalisation, because the arithmetic below is checked against the length of the input
 * string and that only means anything when `normalise` leaves it alone.
 */

const MARKER = /\n\.\.\. (\d+) characters omitted from the middle \.\.\.\n/;

/** LF endings, no trailing spaces, no blank-line runs, no surrounding whitespace. */
function transcript(turns: number): string {
  const lines = ['Interviewer: Good morning, and thanks for making the time. I am Priya, platform team.'];
  for (let index = 0; index < turns; index += 1) {
    lines.push(`Candidate: On the Kubernetes migration I owned node pool sizing for workstream ${index}.`);
    lines.push(`Interviewer: And what did the rollback plan look like for workstream ${index}, concretely?`);
  }
  lines.push('Candidate: Thank you, and I look forward to hearing about the next steps.');
  return lines.join('\n');
}

/** Splits an excerpt back into the three things it claims to be. */
function parts(excerpt: string | undefined) {
  expect(excerpt).toBeDefined();
  const match = excerpt!.match(MARKER);
  expect(match).not.toBeNull();
  const [marker, count] = match!;
  const [head, tail] = excerpt!.split(marker);
  return { head, tail, omitted: Number(count) };
}

describe('a transcript that is not there', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['spaces and tabs only', '   \t  '],
    ['newlines only', '\n\n \n\t\n'],
  ])('%s returns undefined rather than an empty excerpt', (_label, input) => {
    // The caller distinguishes "no transcript" from "a transcript, excerpted" and says a
    // different sentence for each; an empty string would be reported as the second.
    expect(transcriptExcerpt(input)).toBeUndefined();
  });
});

describe('a transcript inside the budget', () => {
  test('comes back whole, with no marker claiming something was cut', () => {
    const text = [
      'Interviewer: Tell me about the migration you led.',
      'Candidate: We moved 1,500 VMs across nine months.',
      'Interviewer: What broke?',
    ].join('\n');

    expect(transcriptExcerpt(text)).toBe(text);
  });

  test('keeps a blank line as a paragraph break but collapses a run of them', () => {
    // Trailing spaces and long blank runs are noise from whatever produced the file. One
    // blank line is not: it is where the recording changed subject or speaker.
    const excerpt = transcriptExcerpt('Interviewer: One.   \n\nCandidate: Two.\n\n\n\n\nInterviewer: Three.\n\n');

    expect(excerpt).toBe('Interviewer: One.\n\nCandidate: Two.\n\nInterviewer: Three.');
  });
});

describe('a transcript over the budget', () => {
  test('stays inside the budget and carries the marker exactly once', () => {
    const excerpt = transcriptExcerpt(transcript(300))!;

    expect(excerpt.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_BUDGET);
    // Once, not twice: a second marker would mean a second omission nobody counted, and
    // the arithmetic in the next test would be checking only one of them.
    expect(excerpt.match(new RegExp(MARKER, 'g'))).toHaveLength(1);
  });

  test('the omitted count accounts for every character that is missing', () => {
    const text = transcript(300);

    const { head, tail, omitted } = parts(transcriptExcerpt(text));

    // The invariant that makes the marker a fact rather than a decoration: what is shown
    // plus what is claimed missing has to be the whole transcript, to the character.
    expect(head.length + omitted + tail.length).toBe(text.length);
    expect(omitted).toBeGreaterThan(0);
  });

  test('opens on the true first line and closes on the true last line', () => {
    const text = transcript(300);
    const lines = text.split('\n');

    const excerpt = transcriptExcerpt(text)!;

    // A plain slice(0, budget) passes every length assertion in this file while losing the
    // end of the interview, which is where a recommendation and the next steps are said.
    expect(excerpt.startsWith(lines[0])).toBe(true);
    expect(excerpt.endsWith(lines[lines.length - 1])).toBe(true);
  });

  test('cuts on line boundaries, so neither end begins or ends mid-turn', () => {
    const text = transcript(300);
    const lines = text.split('\n');

    const { head, tail } = parts(transcriptExcerpt(text));

    // A speaker turn sliced in half reads as a different statement from the one made:
    // "I would not deploy that without" is not a shorter version of what was said.
    expect(lines).toContain(head.slice(head.lastIndexOf('\n') + 1));
    expect(lines).toContain(tail.slice(0, tail.indexOf('\n')));
    expect(text.charAt(head.length)).toBe('\n');
    expect(text.charAt(text.length - tail.length - 1)).toBe('\n');
  });

  test('keeps the speaker labels on their own lines instead of collapsing to a paragraph', () => {
    const { head, tail } = parts(transcriptExcerpt(transcript(300)));

    // The property a whitespace collapse would quietly destroy. With the line structure
    // gone the model cannot attribute a sentence to a speaker, which is most of what it
    // is asked to do with a transcript.
    for (const half of [head, tail]) {
      expect(half).toContain('\n');
      for (const line of half.split('\n')) {
        expect(line).toMatch(/^(Interviewer|Candidate): /);
      }
    }
  });

  test('falls back to a word boundary when no line break is anywhere near the cut', () => {
    const oneLongLine = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');

    const { head, tail } = parts(transcriptExcerpt(oneLongLine, 500));

    // One unbroken paragraph is what a machine transcription without diarisation looks
    // like, and it is the case where the line search has nothing to find.
    expect(head).toMatch(/word\d+$/);
    expect(tail).toMatch(/^word\d+/);
    expect(oneLongLine.charAt(head.length)).toBe(' ');
  });

  test('respects the budget even when there is no whitespace to cut on at all', () => {
    const unbroken = 'x'.repeat(20_000);

    const excerpt = transcriptExcerpt(unbroken, 1_000)!;
    const { head, tail, omitted } = parts(excerpt);

    // Both boundary searches fail here and the fallback is a hard cut. That still has to
    // land inside the budget, and still has to be counted honestly.
    expect(excerpt.length).toBeLessThanOrEqual(1_000);
    expect(head.length + omitted + tail.length).toBe(unbroken.length);
  });

  test('normalises CRLF input, so no carriage return reaches the model', () => {
    const excerpt = transcriptExcerpt(transcript(300).split('\n').join('\r\n'))!;

    // A .txt transcript uploaded from Windows arrives this way, and a \r on every line
    // spends budget on characters that carry nothing.
    expect(excerpt).not.toContain('\r');
    expect(excerpt.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_BUDGET);
  });
});

describe('budgets a caller should not have asked for', () => {
  test('a budget of 250 still yields both ends rather than one fragment', () => {
    const text = transcript(300);

    const excerpt = transcriptExcerpt(text, 250)!;
    const { head, tail, omitted } = parts(excerpt);

    expect(excerpt.length).toBeLessThanOrEqual(250);
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(head.length + omitted + tail.length).toBe(text.length);
  });

  test.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['a negative budget', -1_000],
    ['a budget below the sensible minimum', 199],
  ])('%s falls back to the default rather than returning nothing', (_label, budget) => {
    const text = transcript(300);

    // A caller bug should cost a slightly wrong size, never the transcript itself: an
    // undefined return here is reported upstream as "this interview has no transcript".
    expect(transcriptExcerpt(text, budget)).toBe(transcriptExcerpt(text));
    expect(transcriptExcerpt(text, budget)!.length).toBeLessThanOrEqual(TRANSCRIPT_EXCERPT_BUDGET);
  });
});

describe('the default budget', () => {
  test('is a third of the chat context budget it has to share', () => {
    // Written as a literal in transcript-excerpt.ts on purpose, to keep that module free
    // of chat-context imports, which leaves this the only place the two can be seen to
    // still agree. Its comment says this is the second place to look when the context
    // budget moves; this assertion is what makes that instruction enforceable.
    expect(TRANSCRIPT_EXCERPT_BUDGET * 3).toBe(CONTEXT_CHAR_BUDGET);
  });
});
