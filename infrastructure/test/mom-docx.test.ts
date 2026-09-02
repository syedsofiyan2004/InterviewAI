import { generateMomDocxReport } from '../lambdas/shared/mom-docx';
import { MomResultSchema, type MomResult } from '../schema/mom';

/**
 * jszip is not a direct dependency: it arrives with docx (and exceljs, and mammoth), which is
 * exactly why it is safe to read the package back with it here - if docx can write a .docx,
 * jszip is installed.
 */
async function unzip(buffer: Buffer) {
  const JSZip = (await import('jszip')).default;
  return await JSZip.loadAsync(buffer);
}

async function entry(buffer: Buffer, path: string): Promise<string> {
  const zip = await unzip(buffer);
  const file = zip.file(path);
  if (!file) throw new Error(`${path} missing from the package`);
  return await file.async('string');
}

/** Visible text only, with tags removed - what a reader actually sees in Word. */
const textOf = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The text of the title and section headings, in document order.
 *
 * Searching the whole document for a section name is not enough: the summary strip's column
 * titles repeat words like "Attendees" and "Risks" before those sections begin, so an order
 * assertion over raw text matches the wrong occurrence.
 */
const headings = (xml: string): string[] => xml
  .split('</w:p>')
  .filter(paragraph => /w:val="(Title|Heading1)"/.test(paragraph))
  .map(textOf);

function result(overrides: Record<string, unknown> = {}): MomResult {
  return MomResultSchema.parse({
    title: 'Rainbow Migration - Weekly Sync',
    date: '30-04-2026',
    overall_summary: 'Landing zone is ready; the SQL cutover slips by a week.',
    attendees: [
      { name: 'Ana Ribeiro', role: 'Programme Manager', organisation: 'Rainbow' },
      { name: 'Karthik R', organisation: 'Minfy' },
    ],
    agenda_items: ['Landing zone sign-off', 'SQL cutover date', 'Cost review'],
    discussion_points: [
      {
        topic: 'Landing zone sign-off',
        raised_by: 'Ana Ribeiro',
        summary: 'All four accounts are provisioned and guardrails are enforced.',
        decisions: [
          { decision: 'Sign off the landing zone', rationale: 'Guardrails verified', decided_by: 'Ana Ribeiro' },
        ],
        action_items: [
          { owner: 'Karthik R', task: 'Publish the guardrail evidence pack', due_date: '05-05-2026', priority: 'High' },
        ],
      },
      {
        topic: 'SQL cutover date',
        summary: 'Licence mapping is unresolved, so the cutover moves to the following weekend.',
        decisions: [{ decision: 'Move cutover to 16-05-2026' }],
        action_items: [
          { owner: 'Priya N', task: 'Confirm SQL Server licence mobility', due_date: '08-05-2026', priority: 'Medium' },
        ],
      },
    ],
    risks: [
      { description: 'Licence mobility may not transfer', likelihood: 'H', impact: 'H', owner: 'Priya N', mitigation: 'Escalate to the Microsoft account team' },
      { description: 'Test window overlaps month-end close', likelihood: 'L', impact: 'M' },
    ],
    next_steps: ['Publish the evidence pack', 'Reconfirm the cutover window'],
    reference_no: 'MOM-014',
    duration: '45 minutes',
    platform: 'Microsoft Teams',
    workstream: 'Migration',
    facilitator: 'Ana Ribeiro',
    scribe: 'Karthik R',
    previous_actions: [
      { ref: 'ACT-003', action: 'Share the discovery inventory', owner: 'Ana Ribeiro', status: 'Closed' },
    ],
    ...overrides,
  });
}

describe('generateMomDocxReport', () => {
  let buffer: Buffer;
  let xml: string;
  let text: string;

  beforeAll(async () => {
    buffer = await generateMomDocxReport(result(), { projectTitle: 'Rainbow Migration' });
    xml = await entry(buffer, 'word/document.xml');
    text = textOf(xml);
  });

  it('produces a real OOXML package rather than a renamed file', async () => {
    const zip = await unzip(buffer);
    const names = Object.keys(zip.files);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('word/styles.xml');
    expect(names).toContain('word/numbering.xml');
    expect(names.some(name => /^word\/footer\d+\.xml$/.test(name))).toBe(true);
  });

  it('carries every section of the PDF, in the same order', () => {
    expect(headings(xml)).toEqual([
      'Minutes of Meeting',
      'Meeting Details',
      'Executive Summary',
      'Attendees',
      'Agenda Items',
      'Discussion Points',
      'Decisions Made',
      'Action Items',
      'Risks And Blockers',
      'Next Steps',
      'Review of Previous Meeting Actions',
      'Distribution &amp; Sign-Off',
    ]);
  });

  it('uses real heading styles so the document has a navigable outline', () => {
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('w:val="Title"');
  });

  it('uses real tables with repeating header rows', () => {
    expect((xml.match(/<w:tbl>/g) || []).length).toBeGreaterThanOrEqual(8);
    expect(xml).toContain('<w:tblHeader');
  });

  it('numbers agenda items and next steps as separate restarting lists', async () => {
    expect(xml).toContain('<w:numPr>');
    // Two distinct numIds in the body is the assertion that matters: one shared id would make
    // Next Steps carry on from the last agenda number instead of restarting at 1.
    const used = new Set(xml.match(/<w:numId w:val="\d+"/g) || []);
    expect(used.size).toBe(2);
    const numbering = await entry(buffer, 'word/numbering.xml');
    expect((numbering.match(/<w:num /g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('states every action with its owner and due date', () => {
    expect(text).toContain('ACT-001');
    expect(text).toContain('Publish the guardrail evidence pack');
    expect(text).toContain('Karthik R');
    expect(text).toContain('05-05-2026');
    expect(text).toContain('ACT-002');
    expect(text).toContain('Priya N');
    expect(text).toContain('08-05-2026');
  });

  it('states every decision and every risk with its rating', () => {
    expect(text).toContain('DEC-001');
    expect(text).toContain('Sign off the landing zone');
    expect(text).toContain('DEC-002');
    expect(text).toContain('RSK-001');
    expect(text).toContain('Licence mobility may not transfer');
    expect(text).toContain('Escalate to the Microsoft account team');
    expect(text).toContain('RSK-002');
    // The risk that arrived without an owner or mitigation still renders a full row.
    expect(text).toContain('To be determined');
  });

  it('keeps the previous-meeting actions and the sign-off block', () => {
    expect(text).toContain('ACT-003');
    expect(text).toContain('Share the discovery inventory');
    expect(text).toContain('Silence implies acceptance');
    expect(text).toContain('End of Minutes of Meeting');
  });

  it('numbers pages in the footer', async () => {
    const footer = await entry(buffer, 'word/footer1.xml');
    expect(footer).toContain('PAGE');
    expect(footer).toContain('NUMPAGES');
    expect(textOf(footer)).toContain('Rainbow Migration');
  });
});

describe('generateMomDocxReport edge cases', () => {
  it('omits the Next Meeting section when the transcript said nothing about one', async () => {
    const without = textOf(await entry(await generateMomDocxReport(result()), 'word/document.xml'));
    expect(without).not.toContain('Next Meeting');


    const withNext = textOf(await entry(
      await generateMomDocxReport(result({
        next_meeting: { date: '07-05-2026', purpose: 'Cutover readiness' },
      })),
      'word/document.xml',
    ));
    expect(withNext).toContain('Next Meeting');
    expect(withNext).toContain('Cutover readiness');
  });

  it('still renders a complete document when the analysis came back nearly empty', async () => {
    const empty = MomResultSchema.parse({
      title: '',
      date: '',
      overall_summary: '',
      attendees: [],
      agenda_items: [],
      discussion_points: [],
      risks: [],
      next_steps: [],
    });
    const text = textOf(await entry(await generateMomDocxReport(empty), 'word/document.xml'));
    expect(text).toContain('Minutes of Meeting');
    expect(text).toContain('No decisions recorded.');
    expect(text).toContain('No actions recorded.');
    expect(text).toContain('No risks recorded.');
    expect(text).toContain('No previous meeting actions');
    expect(text).toContain('Not specified');
    expect(text).toContain('All Attendees');
  });

  /**
   * The PDF strips non-ASCII because pdf-lib's standard fonts are WinAnsi-only. OOXML is
   * UTF-8, so a name with a diacritic must survive here - this is the one place the Word
   * output is deliberately better than the PDF, so it is worth asserting.
   */
  it('preserves non-ASCII names that the PDF renderer has to strip', async () => {
    const text = textOf(await entry(
      await generateMomDocxReport(result({
        attendees: [{ name: 'Zoë Müller', role: 'Architect', organisation: 'Rainbow' }],
      })),
      'word/document.xml',
    ));
    expect(text).toContain('Zoë Müller');
  });

  it('drops control characters that would corrupt the package', async () => {
    const buffer = await generateMomDocxReport(result({
      overall_summary: 'Landing zone\u0001 ready\u0007 and signed off.',
    }));
    const text = textOf(await entry(buffer, 'word/document.xml'));
    expect(text).toContain('Landing zone ready and signed off.');
    expect(text).not.toContain('\u0001');
  });

  it('marks a High priority and an H severity in the colour the PDF uses', async () => {
    const xml = await entry(await generateMomDocxReport(result()), 'word/document.xml');
    // B82E33 is the PDF's red; it should appear on the High action and the H-rated risk.
    expect((xml.match(/B82E33/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});
