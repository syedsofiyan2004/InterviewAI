/**
 * The Minutes of Meeting as a real Word document.
 *
 * This exists because a PDF cannot be trimmed. The minutes that go to a client are almost
 * never the minutes the model produced: an internal aside comes out, a risk is reworded, a
 * section is dropped whole. So this renderer is deliberately built out of Word's own
 * constructs rather than a picture of the PDF:
 *
 *  - Real heading styles (`Heading1`/`Heading2`), so the document has a navigable outline and
 *    a section can be collapsed and deleted in one click.
 *  - Real `Table` objects with a header row, so rows can be added, deleted or re-sorted.
 *  - Real numbered lists, so deleting the second agenda item renumbers the rest.
 *
 * Two deliberate differences from `mom-report.ts`, which is left untouched:
 *
 *  - Section order and wording are mirrored, so the two documents are recognisably the same
 *    report; the colours are approximations of the PDF palette in hex.
 *  - Non-ASCII text is preserved. The PDF strips it because pdf-lib's standard fonts are
 *    WinAnsi-only; OOXML is UTF-8, so a name with a diacritic survives here.
 */
import type { MomResult } from '../../schema/mom.js';

/**
 * docx is ~2 MB on disk and the api-handler bundle serves dozens of routes that will never
 * render a document. Loaded on first use and cached for the life of the container, the same
 * way `shared/workbook.ts` treats exceljs.
 */
const importDocx = () => import('docx');

/**
 * Derived from the import expression rather than written as `typeof import('docx')`: the
 * package ships separate ESM and CJS declaration files, and naming the module in a type
 * position picks the CJS one, whose classes are structurally incompatible with the ESM
 * classes the dynamic import actually returns.
 */
type Docx = Awaited<ReturnType<typeof importDocx>>;
type Block = InstanceType<Docx['Paragraph']> | InstanceType<Docx['Table']>;

let cachedDocx: Docx | undefined;
async function loadDocx(): Promise<Docx> {
  const docx = cachedDocx ?? await importDocx();
  cachedDocx = docx;
  return docx;
}

/** Hex equivalents of the PDF palette in `mom-report.ts`. */
const C = {
  ink: '1A293D',
  muted: '6B7A8F',
  border: 'DBE6F0',
  blue: '1F5C9E',
  bluePale: 'F5F9FF',
  green: '1F8F5C',
  red: 'B82E33',
  amber: 'B86E0F',
  purple: '6B47A3',
  gray: '6B7A8F',
  graySoft: 'F5F7F9',
  white: 'FFFFFF',
};

/**
 * Strips only what OOXML cannot carry — the C0 control characters other than tab, newline
 * and carriage return. Everything printable, including non-Latin scripts, is kept.
 */
function clean(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function isUseful(value: string | undefined | null): boolean {
  const text = clean(value).toLowerCase();
  return !!text && text !== 'not specified' && text !== 'n/a';
}

function valueOr(value: string | undefined | null, fallback = 'Not specified'): string {
  return isUseful(value) ? clean(value) : fallback;
}

type CellSpec = string | { text: string; bold?: boolean; color?: string };

function cellSpec(value: CellSpec): { text: string; bold?: boolean; color?: string } {
  return typeof value === 'string' ? { text: value } : value;
}

/** A section heading: real `Heading1`, with a rule under it standing in for the PDF's band. */
function heading(d: Docx, text: string, color: string): Block {
  return new d.Paragraph({
    heading: d.HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 140 },
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 8, color, space: 4 } },
    children: [new d.TextRun({ text: clean(text), bold: true, color, size: 24 })],
  });
}

/** A discussion topic: `Heading2`, so topics nest under their section in the outline. */
function subheading(d: Docx, text: string, suffix?: string): Block {
  const children = [new d.TextRun({ text: clean(text), bold: true, color: C.ink, size: 21 })];
  if (suffix) children.push(new d.TextRun({ text: `   ${clean(suffix)}`, italics: true, color: C.muted, size: 16 }));
  return new d.Paragraph({
    heading: d.HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
    children,
  });
}

function body(
  d: Docx,
  text: string,
  options: { size?: number; color?: string; bold?: boolean; italics?: boolean; after?: number; before?: number; align?: 'center' } = {},
): Block {
  return new d.Paragraph({
    spacing: { before: options.before ?? 0, after: options.after ?? 120 },
    alignment: options.align === 'center' ? d.AlignmentType.CENTER : undefined,
    children: [new d.TextRun({
      text: clean(text),
      size: options.size ?? 19,
      color: options.color ?? C.ink,
      bold: options.bold,
      italics: options.italics,
    })],
  });
}

/**
 * A numbered list on its own `reference`, so each list restarts at 1 and stays renumbering
 * after an item is deleted. Empty lists still render one row, matching the PDF's
 * "Not specified" placeholder rather than leaving a heading with nothing under it.
 */
function numbered(d: Docx, items: string[], reference: string): Block[] {
  const useful = items.filter(isUseful).map(clean);
  const rows = useful.length ? useful : ['Not specified'];
  return rows.map(item => new d.Paragraph({
    numbering: { reference, level: 0 },
    spacing: { after: 60 },
    children: [new d.TextRun({ text: item, size: 19, color: C.ink })],
  }));
}

function tableCell(d: Docx, value: CellSpec, width: number, fill?: string) {
  const spec = cellSpec(value);
  return new d.TableCell({
    width: { size: width, type: d.WidthType.PERCENTAGE },
    shading: fill ? { type: d.ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new d.Paragraph({
      spacing: { before: 0, after: 0 },
      children: [new d.TextRun({
        text: clean(spec.text),
        bold: spec.bold,
        color: spec.color ?? C.ink,
        size: 18,
      })],
    })],
  });
}

/**
 * A header row plus body rows, striped like the PDF. `headerRow: true` on the first row is
 * what makes Word repeat it when the table breaks across pages — without it a long action
 * list loses its column titles on page two.
 */
function table(
  d: Docx,
  columns: { title: string; width: number }[],
  rows: CellSpec[][],
  headerColor: string,
  options: { stripe?: boolean } = {},
): Block {
  const border = { style: d.BorderStyle.SINGLE, size: 4, color: C.border };
  return new d.Table({
    width: { size: 100, type: d.WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new d.TableRow({
        tableHeader: true,
        children: columns.map(column => tableCell(
          d,
          { text: column.title, bold: true, color: C.white },
          column.width,
          headerColor,
        )),
      }),
      ...rows.map((row, index) => new d.TableRow({
        children: columns.map((column, columnIndex) => tableCell(
          d,
          row[columnIndex] ?? '-',
          column.width,
          options.stripe && index % 2 === 1 ? C.bluePale : undefined,
        )),
      })),
    ],
  });
}

/** The PDF's label/value table, used for the sections that are really key-value pairs. */
function labelValue(d: Docx, rows: [string, string][], headerColor = C.gray): Block {
  return table(
    d,
    [{ title: 'Field', width: 26 }, { title: 'Details', width: 74 }],
    rows.map(([label, value]) => [{ text: label, bold: true, color: C.blue }, value]),
    headerColor,
    { stripe: true },
  );
}

function collectDecisions(result: MomResult) {
  return result.discussion_points.flatMap(point => point.decisions || []).filter(decision => isUseful(decision.decision));
}

function collectActions(result: MomResult) {
  return result.discussion_points.flatMap(point => point.action_items || []).filter(action => isUseful(action.task));
}

function hasNextMeeting(value: MomResult['next_meeting']): boolean {
  if (!value) return false;
  return [value.date, value.purpose, value.proposed_agenda, value.prep_required].some(isUseful);
}

/** Same emphasis the PDF gives priority and severity, expressed as colour rather than a glyph. */
function priorityColor(value: string): string {
  if (value === 'High') return C.red;
  if (value === 'Low') return C.green;
  return C.amber;
}

function severityColor(value: string): string {
  if (value === 'H') return C.red;
  if (value === 'L') return C.green;
  return C.amber;
}

/**
 * Builds the Word version of the minutes.
 *
 * Mirrors `generateMomPdfReport`'s signature and section order so a caller can swap one for
 * the other, and so the two files read as the same report in two formats.
 */
export async function generateMomDocxReport(
  result: MomResult,
  options: { projectTitle?: string } = {},
): Promise<Buffer> {
  const d = await loadDocx();
  const projectTitle = valueOr(options.projectTitle, 'General');
  const decisions = collectDecisions(result);
  const actions = collectActions(result);
  const children: Block[] = [];

  // --- Title block.
  children.push(new d.Paragraph({
    heading: d.HeadingLevel.TITLE,
    spacing: { after: 60 },
    border: { bottom: { style: d.BorderStyle.SINGLE, size: 18, color: C.blue, space: 6 } },
    children: [new d.TextRun({ text: 'Minutes of Meeting', bold: true, color: C.blue, size: 46 })],
  }));
  children.push(body(d, `Project: ${projectTitle}`, { bold: true, color: C.blue, size: 21, before: 160, after: 40 }));
  children.push(body(d, valueOr(result.title, 'Meeting Report'), { size: 25, color: C.muted, after: 40 }));
  children.push(body(
    d,
    `${valueOr(result.report_type, 'Minutes of Meeting')} | ${valueOr(result.date)} | Ref: ${valueOr(result.reference_no, 'MOM-001')}`,
    { size: 17, color: C.muted, after: 20 },
  ));
  children.push(body(d, 'Generated by Minfy AI MOM Analyzer', { size: 17, color: C.muted, after: 200 }));

  children.push(labelValue(d, [
    ['Project', projectTitle],
    ['Date', valueOr(result.date)],
    ['Subject', valueOr(result.title, 'Meeting Report')],
    ['Report Type', valueOr(result.report_type, 'Minutes of Meeting')],
  ], C.blue));

  // --- The PDF's metric strip, as a table rather than tiles: the counts are the useful part,
  //     and a table survives being edited in a way six drawn boxes would not.
  children.push(body(d, '', { after: 120 }));
  children.push(table(
    d,
    [
      { title: 'Attendees', width: 17 },
      { title: 'Agenda', width: 16 },
      { title: 'Topics', width: 17 },
      { title: 'Decisions', width: 17 },
      { title: 'Actions', width: 16 },
      { title: 'Risks', width: 17 },
    ],
    [[
      String(result.attendees.length).padStart(2, '0'),
      String(result.agenda_items.filter(isUseful).length).padStart(2, '0'),
      String(result.discussion_points.length).padStart(2, '0'),
      String(decisions.length).padStart(2, '0'),
      String(actions.length).padStart(2, '0'),
      String(result.risks.length).padStart(2, '0'),
    ].map(text => ({ text, bold: true }))],
    C.blue,
  ));

  // --- Meeting Details.
  children.push(heading(d, 'Meeting Details', C.blue));
  children.push(labelValue(d, [
    ['Meeting Title', valueOr(result.title)],
    ['Report Type', valueOr(result.report_type, 'Minutes of Meeting')],
    ['Date & Time', valueOr(result.date)],
    ['Duration', valueOr(result.duration)],
    ['Platform', valueOr(result.platform)],
    ['Reference No.', valueOr(result.reference_no, 'MOM-001')],
    ['Project', projectTitle],
    ['Workstream', valueOr(result.workstream)],
    ['Facilitator', valueOr(result.facilitator)],
    ['Scribe', valueOr(result.scribe)],
    ['Distribution', valueOr(result.distribution, 'All Attendees')],
    ['Issued Date', valueOr(result.issued_date, result.date || 'Not specified')],
  ], C.blue));

  // --- Executive Summary.
  children.push(heading(d, 'Executive Summary', C.blue));
  children.push(new d.Paragraph({
    spacing: { after: 120 },
    shading: { type: d.ShadingType.CLEAR, fill: C.bluePale, color: 'auto' },
    border: { left: { style: d.BorderStyle.SINGLE, size: 18, color: C.blue, space: 8 } },
    children: [new d.TextRun({ text: valueOr(result.overall_summary), size: 19, color: C.ink })],
  }));

  // --- Attendees.
  children.push(heading(d, 'Attendees', C.blue));
  if (result.attendees.some(attendee => !isUseful(attendee.role))) {
    children.push(body(d, 'Some attendee roles were not specified in the transcript; those role cells are shown as "-".', { size: 16, italics: true, color: C.muted }));
  }
  children.push(table(
    d,
    [
      { title: 'Name', width: 31 },
      { title: 'Role', width: 34 },
      { title: 'Organisation', width: 25 },
      { title: 'Attended', width: 10 },
    ],
    (result.attendees.length ? result.attendees : [{ name: 'Not specified' }]).map(attendee => [
      valueOr(attendee.name),
      isUseful(attendee.role) ? clean(attendee.role) : '-',
      isUseful(attendee.organisation) ? clean(attendee.organisation) : '-',
      'Yes',
    ]),
    C.blue,
    { stripe: true },
  ));

  // --- Agenda.
  children.push(heading(d, 'Agenda Items', C.blue));
  children.push(...numbered(d, result.agenda_items, 'agenda'));

  // --- Discussion points. One Heading2 per topic, which is what makes a whole topic
  //     collapsible and deletable in the Word navigation pane.
  children.push(heading(d, 'Discussion Points', C.blue));
  const points = result.discussion_points.length
    ? result.discussion_points
    : [{ topic: 'Not specified', summary: 'Not specified', decisions: [], action_items: [] }];
  points.forEach((point, index) => {
    children.push(subheading(
      d,
      `${index + 1}. ${valueOr(point.topic, 'Discussion Point')}`,
      isUseful(point.raised_by) ? `Raised by: ${clean(point.raised_by)}` : undefined,
    ));
    children.push(body(d, valueOr(point.summary)));
  });

  // --- Decisions.
  children.push(heading(d, 'Decisions Made', C.green));
  children.push(table(
    d,
    [
      { title: 'Ref', width: 10 },
      { title: 'Decision', width: 36 },
      { title: 'Rationale', width: 31 },
      { title: 'Decided By', width: 23 },
    ],
    decisions.length
      ? decisions.map((decision, index) => [
        { text: `DEC-${String(index + 1).padStart(3, '0')}`, bold: true, color: C.blue },
        clean(decision.decision),
        valueOr(decision.rationale, '-'),
        valueOr(decision.decided_by, '-'),
      ])
      : [['-', 'No decisions recorded.', '-', '-']],
    C.green,
    { stripe: true },
  ));

  // --- Actions.
  children.push(heading(d, 'Action Items', C.amber));
  children.push(table(
    d,
    [
      { title: 'Ref', width: 10 },
      { title: 'Action Description', width: 37 },
      { title: 'Owner', width: 19 },
      { title: 'Due Date', width: 16 },
      { title: 'Priority', width: 18 },
    ],
    actions.length
      ? actions.map((action, index) => {
        const priority = action.priority || 'Medium';
        return [
          { text: `ACT-${String(index + 1).padStart(3, '0')}`, bold: true, color: C.blue },
          clean(action.task),
          valueOr(action.owner, 'Unassigned'),
          valueOr(action.due_date, 'TBD'),
          { text: priority, bold: priority === 'High', color: priorityColor(priority) },
        ];
      })
      : [['-', 'No actions recorded.', '-', '-', '-']],
    C.amber,
    { stripe: true },
  ));

  // --- Risks.
  children.push(heading(d, 'Risks And Blockers', C.red));
  children.push(table(
    d,
    [
      { title: 'Ref', width: 10 },
      { title: 'Description', width: 29 },
      { title: 'Like.', width: 8 },
      { title: 'Impact', width: 9 },
      { title: 'Owner', width: 16 },
      { title: 'Mitigation', width: 28 },
    ],
    result.risks.length
      ? result.risks.map((risk, index) => {
        const likelihood = risk.likelihood || 'M';
        const impact = risk.impact || 'M';
        return [
          { text: `RSK-${String(index + 1).padStart(3, '0')}`, bold: true, color: C.blue },
          clean(risk.description),
          { text: likelihood, bold: likelihood === 'H', color: severityColor(likelihood) },
          { text: impact, bold: impact === 'H', color: severityColor(impact) },
          valueOr(risk.owner, '-'),
          valueOr(risk.mitigation, 'To be determined'),
        ];
      })
      : [['-', 'No risks recorded.', '-', '-', '-', '-']],
    C.red,
    { stripe: true },
  ));

  // --- Next steps.
  children.push(heading(d, 'Next Steps', C.green));
  children.push(...numbered(d, result.next_steps, 'next-steps'));

  // --- Next meeting, only when the transcript actually said something about one.
  if (hasNextMeeting(result.next_meeting)) {
    children.push(heading(d, 'Next Meeting', C.purple));
    children.push(labelValue(d, [
      ['Date & Time', valueOr(result.next_meeting?.date, 'To be confirmed')],
      ['Purpose', valueOr(result.next_meeting?.purpose)],
      ['Proposed Agenda', valueOr(result.next_meeting?.proposed_agenda)],
      ['Prep Required', valueOr(result.next_meeting?.prep_required)],
    ], C.purple));
  }

  // --- Previous actions.
  children.push(heading(d, 'Review of Previous Meeting Actions', C.gray));
  const previous = result.previous_actions || [];
  children.push(table(
    d,
    [
      { title: 'Ref', width: 12 },
      { title: 'Action', width: 47 },
      { title: 'Owner', width: 24 },
      { title: 'Status', width: 17 },
    ],
    previous.length
      ? previous.map(action => [
        valueOr(action.ref, '-'),
        clean(action.action),
        valueOr(action.owner, '-'),
        valueOr(action.status, '-'),
      ])
      : [['-', 'No previous meeting actions - this is the first recorded meeting for this workstream.', '-', '-']],
    C.gray,
    { stripe: true },
  ));

  // --- Distribution and sign-off.
  children.push(heading(d, 'Distribution & Sign-Off', C.gray));
  children.push(labelValue(d, [
    ['Prepared By', `${valueOr(result.scribe)} | ${valueOr(result.issued_date, result.date || 'Not specified')}`],
    ['Reviewed By', 'Pending'],
    ['Distributed To', result.attendees.map(attendee => clean(attendee.name)).filter(Boolean).join(', ') || 'All Attendees'],
    ['Review Deadline', 'Please raise any objections within 48 hours. Silence implies acceptance.'],
    ['Storage Location', 'SharePoint / Confluence'],
  ]));
  children.push(body(d, '- End of Minutes of Meeting -', { bold: true, before: 240, after: 40, align: 'center' }));
  children.push(body(d, 'This document is confidential and intended solely for the addressees listed above.', {
    size: 15, color: C.muted, align: 'center',
  }));

  const doc = new d.Document({
    title: `Minutes of Meeting - ${valueOr(result.title, 'Meeting Report')}`,
    description: `Minutes of Meeting for ${projectTitle}`,
    creator: 'Minfy AI MOM Analyzer',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 19, color: C.ink } },
      },
    },
    // One reference per list so each restarts at 1; a shared reference would make Next Steps
    // continue from the last agenda number.
    numbering: {
      config: ['agenda', 'next-steps'].map(reference => ({
        reference,
        levels: [{
          level: 0,
          format: d.LevelFormat.DECIMAL,
          text: '%1.',
          alignment: d.AlignmentType.START,
          style: { paragraph: { indent: { left: 420, hanging: 240 } } },
        }],
      })),
    },
    sections: [{
      properties: { page: { margin: { top: 800, bottom: 800, left: 800, right: 800 } } },
      footers: {
        default: new d.Footer({
          children: [new d.Paragraph({
            alignment: d.AlignmentType.CENTER,
            children: [
              new d.TextRun({ text: `${projectTitle}  |  ${valueOr(result.title, 'Meeting Report')}  |  Page `, size: 15, color: C.muted }),
              new d.TextRun({ children: [d.PageNumber.CURRENT], size: 15, color: C.muted }),
              new d.TextRun({ text: ' of ', size: 15, color: C.muted }),
              new d.TextRun({ children: [d.PageNumber.TOTAL_PAGES], size: 15, color: C.muted }),
            ],
          })],
        }),
      },
      children,
    }],
  });

  return await d.Packer.toBuffer(doc);
}
