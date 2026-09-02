/**
 * One transcript, cut to a size a context window can hold, and honest about the cut.
 *
 * A transcript is the only field on an evaluation with no natural upper bound. Forty
 * minutes of interview is 25,000-40,000 characters; a panel round is several times that.
 * The chat's entire context block is capped at 24,000 characters (`CONTEXT_CHAR_BUDGET`
 * in lambdas/chat/context/shared.ts), so a transcript handed over whole does not merely
 * fill that window, it *is* that window — and the clamp at the end of a context builder
 * would then trim away the scores, the dimension breakdown and the quoted evidence,
 * which are the parts of an evaluation anyone actually cites. Hence an excerpt; and
 * hence a marker saying so, because the rule this repo already follows for bounded
 * tables holds just as firmly here: a truncated block must never read as a complete one.
 *
 * **Head and tail, not the first N characters.** A transcript is not uniformly
 * informative along its length. The opening carries the introductions, the interviewer
 * framing the role and the agenda for the session — including which speaker label is
 * whom, without which nothing said later can be attributed to anybody. The end carries
 * the outcome: the closing assessment, the candidate's own questions, the next steps,
 * and whatever was said once the prepared questions ran out. The middle is the body of
 * the questioning, and it is also the part the evaluation has already summarised for the
 * model in its dimension breakdown and its quoted evidence. A plain `slice(0, budget)`
 * keeps the introductions and throws away the outcome, which is the worse half to lose.
 *
 * This module sits in lambdas/shared/ rather than beside the chat context because the
 * api-handler Lambda excerpts transcripts too. It therefore stays free of chat-context
 * imports — the budget above is named in prose here and nowhere in code — and free of
 * AWS clients and of I/O. Fetching the bytes is the caller's job; this is a pure
 * function of a string, which is also what makes it directly testable.
 */

/**
 * A third of the chat's 24,000-character context budget.
 *
 * The other two thirds are not spare. A completed evaluation's own sections — overview,
 * executive summary, dimension breakdown, strengths, areas for review, quoted evidence,
 * fit-and-gap against the JD, panel assessment — run to several thousand characters
 * before a transcript is added, and a rich one can approach the budget unaided. Eight
 * thousand characters is around 1,300 words, roughly ten minutes of interview speech
 * spread across the two ends, which is enough for the questions this exists to answer —
 * "what did they actually say about Kubernetes", "was this recorded after the interview
 * had already happened" — without pushing the scores out of the window to get there.
 *
 * Written as a literal rather than derived from CONTEXT_CHAR_BUDGET because of the
 * dependency rule above. If that budget moves, this is the second place to look.
 */
export const TRANSCRIPT_EXCERPT_BUDGET = 8_000;

/**
 * Sixty percent of the excerpt to the opening, forty to the close.
 *
 * Weighted forwards rather than split evenly because the head has to establish who is
 * speaking before the tail can be read as anything but disembodied lines, and because
 * "how did the interview open" is a question users ask on its own. Weighted only
 * slightly, because a recommendation, when one is said out loud at all, is said at the
 * end.
 */
const HEAD_SHARE = 0.6;

/**
 * How far back from a cut this will look for a line break to cut on instead.
 *
 * Generous, because a transcript's lines are speaker turns and one turn can easily run
 * several hundred characters. A tighter window would fall through to the word-boundary
 * search on most real transcripts and leave the excerpt ending mid-sentence, which reads
 * as though the recording stopped there.
 */
const LINE_BOUNDARY_WINDOW = 400;

/** The same idea for a word boundary, which is the fallback when no line break is near. */
const WORD_BOUNDARY_WINDOW = 80;

/**
 * Space held back from the budget for the marker line.
 *
 * Fixed and generous rather than the marker's exact length, which cannot be known until
 * the split is decided and the split depends on it. Reserving 64 characters keeps the
 * whole return value inside `budget` for any omitted count this side of a gigabyte.
 */
const MARKER_RESERVE = 64;

/**
 * Below this a head-and-tail excerpt is not a meaningful thing to produce.
 *
 * A caller asking for less than 200 characters would get two fragments and a marker
 * that between them say nothing, so such a budget is treated as a caller bug and the
 * default is used instead.
 */
const MIN_SENSIBLE_BUDGET = 200;

/**
 * Line endings and runs of blank lines, and nothing else.
 *
 * Deliberately not a whitespace collapse. The line structure and the "Interviewer:" /
 * "Candidate:" labels are what make a transcript readable at all, and flattening them
 * into one paragraph would cost the model its only means of telling who said what — for
 * a transcript that is not cosmetic, it is the content.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The first `limit` characters, backed up to the nearest line or word boundary. */
function takeHead(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const lineBreak = cut.lastIndexOf('\n');
  if (lineBreak > 0 && lineBreak >= limit - LINE_BOUNDARY_WINDOW) return cut.slice(0, lineBreak);
  const space = cut.lastIndexOf(' ');
  if (space > 0 && space >= limit - WORD_BOUNDARY_WINDOW) return cut.slice(0, space);
  return cut;
}

/** The last `limit` characters, moved forward to the nearest line or word boundary. */
function takeTail(text: string, limit: number): string {
  const cut = text.slice(text.length - limit);
  const lineBreak = cut.indexOf('\n');
  if (lineBreak >= 0 && lineBreak <= LINE_BOUNDARY_WINDOW) return cut.slice(lineBreak + 1);
  const space = cut.indexOf(' ');
  if (space >= 0 && space <= WORD_BOUNDARY_WINDOW) return cut.slice(space + 1);
  return cut;
}

/**
 * The opening and the closing of a transcript, with the middle replaced by a count.
 *
 * Returns undefined when there is no transcript to show — no text, or nothing but
 * whitespace — so a caller can distinguish "no transcript" from "a transcript, excerpted"
 * and say the right one. A transcript already inside the budget comes back whole, with
 * line endings normalised and no marker: nothing was omitted, so nothing claims to have
 * been.
 */
export function transcriptExcerpt(
  rawText: string | undefined | null,
  budget?: number,
): string | undefined {
  const text = normalise(rawText || '');
  if (!text) return undefined;

  const cap = typeof budget === 'number' && Number.isFinite(budget) && budget >= MIN_SENSIBLE_BUDGET
    ? Math.floor(budget)
    : TRANSCRIPT_EXCERPT_BUDGET;
  if (text.length <= cap) return text;

  const forContent = cap - MARKER_RESERVE;
  const headBudget = Math.floor(forContent * HEAD_SHARE);
  const head = takeHead(text, headBudget).trimEnd();
  const tail = takeTail(text, forContent - headBudget).trimStart();

  // Counted after the boundary search and the trims rather than from the split, so the
  // number is the exact count of characters missing from what follows: head length plus
  // this plus tail length is the length of the whole transcript, and a reader who checks
  // that arithmetic should find it holds.
  const omitted = text.length - head.length - tail.length;
  return `${head}\n... ${omitted} characters omitted from the middle ...\n${tail}`;
}
