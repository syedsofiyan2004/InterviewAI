import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { InterviewIntelligenceRecord } from '../api-handler/intelligence-integrations.js';

type Color = ReturnType<typeof rgb>;
type Evaluation = NonNullable<InterviewIntelligenceRecord['aiEvaluation']>;
type CompetencyRating = NonNullable<Evaluation['candidateEvaluation']['competencyRatings']>[number];

const MM = 2.83465;
const PAGE = {
  width: 210 * MM,
  height: 297 * MM,
  left: 18 * MM,
  right: 18 * MM,
  top: 16 * MM,
  bottom: 16 * MM,
};

const C = {
  navy: rgb(0.055, 0.102, 0.18),
  navy2: rgb(0.08, 0.14, 0.24),
  teal: rgb(0.02, 0.51, 0.47),
  tealSoft: rgb(0.91, 0.98, 0.97),
  green: rgb(0.03, 0.55, 0.34),
  greenSoft: rgb(0.92, 0.98, 0.95),
  amber: rgb(0.82, 0.43, 0.03),
  amberSoft: rgb(1, 0.97, 0.9),
  red: rgb(0.79, 0.12, 0.17),
  redSoft: rgb(1, 0.94, 0.94),
  gray: rgb(0.39, 0.45, 0.55),
  graySoft: rgb(0.95, 0.96, 0.98),
  ink: rgb(0.08, 0.12, 0.2),
  text: rgb(0.24, 0.29, 0.38),
  muted: rgb(0.39, 0.45, 0.55),
  line: rgb(0.86, 0.89, 0.93),
  white: rgb(1, 1, 1),
};

function value(input: unknown, fallback = 'Not specified'): string {
  const cleaned = String(input ?? '').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function asDate(epoch: number): string {
  return new Date(epoch).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function words(input: unknown): string[] {
  return value(input, '').split(' ').filter(Boolean);
}

function wrapTokens(input: unknown): string[] {
  const text = value(input, '');
  return text.match(/[^\s/-]+[/-]?|\s+/g) || [];
}

function forceBreakToken(token: string, font: PDFFont, size: number, width: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const char of token) {
    const next = `${current}${char}`;
    if (current && font.widthOfTextAtSize(next, size) > width) {
      pieces.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function wrap(input: unknown, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  const pushLine = () => {
    const clean = line.trimEnd();
    if (clean) lines.push(clean);
    line = '';
  };

  for (const rawToken of wrapTokens(input)) {
    const token = /^\s+$/.test(rawToken) ? ' ' : rawToken;
    if (!line && token === ' ') continue;

    const next = `${line}${token}`;
    if (font.widthOfTextAtSize(next.trimEnd(), size) <= width) {
      line = next;
      continue;
    }

    if (line) pushLine();
    if (token === ' ') continue;

    const pieces = forceBreakToken(token.trimStart(), font, size, width);
    pieces.forEach((piece, index) => {
      if (index < pieces.length - 1) {
        lines.push(piece);
      } else {
        line = piece;
      }
    });
  }

  if (line) pushLine();
  return lines.length ? lines : ['-'];
}

const QUOTE_STOPWORDS = new Set([
  'and', 'are', 'for', 'from', 'has', 'have', 'how', 'into', 'not', 'the', 'this', 'that', 'with',
  'well', 'work', 'role', 'skill', 'skills', 'advisory', 'experience', 'candidate', 'interview',
  'data', 'management', 'project', 'system', 'systems', 'support',
]);

function quoteKeywords(input: unknown): string[] {
  const rawTokens = String(input || '').match(/[A-Za-z0-9+#.]+/g) || [];
  const keywords = rawTokens
    .map((raw) => ({ raw, normalized: raw.toLowerCase() }))
    .filter(({ raw, normalized }) => {
      if (QUOTE_STOPWORDS.has(normalized)) return false;
      if (normalized.length >= 3) return true;
      return /^[A-Z0-9]{2,}$/.test(raw);
    })
    .map(({ normalized }) => normalized);
  return Array.from(new Set(keywords)).slice(0, 6);
}

function sentenceTokens(input: string): Set<string> {
  return new Set((input.match(/[A-Za-z0-9+#.]+/g) || []).map((token) => token.toLowerCase()));
}

function transcriptQuote(transcript: unknown, requirement: unknown): string | undefined {
  const keywords = quoteKeywords(requirement);
  if (!keywords.length) return undefined;

  const minimumMatches = keywords.length === 1 ? 1 : 2;
  const sentences = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const found = sentences.find((sentence) => {
    const tokens = sentenceTokens(sentence);
    const matches = keywords.filter((keyword) => tokens.has(keyword)).length;
    return matches >= minimumMatches;
  });
  if (!found) return undefined;
  return trimWords(found, 24);
}

function truncateWithEllipsis(line: string, font: PDFFont, size: number, width: number): string {
  const ellipsis = '...';
  let output = line.trim();
  while (output && font.widthOfTextAtSize(`${output}${ellipsis}`, size) > width) {
    output = output.slice(0, -1).trimEnd();
  }
  return output ? `${output}${ellipsis}` : ellipsis;
}

function visibleLines(input: unknown, font: PDFFont, size: number, width: number, maxLines?: number): string[] {
  const lines = wrap(input, font, size, width);
  if (!maxLines || lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  clipped[clipped.length - 1] = truncateWithEllipsis(clipped[clipped.length - 1], font, size, width);
  return clipped;
}

function clampScore(input: unknown): number {
  const numeric = Number(input);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(10, Math.round(numeric * 10) / 10)) : 0;
}

function clampPercent(input: unknown): number {
  const numeric = Number(input);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

function isUuidLike(input: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input ?? '').trim());
}

function reviewerName(record: InterviewIntelligenceRecord): string {
  if (!record.approved?.approvedBy) return 'Pending';
  if (isUuidLike(record.approved.approvedBy)) return 'Panel approver recorded';
  return record.approved.approvedBy;
}

function recommendationLabel(input: string): string {
  const normalized = input.replace(/[\s-]+/g, '_').toLowerCase();
  const labels: Record<string, string> = {
    strongly_recommend: 'Strongly recommend',
    recommend: 'Recommend',
    proceed_with_reservations: 'Proceed with reservations',
    additional_assessment_required: 'Additional assessment required',
    not_recommended: 'Not recommended',
    strongly_not_recommended: 'Strongly not recommended',
    proceed: 'Recommend',
    hold: 'Additional assessment required',
    reject: 'Not recommended',
    needs_review: 'Additional assessment required',
  };
  return labels[normalized] || 'Additional assessment required';
}

function recommendationTone(input: string): { color: Color; soft: Color } {
  const normalized = input.replace(/[\s-]+/g, '_').toLowerCase();
  if (['strongly_recommend', 'recommend', 'proceed'].includes(normalized)) return { color: C.green, soft: C.greenSoft };
  if (['not_recommended', 'strongly_not_recommended', 'reject'].includes(normalized)) return { color: C.red, soft: C.redSoft };
  return { color: C.amber, soft: C.amberSoft };
}

function statusLabel(status: CompetencyRating['status']): string {
  const labels: Record<CompetencyRating['status'], string> = {
    exceeds_standard: 'Exceeds standard',
    meets_standard: 'Meets standard',
    partially_demonstrated: 'Partially demonstrated',
    below_standard: 'Below standard',
    not_assessed: 'Not assessed',
  };
  return labels[status];
}

function statusTone(status: CompetencyRating['status']): { color: Color; soft: Color } {
  if (status === 'exceeds_standard' || status === 'meets_standard') return { color: C.green, soft: C.greenSoft };
  if (status === 'partially_demonstrated') return { color: C.amber, soft: C.amberSoft };
  if (status === 'below_standard') return { color: C.red, soft: C.redSoft };
  return { color: C.gray, soft: C.graySoft };
}

function fallbackStatus(item: { covered: 'yes' | 'partial' | 'no'; evidence: string }): CompetencyRating['status'] {
  if (item.covered === 'yes') return 'meets_standard';
  if (item.covered === 'partial') return 'partially_demonstrated';
  return /\b(not asked|not assessed|missing|insufficient|not covered|not discussed|no explicit)\b/i.test(item.evidence)
    ? 'not_assessed'
    : 'below_standard';
}

function competencyRatings(evaluation: Evaluation): CompetencyRating[] {
  if (evaluation.candidateEvaluation.competencyRatings?.length) {
    return evaluation.candidateEvaluation.competencyRatings.slice(0, 5);
  }
  return evaluation.coverageMatrix.slice(0, 5).map((entry) => {
    const status = fallbackStatus(entry);
    return {
      competency: entry.jdSkill,
      requirement: entry.jdSkill,
      status,
      rating: status === 'not_assessed' ? null : entry.covered === 'yes' ? 8 : entry.covered === 'partial' ? 5 : 3,
      questionAsked: entry.askedBy?.length ? `Asked by ${entry.askedBy.join(', ')}` : 'Not assessed',
      relevantResponse: entry.evidence,
      followUpProbes: [],
      performanceBenchmark: `Concrete role-specific example showing ownership, trade-offs, validation, and outcome for ${entry.jdSkill}.`,
      ratingJustification: entry.evidence,
      evidenceConfidence: entry.covered === 'yes' ? 'high' : entry.covered === 'partial' ? 'medium' : 'low',
      requiredFollowUp: entry.covered === 'yes' ? 'None' : `Assess ${entry.jdSkill} with a focused role-specific follow-up.`,
    };
  });
}

function candidateScore(evaluation: Evaluation): number {
  if (Number.isFinite(Number(evaluation.candidateEvaluation.candidateScore))) {
    return clampScore(evaluation.candidateEvaluation.candidateScore);
  }
  const assessed = competencyRatings(evaluation)
    .map((entry) => Number(entry.rating))
    .filter((rating) => Number.isFinite(rating));
  if (!assessed.length) return 0;
  return clampScore(assessed.reduce((sum, rating) => sum + rating, 0) / assessed.length);
}

function jdCoverage(evaluation: Evaluation): number {
  if (Number.isFinite(Number(evaluation.candidateEvaluation.jdCoveragePercent))) {
    return clampPercent(evaluation.candidateEvaluation.jdCoveragePercent);
  }
  const ratings = competencyRatings(evaluation);
  if (!ratings.length) return 0;
  const points = ratings.reduce((sum, entry) => {
    if (entry.status === 'exceeds_standard' || entry.status === 'meets_standard') return sum + 1;
    if (entry.status === 'partially_demonstrated') return sum + 0.5;
    return sum;
  }, 0);
  return Math.round((points / ratings.length) * 100);
}

function competencyDistribution(ratings: CompetencyRating[]) {
  return ratings.reduce(
    (acc, entry) => ({
      verified: acc.verified + (entry.status === 'exceeds_standard' || entry.status === 'meets_standard' ? 1 : 0),
      partial: acc.partial + (entry.status === 'partially_demonstrated' ? 1 : 0),
      below: acc.below + (entry.status === 'below_standard' ? 1 : 0),
      notAssessed: acc.notAssessed + (entry.status === 'not_assessed' ? 1 : 0),
    }),
    { verified: 0, partial: 0, below: 0, notAssessed: 0 },
  );
}

function trimWords(input: unknown, limit: number): string {
  const parts = words(input);
  if (parts.length <= limit) return parts.join(' ');
  return `${parts.slice(0, limit).join(' ')}...`;
}

function safeConcern(input: string): string {
  return input
    .replace(/\b(divorce|medical|illness|health|family|personal|marital|age|accent|commute)\b[^.]*\.?/gi, 'Additional job-related evidence is required.')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generateIntelligencePdfReport(record: InterviewIntelligenceRecord): Promise<Buffer> {
  if (!record.aiEvaluation) throw new Error('An intelligence evaluation is required before generating a report.');

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = PAGE.width - PAGE.left - PAGE.right;
  const evaluation = record.aiEvaluation;
  const candidate = evaluation.candidateEvaluation;
  const ratings = competencyRatings(evaluation);
  const distribution = competencyDistribution(ratings);
  const recommendation = recommendationLabel(candidate.recommendation);
  const recommendationColors = recommendationTone(candidate.recommendation);
  const score = candidateScore(evaluation);
  const coverage = jdCoverage(evaluation);
  const source = record.transcript?.source === 'teams_live' || record.teams.mode === 'live' ? 'Microsoft Teams' : 'Manual transcript';
  const reportStatus = record.status === 'approved' ? 'Human review completed' : 'Human review required';

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.top;

  const footer = (target: PDFPage) => {
    target.drawLine({ start: { x: PAGE.left, y: 28 }, end: { x: PAGE.width - PAGE.right, y: 28 }, thickness: 0.5, color: C.line });
    target.drawText('Minfy MiMo AI Hub - Interview Intelligence', { x: PAGE.left, y: 16, size: 8, font: regular, color: C.muted });
    target.drawText(`Page ${pdf.getPageCount()}`, { x: PAGE.width - PAGE.right - 32, y: 16, size: 8, font: regular, color: C.muted });
  };

  const newPage = () => {
    footer(page);
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - PAGE.top;
  };

  const ensure = (height: number) => {
    if (y - height < PAGE.bottom + 20) newPage();
  };

  const drawWrapped = (
    input: unknown,
    x: number,
    top: number,
    width: number,
    options: { size?: number; lineHeight?: number; font?: PDFFont; color?: Color; maxLines?: number } = {},
  ) => {
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? 14.5;
    const font = options.font ?? regular;
    const lines = visibleLines(input, font, size, width, options.maxLines);
    lines.forEach((line, index) => page.drawText(line, {
      x,
      y: top - index * lineHeight,
      size,
      font,
      color: options.color ?? C.text,
    }));
    return lines.length * lineHeight;
  };

  const drawLines = (
    lines: string[],
    x: number,
    top: number,
    options: { size?: number; lineHeight?: number; font?: PDFFont; color?: Color } = {},
  ) => {
    const size = options.size ?? 10;
    const lineHeight = options.lineHeight ?? 14.5;
    const font = options.font ?? regular;
    lines.forEach((line, index) => page.drawText(line, {
      x,
      y: top - index * lineHeight,
      size,
      font,
      color: options.color ?? C.text,
    }));
    return lines.length * lineHeight;
  };

  const section = (title: string) => {
    ensure(44);
    y -= 10;
    page.drawText(title, { x: PAGE.left, y, size: 14.5, font: bold, color: C.ink });
    y -= 10;
    page.drawLine({ start: { x: PAGE.left, y }, end: { x: PAGE.width - PAGE.right, y }, thickness: 0.6, color: C.line });
    y -= 20;
  };

  const field = (label: string, textValue: string, x: number, top: number, width: number) => {
    page.drawText(label.toUpperCase(), { x, y: top, size: 7.8, font: bold, color: C.muted });
    drawWrapped(textValue, x, top - 15, width, { size: 10, lineHeight: 13.5, maxLines: 2 });
  };

  const panel = (height: number, color: Color, soft: Color) => {
    page.drawRectangle({ x: PAGE.left, y: y - height, width: contentWidth, height, color: soft, borderColor: color, borderWidth: 0.65 });
    page.drawRectangle({ x: PAGE.left, y: y - height, width: 5, height, color });
  };

  const measureBulletList = (items: string[], width: number, maxLines = 2, lineHeight = 14.5) => {
    return items.reduce((height, item) => {
      const lines = visibleLines(item, regular, 10, width - 14, maxLines);
      return height + Math.max(18, lines.length * lineHeight + 6);
    }, 0);
  };

  const ensureCursor = (cursor: number, height: number) => {
    if (cursor - height < PAGE.bottom + 20) {
      newPage();
      return y;
    }
    return cursor;
  };

  const drawBulletList = (
    items: string[],
    x: number,
    startY: number,
    width: number,
    color: Color,
    options: { updateGlobalY?: boolean; allowPageBreaks?: boolean; maxLines?: number; lineHeight?: number } = {},
  ) => {
    let cursor = startY;
    const maxLines = options.maxLines ?? 2;
    const lineHeight = options.lineHeight ?? 14.5;
    for (const item of items) {
      const lines = visibleLines(item, regular, 10, width - 14, maxLines);
      const requiredHeight = Math.max(18, lines.length * lineHeight + 6);
      if (options.allowPageBreaks !== false) {
        cursor = ensureCursor(cursor, requiredHeight);
      }
      page.drawCircle({ x: x + 3, y: cursor + 3, size: 2, color });
      lines.forEach((line, index) => page.drawText(line, { x: x + 14, y: cursor - index * lineHeight, size: 10, font: regular, color: C.text }));
      cursor -= requiredHeight;
    }
    if (options.updateGlobalY) y = cursor;
    return startY - cursor;
  };

  // Page 1: decision summary.
  page.drawRectangle({ x: 0, y: PAGE.height - 136, width: PAGE.width, height: 136, color: C.navy });
  page.drawText('MINFY MIMO AI HUB / INTERVIEW INTELLIGENCE', { x: PAGE.left, y: PAGE.height - 30, size: 8.5, font: bold, color: C.teal });
  drawWrapped(record.candidate.name, PAGE.left, PAGE.height - 64, contentWidth - 170, { size: 29, lineHeight: 31, font: bold, color: C.white, maxLines: 2 });
  page.drawText(value(record.job.title), { x: PAGE.left, y: PAGE.height - 111, size: 12, font: regular, color: rgb(0.78, 0.86, 0.93) });
  field('Date', asDate(evaluation.generatedAt), PAGE.width - PAGE.right - 150, PAGE.height - 58, 150);
  field('Source', source, PAGE.width - PAGE.right - 150, PAGE.height - 92, 150);
  page.drawText(reportStatus, { x: PAGE.width - PAGE.right - 150, y: PAGE.height - 122, size: 9, font: bold, color: C.teal });
  y = PAGE.height - 168;

  const reason = trimWords(candidate.recommendationReason || candidate.candidateScoreReason, 45);
  const reasonLines = visibleLines(reason, regular, 10.2, contentWidth - 32, 3);
  const recommendationPanelHeight = Math.max(76, 28 + 23 + reasonLines.length * 14.5 + 16);
  ensure(recommendationPanelHeight);
  panel(recommendationPanelHeight, recommendationColors.color, recommendationColors.soft);
  page.drawText(recommendation, { x: PAGE.left + 16, y: y - 28, size: 19, font: bold, color: recommendationColors.color });
  drawLines(reasonLines, PAGE.left + 16, y - 51, { size: 10.2, lineHeight: 14.5, font: regular, color: C.text });
  y -= recommendationPanelHeight + 24;

  const findings = (candidate.evidenceBullets?.length ? candidate.evidenceBullets : [
    candidate.candidateScoreReason || `Candidate AI score is ${score.toFixed(1)}/10 from assessed competencies.`,
    `${distribution.verified} demonstrated, ${distribution.partial} partially demonstrated, ${distribution.below} below standard, ${distribution.notAssessed} not assessed.`,
    candidate.recommendationReason || 'Human review is required before final hiring action.',
  ]).slice(0, 3).map((item) => trimWords(item, 22));
  page.drawText('Key findings', { x: PAGE.left, y, size: 13, font: bold, color: C.ink });
  y -= 22;
  drawBulletList(findings, PAGE.left, y, contentWidth, recommendationColors.color, { updateGlobalY: true });
  y -= 14;

  const confidenceHeight = 86;
  ensure(confidenceHeight);
  page.drawRectangle({ x: PAGE.left, y: y - confidenceHeight, width: contentWidth, height: confidenceHeight, color: C.white, borderColor: C.line, borderWidth: 0.65 });
  page.drawText('Assessment confidence', { x: PAGE.left + 14, y: y - 20, size: 12, font: bold, color: C.ink });
  const metricWidth = (contentWidth - 42) / 3;
  [
    ['Evidence confidence', value(candidate.evidenceConfidence, coverage >= 70 ? 'High' : coverage >= 35 ? 'Medium' : 'Low')],
    ['JD-question coverage', `${coverage}%`],
    ['Candidate AI score', `${score.toFixed(1)}/10`],
  ].forEach(([label, metric], index) => {
    const x = PAGE.left + 14 + index * (metricWidth + 7);
    page.drawText(metric, { x, y: y - 50, size: 17, font: bold, color: C.ink });
    page.drawText(label.toUpperCase(), { x, y: y - 65, size: 7.8, font: bold, color: C.muted });
  });
  page.drawText(
    `Competencies: ${distribution.verified} demonstrated / ${distribution.partial} partial / ${distribution.below} below standard / ${distribution.notAssessed} not assessed`,
    { x: PAGE.left + 14, y: y - 78, size: 8.5, font: regular, color: C.muted },
  );
  y -= confidenceHeight + 20;

  const nextAction = trimWords(candidate.nextAction || (recommendation === 'Additional assessment required'
    ? 'Run a focused follow-up interview before making a final hiring decision.'
    : 'Panel approver should review the evidence and record the final decision.'), 34);
  const nextActionLines = visibleLines(nextAction, regular, 10, contentWidth - 32, 3);
  const nextActionPanelHeight = Math.max(52, 20 + 16 + nextActionLines.length * 14 + 14);
  ensure(nextActionPanelHeight);
  panel(nextActionPanelHeight, C.teal, C.tealSoft);
  page.drawText('Next action', { x: PAGE.left + 16, y: y - 20, size: 11, font: bold, color: C.teal });
  drawLines(nextActionLines, PAGE.left + 16, y - 36, { size: 10, lineHeight: 14, font: regular, color: C.text });
  y -= nextActionPanelHeight + 22;

  const half = (contentWidth - 18) / 2;
  const metaTop = y;
  [
    ['Candidate', record.candidate.name],
    ['Role', record.job.title],
    ['Report review status', reportStatus],
    ['Reviewer', reviewerName(record)],
  ].forEach(([label, textValue], index) => {
    const x = PAGE.left + (index % 2) * (half + 18);
    const top = metaTop - Math.floor(index / 2) * 40;
    field(label, textValue, x, top, half);
  });
  footer(page);

  // Page 2: competency matrix.
  newPage();
  section('Competency matrix');
  page.drawText(
    `${distribution.verified} demonstrated, ${distribution.partial} partial, ${distribution.below} below standard, ${distribution.notAssessed} not assessed.`,
    { x: PAGE.left, y, size: 10.2, font: regular, color: C.text },
  );
  y -= 26;

  const widths = [34 * MM, 27 * MM, 57 * MM, contentWidth - (34 + 27 + 57) * MM];
  const headers = ['Competency', 'Status', 'Evidence observed', 'Required follow-up'];
  page.drawRectangle({ x: PAGE.left, y: y - 24, width: contentWidth, height: 24, color: C.navy });
  let x = PAGE.left;
  headers.forEach((header, index) => {
    page.drawText(header, { x: x + 6, y: y - 16, size: 8.5, font: bold, color: C.white });
    x += widths[index];
  });
  y -= 24;

  for (const rating of ratings) {
    const tone = statusTone(rating.status);
    const lineHeight = 12.4;
    const rowValues = [
      value(rating.competency),
      statusLabel(rating.status),
      value(rating.relevantResponse || rating.ratingJustification),
      value(rating.requiredFollowUp),
    ];
    const rowLines = rowValues.map((cell, index) => {
      const font = index <= 1 ? bold : regular;
      return visibleLines(cell, font, 9.3, widths[index] - 12);
    });
    const maxLineCount = Math.max(...rowLines.map((lines) => lines.length));
    const height = Math.max(22 * MM, maxLineCount * lineHeight + 24);
    ensure(height + 4);
    page.drawRectangle({ x: PAGE.left, y: y - height, width: contentWidth, height, color: C.white, borderColor: C.line, borderWidth: 0.5 });
    page.drawRectangle({ x: PAGE.left, y: y - height, width: 4, height, color: tone.color });
    x = PAGE.left;
    rowLines.forEach((lines, index) => {
      const font = index <= 1 ? bold : regular;
      const color = index === 1 ? tone.color : index === 0 ? C.ink : C.text;
      drawLines(lines, x + 7, y - 13, { size: 9.3, lineHeight, font, color });
      x += widths[index];
      if (index < rowValues.length - 1) {
        page.drawLine({ start: { x, y }, end: { x, y: y - height }, thickness: 0.4, color: C.line });
      }
    });
    y -= height;
  }

  // Page 3: strengths, evidence gaps, process, approval.
  newPage();

  // What the interviewer chose to cover this round. Makes the report fair — a
  // competency not selected was never asked about, and a later panel can see
  // which ground is already covered.
  const selectedTopics = (record.questionPlan?.selectedTopics || []).filter(Boolean);
  if (selectedTopics.length) {
    section('Topics covered in this round');
    const askedCount = record.questionPlan?.requestedQuestionCount;
    drawWrapped(
      `The interviewer selected these focus areas before the conversation${askedCount ? `, planning ${askedCount} role question${askedCount === 1 ? '' : 's'}` : ''}. Competencies outside this list were not scheduled for this round.`,
      PAGE.left,
      y,
      contentWidth,
      { size: 10, lineHeight: 13.5, maxLines: 3 },
    );
    y -= 38;
    const topicItems = selectedTopics.slice(0, 12).map((topic) => value(topic));
    const topicsHeight = measureBulletList(topicItems, contentWidth, 1);
    ensure(topicsHeight + 20);
    drawBulletList(topicItems, PAGE.left, y, contentWidth, C.navy, { allowPageBreaks: true });
    y -= topicsHeight + 12;
  }

  section('Strengths and evidence still required');
  const colGap = 8 * MM;
  const colWidth = (contentWidth - colGap) / 2;
  const strengths = (candidate.strengths.length ? candidate.strengths : ['No distinct demonstrated strengths were returned by the AI review.']).slice(0, 5).map((item) => value(item));
  const gaps = (candidate.concerns.length ? candidate.concerns : ratings.filter((item) => item.status !== 'meets_standard' && item.status !== 'exceeds_standard').map((item) => item.requiredFollowUp))
    .slice(0, 5)
    .map((item) => safeConcern(value(item)));
  const leftItems = strengths;
  const rightItems = gaps.length ? gaps : ['No additional evidence gaps were returned.'];
  const usedLeft = measureBulletList(leftItems, colWidth);
  const usedRight = measureBulletList(rightItems, colWidth);
  ensure(Math.max(usedLeft, usedRight) + 52);
  const listTop = y;
  page.drawText('Demonstrated strengths', { x: PAGE.left, y: listTop, size: 11.5, font: bold, color: C.green });
  page.drawText('Evidence still required', { x: PAGE.left + colWidth + colGap, y: listTop, size: 11.5, font: bold, color: C.amber });
  drawBulletList(leftItems, PAGE.left, listTop - 22, colWidth, C.green, { allowPageBreaks: false });
  drawBulletList(rightItems, PAGE.left + colWidth + colGap, listTop - 22, colWidth, C.amber, { allowPageBreaks: false });
  y = listTop - Math.max(usedLeft, usedRight) - 34;

  section('Interviewer and panel quality');
  const panelMembers = evaluation.interviewerEvaluations.slice(0, 4);
  if (panelMembers.length) {
    const cardGap = 10;
    const cardHeight = 58;
    const cardsPerRow = panelMembers.length === 1 ? 1 : 2;
    const cardWidth = cardsPerRow === 1 ? contentWidth : (contentWidth - cardGap) / 2;
    ensure(Math.ceil(panelMembers.length / cardsPerRow) * (cardHeight + cardGap) + 10);
    panelMembers.forEach((member, index) => {
      const row = Math.floor(index / cardsPerRow);
      const col = index % cardsPerRow;
      const xPos = PAGE.left + col * (cardWidth + cardGap);
      const yTop = y - row * (cardHeight + cardGap);
      const memberScore = clampScore(member.panelScore);
      const tone = memberScore >= 7 ? C.green : memberScore >= 5 ? C.amber : C.red;
      page.drawRectangle({ x: xPos, y: yTop - cardHeight, width: cardWidth, height: cardHeight, color: C.white, borderColor: C.line, borderWidth: 0.65 });
      page.drawRectangle({ x: xPos, y: yTop - cardHeight, width: 4, height: cardHeight, color: tone });
      page.drawText('PANEL MEMBER', { x: xPos + 14, y: yTop - 17, size: 7.6, font: bold, color: C.muted });
      drawLines(visibleLines(value(member.name, 'Panel member'), bold, 10.8, cardWidth - 110, 2), xPos + 14, yTop - 32, { size: 10.8, lineHeight: 13, font: bold, color: C.ink });
      page.drawText(`${memberScore.toFixed(1)}/10`, { x: xPos + cardWidth - 78, y: yTop - 24, size: 18, font: bold, color: tone });
      page.drawText('PANEL SCORE', { x: xPos + cardWidth - 78, y: yTop - 40, size: 7.2, font: bold, color: C.muted });
      page.drawText(`${clampPercent(member.jdCoveragePercent)}% JD coverage`, { x: xPos + cardWidth - 78, y: yTop - 52, size: 7.8, font: regular, color: C.text });
    });
    y -= Math.ceil(panelMembers.length / cardsPerRow) * (cardHeight + cardGap) + 10;
  }
  const processItems = evaluation.interviewerEvaluations.slice(0, 4).flatMap((member) => [
    `${value(member.name, 'Panel member')}: panel quality ${clampScore(member.panelScore).toFixed(1)}/10, ${clampPercent(member.jdCoveragePercent)}% JD coverage, ${member.followUpQuality.replace(/_/g, ' ')} follow-up quality.`,
    ...member.observations.slice(0, 1).map((item) => `${value(member.name, 'Panel member')}: ${value(item)}`),
  ]).slice(0, 6);
  drawBulletList(processItems.length ? processItems : ['No panel-quality observations were returned.'], PAGE.left, y, contentWidth, C.teal, { updateGlobalY: true });
  y -= 12;

  if (evaluation.caseEvaluation) {
    section('Case interview signal');
    const caseLines = visibleLines(evaluation.caseEvaluation.summary, regular, 9.8, contentWidth - 32, 3);
    const casePanelHeight = Math.max(58, 20 + 18 + caseLines.length * 13.5 + 14);
    ensure(casePanelHeight);
    panel(casePanelHeight, clampScore(evaluation.caseEvaluation.overallScore) >= 7 ? C.green : clampScore(evaluation.caseEvaluation.overallScore) >= 5 ? C.amber : C.red, C.graySoft);
    page.drawText(`Case score ${clampScore(evaluation.caseEvaluation.overallScore).toFixed(1)}/10`, { x: PAGE.left + 16, y: y - 20, size: 11, font: bold, color: C.ink });
    drawLines(caseLines, PAGE.left + 16, y - 38, { size: 9.8, lineHeight: 13.5, font: regular, color: C.text });
    y -= casePanelHeight + 20;
  }

  section('Human review audit');
  const auditRows = [
    ['Report review status', reportStatus],
    ['Candidate recommendation', recommendation],
    ['Reviewer', reviewerName(record)],
    ['Review date', record.approved ? asDate(record.approved.approvedAt) : 'Pending'],
    ['Reviewer comments', record.approved?.notes || 'Reviewer comments pending.'],
  ];
  for (const [label, textValue] of auditRows) {
    ensure(28);
    page.drawText(label.toUpperCase(), { x: PAGE.left, y, size: 7.8, font: bold, color: C.muted });
    drawWrapped(textValue, PAGE.left + 130, y, contentWidth - 130, { size: 9.8, lineHeight: 13.5, maxLines: 2 });
    y -= 28;
  }

  const quotes = ratings
    .filter((item) => item.status !== 'not_assessed')
    .map((item) => ({
      competency: item.competency,
      quote: transcriptQuote(record.transcript?.rawText, item.requirement || item.competency),
    }))
    .filter((item): item is { competency: string; quote: string } => Boolean(item.quote))
    .slice(0, 6);
  if (quotes.length) {
    newPage();
    section('Evidence appendix');
    page.drawText('Short transcript excerpts are included only where they support role-related conclusions.', { x: PAGE.left, y, size: 10, font: regular, color: C.text });
    y -= 24;
    for (const item of quotes) {
      const height = 50;
      ensure(height + 8);
      page.drawRectangle({ x: PAGE.left, y: y - height, width: contentWidth, height, color: C.graySoft, borderColor: C.line, borderWidth: 0.5 });
      page.drawText(item.competency, { x: PAGE.left + 12, y: y - 16, size: 8.5, font: bold, color: C.teal });
      drawWrapped(`"${item.quote}"`, PAGE.left + 12, y - 32, contentWidth - 24, { size: 9.5, lineHeight: 12.5, maxLines: 2 });
      y -= height + 8;
    }
  }

  footer(page);
  return Buffer.from(await pdf.save());
}
