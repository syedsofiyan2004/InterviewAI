type ReportFinding = { location?: string; finding?: string; question?: string; whyItMatters?: string };
type Report = { overview?: string; openQuestions?: ReportFinding[]; blockers?: ReportFinding[]; majors?: ReportFinding[]; minors?: ReportFinding[] };

const loadDocx = () => import('docx');

export async function generateSowPeerReviewDocx(report: Report, fileName: string): Promise<Buffer> {
  const d = await loadDocx();
  const groups: Array<{ title: string; items: ReportFinding[]; color: string }> = [
    { title: 'Blockers', items: report.blockers || [], color: 'C62828' },
    { title: 'Major Findings', items: report.majors || [], color: 'D97706' },
    { title: 'Open Questions', items: report.openQuestions || [], color: '2563EB' },
    { title: 'Minor Findings', items: report.minors || [], color: '64748B' },
  ];
  const children: any[] = [
    new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun({ text: 'SOW Peer Review', bold: true, color: '0F766E', size: 34 })] }),
    new d.Paragraph({ children: [new d.TextRun({ text: `Document: ${fileName}`, bold: true, color: '475569' })], spacing: { after: 160 } }),
    new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, children: [new d.TextRun({ text: 'Executive Overview', bold: true })] }),
    new d.Paragraph({ children: [new d.TextRun({ text: report.overview || 'No overview was returned.' })], spacing: { after: 240 } }),
  ];
  for (const group of groups) {
    children.push(new d.Paragraph({ heading: d.HeadingLevel.HEADING_1, children: [new d.TextRun({ text: `${group.title} (${group.items.length})`, bold: true, color: group.color })] }));
    if (!group.items.length) {
      children.push(new d.Paragraph({ children: [new d.TextRun({ text: 'No findings in this category.', italics: true, color: '64748B' })], spacing: { after: 160 } }));
      continue;
    }
    children.push(new d.Table({
      width: { size: 100, type: d.WidthType.PERCENTAGE },
      rows: group.items.map((item) => new d.TableRow({ children: [
        new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text: item.location || 'Document', bold: true, color: group.color })] })], width: { size: 25, type: d.WidthType.PERCENTAGE } }),
        new d.TableCell({ children: [new d.Paragraph({ children: [new d.TextRun({ text: item.finding || item.question || 'Finding' })] }), new d.Paragraph({ children: [new d.TextRun({ text: item.whyItMatters || '', color: '475569' })] })], width: { size: 75, type: d.WidthType.PERCENTAGE } }),
      ] })),
    }));
    children.push(new d.Paragraph({ children: [new d.TextRun({ text: '' })], spacing: { after: 120 } }));
  }
  const doc = new d.Document({ sections: [{ properties: {}, children }], styles: { default: { document: { run: { font: 'Aptos', size: 21 } } } } });
  return d.Packer.toBuffer(doc);
}
