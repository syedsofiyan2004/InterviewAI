import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import type { InterviewIntelligenceRecord } from '../api-handler/intelligence-integrations.js';

type Palette = ReturnType<typeof palette>;

const PAGE = { width: 595.28, height: 841.89, left: 46, right: 46, top: 52, bottom: 48 };

function palette() {
  return {
    navy: rgb(0.055, 0.102, 0.18),
    navySoft: rgb(0.08, 0.15, 0.25),
    teal: rgb(0.02, 0.51, 0.47),
    tealLight: rgb(0.92, 0.98, 0.96),
    violet: rgb(0.29, 0.25, 0.72),
    ink: rgb(0.12, 0.15, 0.2),
    text: rgb(0.24, 0.29, 0.36),
    muted: rgb(0.39, 0.45, 0.54),
    line: rgb(0.86, 0.89, 0.93),
    surface: rgb(0.975, 0.98, 0.99),
    white: rgb(1, 1, 1),
    success: rgb(0.03, 0.58, 0.35),
    warning: rgb(0.82, 0.43, 0.03),
    danger: rgb(0.79, 0.12, 0.17),
  };
}

function words(value: unknown): string[] {
  return String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function wrap(value: unknown, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of words(value)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

function compact(value: unknown, fallback = 'Not available'): string {
  const text = String(value || '').trim();
  return text || fallback;
}

function transcriptQuote(transcript: unknown, requirement: unknown): string | undefined {
  const keywords = String(requirement || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 4);
  if (!keywords.length) return undefined;

  const candidates = String(transcript || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
  const match = candidates.find((candidate) => {
    const normalised = candidate.toLowerCase();
    return keywords.some((keyword) => normalised.includes(keyword));
  });
  if (!match) return undefined;
  return match.length > 180 ? `${match.slice(0, 177).trim()}...` : match.trim();
}

function evidenceWithQuote(evidence: unknown, transcript: unknown, requirement: unknown): string {
  const text = compact(evidence);
  if (/["“][^"”]+["”]/.test(text)) return text;
  const quote = transcriptQuote(transcript, requirement);
  return quote ? `${text} Transcript: "${quote}"` : text;
}

export async function generateIntelligencePdfReport(record: InterviewIntelligenceRecord): Promise<Buffer> {
  if (!record.aiEvaluation) throw new Error('An intelligence evaluation is required before generating a report.');

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const C = palette();
  const usableWidth = PAGE.width - PAGE.left - PAGE.right;
  let page: PDFPage;
  let y = 0;

  const footer = (target: PDFPage) => {
    target.drawLine({ start: { x: PAGE.left, y: 31 }, end: { x: PAGE.width - PAGE.right, y: 31 }, thickness: 0.5, color: C.line });
    target.drawText('MINFY MIMO AI HUB  |  INTERVIEW INTELLIGENCE', { x: PAGE.left, y: 19, size: 6.5, font: regular, color: C.muted });
    target.drawText('Confidential - Internal hiring use only', { x: PAGE.width / 2 - 72, y: 19, size: 6.5, font: regular, color: C.muted });
    target.drawText(`Page ${pdf.getPageCount()}`, { x: PAGE.width - PAGE.right - 32, y: 19, size: 6.5, font: regular, color: C.muted });
  };

  const startContentPage = () => {
    if (page) footer(page);
    page = pdf.addPage([PAGE.width, PAGE.height]);
    page.drawRectangle({ x: 0, y: PAGE.height - 34, width: PAGE.width, height: 34, color: C.navy });
    page.drawText('MINFY MIMO AI HUB  /  INTERVIEW INTELLIGENCE', { x: PAGE.left, y: PAGE.height - 21, size: 7.5, font: bold, color: C.white });
    page.drawText(compact(record.job.title), { x: PAGE.width - PAGE.right - 180, y: PAGE.height - 21, size: 7.5, font: regular, color: rgb(0.75, 0.84, 0.92), maxWidth: 180 });
    y = PAGE.height - 58;
  };

  const ensure = (height: number) => {
    if (y - height < PAGE.bottom + 18) startContentPage();
  };

  const paragraph = (value: unknown, options: { size?: number; color?: ReturnType<typeof rgb>; width?: number; x?: number; lineHeight?: number; gap?: number } = {}) => {
    const size = options.size ?? 9;
    const lineHeight = options.lineHeight ?? 14;
    const x = options.x ?? PAGE.left;
    const width = options.width ?? usableWidth;
    const lines = wrap(value, regular, size, width);
    ensure(lines.length * lineHeight + 4);
    for (const line of lines) {
      page.drawText(line, { x, y, size, font: regular, color: options.color ?? C.text });
      y -= lineHeight;
    }
    y -= options.gap ?? 4;
  };

  const section = (number: string, title: string, color = C.teal) => {
    // Keep each section heading with at least one row of its content.
    ensure(88);
    y -= 12;
    page.drawRectangle({ x: PAGE.left, y: y - 16, width: 20, height: 20, color });
    page.drawText(number, { x: PAGE.left + 5.8, y: y - 10, size: 8, font: bold, color: C.white });
    page.drawRectangle({ x: PAGE.left + 27, y: y - 16, width: usableWidth - 27, height: 20, color: C.surface });
    page.drawText(title.toUpperCase(), { x: PAGE.left + 37, y: y - 10, size: 8.5, font: bold, color: C.navy });
    y -= 28;
  };

  const stat = (x: number, label: string, value: string, color: ReturnType<typeof rgb>) => {
    page.drawRectangle({ x, y: PAGE.height - 266, width: 74, height: 54, color: C.surface, borderColor: C.line, borderWidth: 0.5 });
    page.drawRectangle({ x, y: PAGE.height - 216, width: 74, height: 4, color });
    page.drawText(value, { x: x + 10, y: PAGE.height - 247, size: 16, font: bold, color: C.navy });
    page.drawText(label, { x: x + 10, y: PAGE.height - 259, size: 6.3, font: bold, color: C.muted });
  };

  const labelValue = (label: string, value: unknown, x: number, top: number, width: number) => {
    page.drawText(label.toUpperCase(), { x, y: top, size: 6.5, font: bold, color: C.muted });
    const lines = wrap(compact(value), regular, 8, width);
    lines.slice(0, 2).forEach((line, index) => page.drawText(line, { x, y: top - 12 - (index * 10), size: 8, font: regular, color: C.ink }));
  };

  // Cover page
  page = pdf.addPage([PAGE.width, PAGE.height]);
  page.drawRectangle({ x: 0, y: PAGE.height - 218, width: PAGE.width, height: 218, color: C.navy });
  page.drawText('MINFY MIMO AI HUB  /  INTERVIEW INTELLIGENCE', { x: PAGE.left, y: PAGE.height - 49, size: 8, font: bold, color: rgb(0.5, 0.9, 0.83) });
  const nameLines = wrap(compact(record.candidate.name, 'Candidate'), bold, 27, usableWidth);
  nameLines.slice(0, 2).forEach((line, index) => page.drawText(line, { x: PAGE.left, y: PAGE.height - 91 - (index * 32), size: 27, font: bold, color: C.white }));
  page.drawText(compact(record.job.title), { x: PAGE.left, y: PAGE.height - 161, size: 11, font: regular, color: rgb(0.77, 0.84, 0.91), maxWidth: usableWidth });
  page.drawText('AI-assisted hiring report - Human review required', { x: PAGE.left, y: PAGE.height - 187, size: 8, font: regular, color: rgb(0.59, 0.74, 0.79) });

  const evaluation = record.aiEvaluation;
  const decisions = evaluation.candidateEvaluation.recommendation.replace('_', ' ').toUpperCase();
  const covered = evaluation.coverageMatrix.filter((item) => item.covered === 'yes').length;
  const panelScores = evaluation.interviewerEvaluations
    .map((member) => Number.isFinite(Number(member.panelScore))
      ? Number(member.panelScore)
      : Math.round(member.jdCoveragePercent / 10))
    .filter((score) => Number.isFinite(score));
  const average = panelScores.length ? (panelScores.reduce((sum, score) => sum + score, 0) / panelScores.length).toFixed(1) : '-';
  const stats: Array<{ label: string; value: string; color: ReturnType<typeof rgb> }> = [
    { label: 'PANEL', value: String(record.panel.length), color: C.teal },
    { label: 'SKILLS', value: `${covered}/${evaluation.coverageMatrix.length}`, color: C.violet },
    { label: 'PANEL SCORE', value: average, color: C.teal },
    { label: 'DECISION', value: decisions === 'PROCEED' ? 'GO' : decisions === 'REJECT' ? 'NO' : 'REVIEW', color: decisions === 'PROCEED' ? C.success : decisions === 'REJECT' ? C.danger : C.warning },
  ];
  stats.forEach((item, index) => stat(PAGE.left + index * 85, item.label, item.value, item.color));

  const metaTop = PAGE.height - 310;
  page.drawText('INTERVIEW DETAILS', { x: PAGE.left, y: metaTop, size: 8, font: bold, color: C.navy });
  page.drawLine({ start: { x: PAGE.left, y: metaTop - 9 }, end: { x: PAGE.width - PAGE.right, y: metaTop - 9 }, thickness: 0.7, color: C.line });
  labelValue('Candidate', record.candidate.name, PAGE.left, metaTop - 30, 210);
  labelValue('Role', record.job.title, PAGE.left + 260, metaTop - 30, 230);
  labelValue('Interview source', record.teams.mode === 'live' ? 'Microsoft Teams' : 'Manual transcript', PAGE.left, metaTop - 82, 210);
  labelValue('Report status', record.status === 'approved' ? 'Approved by human reviewer' : 'Awaiting human approval', PAGE.left + 260, metaTop - 82, 230);
  labelValue('Prepared', new Date(evaluation.generatedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }), PAGE.left, metaTop - 134, 210);
  labelValue('Panel calibration', evaluation.panelCalibration?.humanReviewRequired ? 'Discussion recommended' : 'No material variance identified', PAGE.left + 260, metaTop - 134, 230);
  page.drawRectangle({ x: PAGE.left, y: 205, width: usableWidth, height: 92, color: C.tealLight });
  page.drawRectangle({ x: PAGE.left, y: 205, width: 4, height: 92, color: C.teal });
  page.drawText('EXECUTIVE POSITION', { x: PAGE.left + 16, y: 275, size: 7, font: bold, color: C.teal });
  const reason = wrap(evaluation.candidateEvaluation.recommendationReason, regular, 9, usableWidth - 32);
  reason.slice(0, 4).forEach((line, index) => page.drawText(line, { x: PAGE.left + 16, y: 255 - (index * 14), size: 9, font: regular, color: C.ink }));
  footer(page);

  startContentPage();
  section('1', 'Candidate assessment');
  paragraph(evaluation.candidateEvaluation.summary, { size: 9, lineHeight: 15, gap: 8 });
  page.drawRectangle({ x: PAGE.left, y: y - 50, width: usableWidth, height: 50, color: C.surface, borderColor: C.line, borderWidth: 0.5 });
  page.drawText('RECOMMENDATION', { x: PAGE.left + 12, y: y - 18, size: 7, font: bold, color: C.muted });
  page.drawText(decisions, { x: PAGE.left + 12, y: y - 35, size: 12, font: bold, color: decisions === 'PROCEED' ? C.success : decisions === 'REJECT' ? C.danger : C.warning });
  y -= 65;

  section('2', 'Evidence by job requirement');
  if (evaluation.coverageMatrix.length) {
    for (const item of evaluation.coverageMatrix) {
      const level = item.covered === 'yes' ? C.success : item.covered === 'partial' ? C.warning : C.danger;
      const requirementWidth = 145;
      const evidenceX = PAGE.left + requirementWidth + 14;
      const evidenceWidth = usableWidth - requirementWidth - 14;
      const requirementLines = wrap(compact(item.jdSkill), bold, 8.5, requirementWidth - 24);
      const evidenceLines = wrap(evidenceWithQuote(item.evidence, record.transcript?.rawText, item.jdSkill), regular, 8, evidenceWidth - 24);
      const height = Math.max(58, (requirementLines.length * 11) + 32, (evidenceLines.length * 11) + 33);
      ensure(height + 6);
      page.drawRectangle({ x: PAGE.left, y: y - height, width: usableWidth, height, color: C.white, borderColor: C.line, borderWidth: 0.5 });
      page.drawRectangle({ x: PAGE.left, y: y - height, width: 4, height, color: level });
      page.drawLine({ start: { x: evidenceX - 8, y: y - 7 }, end: { x: evidenceX - 8, y: y - height + 7 }, thickness: 0.45, color: C.line });
      requirementLines.forEach((line, index) => page.drawText(line, { x: PAGE.left + 14, y: y - 16 - (index * 11), size: 8.5, font: bold, color: C.ink }));
      page.drawText(item.covered.toUpperCase(), { x: PAGE.left + 14, y: y - 20 - (requirementLines.length * 11), size: 6.5, font: bold, color: level });
      page.drawText('TRANSCRIPT EVIDENCE', { x: evidenceX, y: y - 16, size: 6.2, font: bold, color: C.muted });
      evidenceLines.forEach((line, index) => page.drawText(line, { x: evidenceX, y: y - 30 - (index * 11), size: 8, font: regular, color: C.text }));
      y -= height + 6;
    }
  } else paragraph('No job requirement coverage was recorded.', { color: C.muted });

  section('3', 'Strengths and areas to review');
  const columns = [
    { title: 'STRENGTHS', items: evaluation.candidateEvaluation.strengths, color: C.success },
    { title: 'AREAS TO REVIEW', items: evaluation.candidateEvaluation.concerns, color: C.warning },
  ];
  const columnWidth = (usableWidth - 12) / 2;
  const maxItems = Math.max(...columns.map((column) => Math.max(1, column.items.length)));
  for (let index = 0; index < maxItems; index += 1) {
    const leftLines = wrap(columns[0].items[index] || '-', regular, 8, columnWidth - 20);
    const rightLines = wrap(columns[1].items[index] || '-', regular, 8, columnWidth - 20);
    const rowHeight = Math.max(28, Math.max(leftLines.length, rightLines.length) * 11 + 12);
    ensure(rowHeight + (index === 0 ? 22 : 0));
    if (index === 0) {
      page.drawText(columns[0].title, { x: PAGE.left, y, size: 7, font: bold, color: columns[0].color });
      page.drawText(columns[1].title, { x: PAGE.left + columnWidth + 12, y, size: 7, font: bold, color: columns[1].color });
      y -= 10;
    }
    [leftLines, rightLines].forEach((lines, columnIndex) => {
      const x = PAGE.left + columnIndex * (columnWidth + 12);
      page.drawRectangle({ x, y: y - rowHeight, width: columnWidth, height: rowHeight, color: C.surface, borderColor: C.line, borderWidth: 0.5 });
      page.drawCircle({ x: x + 9, y: y - 12, size: 2.3, color: columns[columnIndex].color });
      lines.forEach((line, lineIndex) => page.drawText(line, { x: x + 16, y: y - 16 - (lineIndex * 11), size: 8, font: regular, color: C.text }));
    });
    y -= rowHeight + 6;
  }

  section('4', 'Interviewer and panel review', C.violet);
  for (const interviewer of evaluation.interviewerEvaluations) {
    const observation = interviewer.observations.join(' ');
    const score = Math.max(0, Math.min(10, Number.isFinite(Number(interviewer.panelScore))
      ? Number(interviewer.panelScore)
      : Math.round(interviewer.jdCoveragePercent / 10)));
    const scoreColor = score >= 7 ? C.success : score >= 5 ? C.warning : C.danger;
    const leftWidth = 146;
    const contentX = PAGE.left + leftWidth + 16;
    const contentWidth = usableWidth - leftWidth - 16;
    const scoreReason = wrap(
      interviewer.panelScoreReason || 'Based on role-question coverage visible in the transcript.',
      regular,
      7.5,
      contentWidth,
    );
    const lines = wrap(observation || 'No role-specific interviewer observations were returned.', regular, 8, contentWidth);
    const height = Math.max(70, (scoreReason.length + lines.length) * 11 + 34);
    ensure(height + 6);
    page.drawRectangle({ x: PAGE.left, y: y - height, width: usableWidth, height, color: C.white, borderColor: C.line, borderWidth: 0.5 });
    page.drawLine({ start: { x: contentX - 9, y: y - 7 }, end: { x: contentX - 9, y: y - height + 7 }, thickness: 0.45, color: C.line });
    page.drawText(interviewer.name, { x: PAGE.left + 12, y: y - 17, size: 8.5, font: bold, color: C.ink, maxWidth: 130 });
    page.drawText(`PANEL SCORE  ${score.toFixed(1)} / 10`, { x: PAGE.left + 12, y: y - 31, size: 7, font: bold, color: scoreColor });
    page.drawText(`${interviewer.questionsAskedCount} role questions`, { x: PAGE.left + 12, y: y - 43, size: 7, font: regular, color: C.muted });
    page.drawText(`${interviewer.jdCoveragePercent}% JD coverage`, { x: PAGE.left + 12, y: y - 54, size: 7, font: regular, color: C.teal });
    page.drawText('SCORE BASIS', { x: contentX, y: y - 16, size: 6.2, font: bold, color: C.muted });
    scoreReason.forEach((line, index) => page.drawText(line, { x: contentX, y: y - 29 - (index * 10), size: 7.5, font: regular, color: C.text }));
    const observationStart = y - 33 - (scoreReason.length * 10);
    lines.forEach((line, index) => page.drawText(line, { x: contentX, y: observationStart - (index * 11), size: 8, font: regular, color: C.text }));
    y -= height + 6;
  }
  if (evaluation.panelCalibration) {
    const calibration = wrap(evaluation.panelCalibration.summary, regular, 8, usableWidth - 24);
    const calibrationHeight = Math.max(62, calibration.length * 11 + 29);
    ensure(calibrationHeight + 8);
    page.drawRectangle({ x: PAGE.left, y: y - calibrationHeight, width: usableWidth, height: calibrationHeight, color: C.tealLight, borderColor: C.line, borderWidth: 0.5 });
    page.drawText('PANEL CALIBRATION', { x: PAGE.left + 12, y: y - 17, size: 7, font: bold, color: C.teal });
    calibration.forEach((line, index) => page.drawText(line, { x: PAGE.left + 12, y: y - 32 - (index * 11), size: 8, font: regular, color: C.text }));
    y -= calibrationHeight + 10;
  }

  section('5', 'Human approval', C.navySoft);
  paragraph(record.approved?.notes || 'This AI-assisted report must be reviewed by the hiring panel before a final employment decision is made.', { size: 8.5, lineHeight: 14, color: C.text, gap: 8 });
  page.drawRectangle({ x: PAGE.left, y: y - 40, width: usableWidth, height: 40, color: C.surface, borderColor: C.line, borderWidth: 0.5 });
  page.drawText(record.status === 'approved' ? 'APPROVED BY HUMAN REVIEWER' : 'AWAITING HUMAN REVIEW', { x: PAGE.left + 12, y: y - 18, size: 8, font: bold, color: record.status === 'approved' ? C.success : C.warning });
  page.drawText(record.approved ? new Date(record.approved.approvedAt).toLocaleString('en-GB') : 'No approval timestamp recorded', { x: PAGE.left + 12, y: y - 31, size: 7, font: regular, color: C.muted });
  footer(page);

  return Buffer.from(await pdf.save());
}
