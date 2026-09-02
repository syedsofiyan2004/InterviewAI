/**
 * SQL Server licensing, read from whatever a customer's spreadsheet happens to say.
 *
 * One module, imported by both the upload parser (api-handler/calculator-workbook.ts) and
 * the pricing pipeline (calculator-orchestrator/pipeline.ts), because the two have to agree
 * exactly: the parser decides what wording survives onto a row, and the pipeline decides
 * what AWS is billed for it. Two copies of these rules drifting apart is a silent
 * mispricing, and a bundled SQL Server licence is the largest single per-machine cost a
 * sheet can state — it is billed per vCPU, so Standard roughly doubles an EC2 rate and
 * Enterprise more than trebles it.
 *
 * Nothing here is specific to one workbook. It is wording, in the forms sheets write it.
 */

/** What a row's wording says about a SQL Server licence, and who is paying for it. */
export interface SqlLicensing {
  /** The wording names SQL Server at all. */
  mentioned: boolean;
  /** What AWS is to bill for the licence, as the Price List's preInstalledSw names it. */
  billed: 'NA' | 'SQL Std' | 'SQL Web' | 'SQL Ent';
  /** Why a named licence is nonetheless not billed, so a report can say so. */
  unbilled?: 'BYOL' | 'Express';
}

/**
 * Bring-your-own-licence wording.
 *
 * Read as carefully as the edition itself, because it moves the rate by the same large
 * margin in the opposite direction. "SQL Server 2019 Std (BYOL)" priced with a bundled
 * licence overstates that machine by roughly its whole compute cost a second time, for a
 * licence the client has already bought — and AWS charges nothing for a licence it does not
 * supply, so the plain operating-system rate is the correct one.
 */
export const BYOL_WORDING = /\bbyol\b|bring[\s-]?your[\s-]?own|own licen[cs]e|licen[cs]es?\s*(?:are\s*)?(?:not included|excluded)|(?:no|excludes?|excluding)\s+(?:sql[\s-]*)?(?:server[\s-]*)?licen[cs]e|licen[cs]e[\s:=-]+no\b|existing licen[cs]e/;

/**
 * Where SQL Server is named in a string, or -1.
 *
 * `\bsql\b` rather than `sql`: "MySQL", "PostgreSQL" and "NoSQL" all contain it, and a
 * Linux MySQL box priced with a Windows SQL Server licence is the worst overstatement this
 * module could produce.
 */
function sqlAt(value: string): number {
  return value.search(/\bsql\b|\bmssql\b/);
}

/**
 * The edition named beside a SQL mention.
 *
 * Read from a 60-character window that STARTS at the mention, because the same words
 * describe other things elsewhere in the same cell: "Red Hat Enterprise Linux + SQL Server"
 * says Enterprise about the operating system, not about the database, and pricing it as SQL
 * Enterprise would roughly treble the rate on the strength of a coincidence.
 */
function editionAt(value: string, at: number): 'Express' | 'SQL Ent' | 'SQL Web' | 'SQL Std' {
  const window = value.slice(at, at + 60);
  if (/\bexpress\b/.test(window)) return 'Express';
  if (/\bent(erprise)?\b/.test(window)) return 'SQL Ent';
  if (/\bweb\b/.test(window)) return 'SQL Web';
  // Standard is the default when a sheet says "SQL Server" and nothing more: it is the
  // common licence and the mid price, so it is the least wrong assumption of the three.
  return 'SQL Std';
}

/** What AWS should bill for the licence this wording describes. */
export function sqlLicensing(text: string): SqlLicensing {
  const value = String(text || '').toLowerCase();
  const at = sqlAt(value);
  if (at < 0) return { mentioned: false, billed: 'NA' };
  if (BYOL_WORDING.test(value)) return { mentioned: true, billed: 'NA', unbilled: 'BYOL' };
  const edition = editionAt(value, at);
  // Express is free from Microsoft and AWS bills no licence for it, so a bundled rate would
  // be an invention.
  if (edition === 'Express') return { mentioned: true, billed: 'NA', unbilled: 'Express' };
  return { mentioned: true, billed: edition };
}

/**
 * The licence to append to a parsed row's OS string, or ''.
 *
 * The OS column is normalised on the way in — "Windows 2019 with SQL Server Standard" is
 * folded to "Windows" so that it matches an AWS rate at all — and that fold is where the
 * licence used to be lost. Carrying it on the OS string is both what lets the pipeline see
 * it and what keeps licensed and unlicensed machines in separate groups, which they must be.
 *
 * `columns` is the OS and service cells: structured text, where naming SQL Server means the
 * machine runs it. `notes` is free text and is consulted for BYOL wording ONLY, never to add
 * a licence — a note reading "SQL Server consolidation sizing (6 VMs to 4 instances)"
 * describes a migration, not a purchase, and buying a licence on the strength of it would
 * overstate the row by its whole compute cost again.
 */
export function sqlLicenceSuffix(columns: string, notes?: string): string {
  const value = String(columns || '').toLowerCase();
  const at = sqlAt(value);
  if (at < 0) return '';
  const edition = editionAt(value, at);
  const name = edition === 'Express' ? 'SQL Server Express'
    : edition === 'SQL Ent' ? 'SQL Server Enterprise'
      : edition === 'SQL Web' ? 'SQL Server Web'
        : 'SQL Server Standard';
  const byol = BYOL_WORDING.test(`${value} ${String(notes || '').toLowerCase()}`);
  return ` + ${name}${byol ? ' (BYOL)' : ''}`;
}
