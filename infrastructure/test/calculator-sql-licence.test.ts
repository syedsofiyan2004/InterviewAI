import { sqlLicensing, sqlLicenceSuffix } from '../lambdas/shared/sql-licence';

/**
 * SQL Server licensing, read from a spreadsheet.
 *
 * This is the largest single per-machine figure a sheet can state, and it can be got wrong
 * in both directions:
 *
 *  - Missed. A bundled licence is billed per vCPU, so SQL Standard roughly doubles an EC2
 *    rate and Enterprise more than trebles it. Priced as plain Windows the machine is
 *    understated by about half, and silently, because plain Windows is a real rate.
 *  - Invented. A row the client marked BYOL already has a licence paid for. Charging for it
 *    again roughly doubles that machine for nothing.
 *
 * So every test below is about wording, not about any one workbook. The cases come from the
 * ways sheets actually write this: an edition in the OS cell, an edition in the service
 * cell, "(BYOL)" in either, a licence note in the remarks column, MySQL and PostgreSQL
 * (which contain the letters "sql" and must never be priced as SQL Server), and "Red Hat
 * Enterprise Linux" (which contains "Enterprise" and must never be priced as SQL Enterprise).
 */

describe('what AWS should bill for a SQL Server licence', () => {
  test('an edition named beside SQL Server is the edition billed', () => {
    expect(sqlLicensing('Windows + SQL Server Standard')).toEqual({ mentioned: true, billed: 'SQL Std' });
    expect(sqlLicensing('Windows 2019 with SQL Server Enterprise 2019')).toEqual({ mentioned: true, billed: 'SQL Ent' });
    expect(sqlLicensing('Windows / SQL Server Web edition')).toEqual({ mentioned: true, billed: 'SQL Web' });
  });

  test('SQL Server with no edition stated is Standard', () => {
    // The common licence and the mid price: the least wrong of the three assumptions, and
    // the report says out loud that it was assumed.
    expect(sqlLicensing('Windows Server 2022 + SQL Server')).toEqual({ mentioned: true, billed: 'SQL Std' });
    expect(sqlLicensing('MS-SQL')).toEqual({ mentioned: true, billed: 'SQL Std' });
  });

  test('nothing is billed for a licence the client already owns', () => {
    for (const wording of [
      'Windows + SQL Server 2019 Std (BYOL)',
      'Windows + SQL Server Enterprise - bring your own licence',
      'Windows + SQL Server Standard, bring-your-own-license',
      'Windows + SQL Server (customer own licence)',
      'Windows + SQL Server Standard - licence not included',
      'Windows + SQL Server Standard - licenses excluded',
      'Windows + SQL Server Standard - no SQL licence',
      'Windows + SQL Server Standard - existing license reused',
    ]) {
      expect(sqlLicensing(wording)).toEqual({ mentioned: true, billed: 'NA', unbilled: 'BYOL' });
    }
  });

  test('nothing is billed for Express, because Microsoft gives it away', () => {
    expect(sqlLicensing('Windows + SQL Server Express')).toEqual({ mentioned: true, billed: 'NA', unbilled: 'Express' });
  });

  test('another database whose name contains "sql" is not SQL Server', () => {
    // The worst overstatement this module could produce: a Linux MySQL box charged for a
    // Windows SQL Server licence.
    expect(sqlLicensing('Linux + MySQL 8.0')).toEqual({ mentioned: false, billed: 'NA' });
    expect(sqlLicensing('Linux PostgreSQL 15')).toEqual({ mentioned: false, billed: 'NA' });
    expect(sqlLicensing('Amazon Aurora MySQL')).toEqual({ mentioned: false, billed: 'NA' });
    expect(sqlLicensing('NoSQL workload')).toEqual({ mentioned: false, billed: 'NA' });
    expect(sqlLicensing('Windows Server 2019')).toEqual({ mentioned: false, billed: 'NA' });
  });

  test('"Enterprise" belonging to the operating system is not a SQL edition', () => {
    // Red Hat Enterprise Linux running SQL Server: Enterprise describes the OS. Reading it
    // as the database edition would roughly treble the rate on a coincidence of wording.
    expect(sqlLicensing('Red Hat Enterprise Linux 9 + SQL Server')).toEqual({ mentioned: true, billed: 'SQL Std' });
    // Stated the other way round it IS the database edition, and is billed as one.
    expect(sqlLicensing('SQL Server Enterprise on Red Hat Enterprise Linux')).toEqual({ mentioned: true, billed: 'SQL Ent' });
  });
});

describe('the licence a parsed row carries on its OS string', () => {
  test('an edition in the OS or the service column survives normalisation', () => {
    expect(sqlLicenceSuffix('Windows 2019 Datacenter with SQL Server Standard Amazon EC2'))
      .toBe(' + SQL Server Standard');
    expect(sqlLicenceSuffix('Windows EC2 - SQL Server Enterprise'))
      .toBe(' + SQL Server Enterprise');
  });

  test('a row with no database gets no suffix', () => {
    expect(sqlLicenceSuffix('Windows Server 2019 Amazon EC2')).toBe('');
    expect(sqlLicenceSuffix('Linux Amazon RDS for MySQL')).toBe('');
  });

  test('a remarks column can waive a licence but never buy one', () => {
    // Waiving: the columns name the edition, the note says who owns it.
    expect(sqlLicenceSuffix('Windows + SQL Server Standard Amazon EC2', 'BYOL for SQL and Windows'))
      .toBe(' + SQL Server Standard (BYOL)');
    // Buying: free text mentioning SQL Server must not add a licence. This exact note is in
    // the real COSEC model against machines whose OS column says only "Windows" -- reading
    // it as a purchase would have added a per-vCPU licence to six servers that never asked
    // for one.
    expect(sqlLicenceSuffix('Windows Amazon EC2', 'SQL Server consolidation sizing (6 VMs to 4 instances)'))
      .toBe('');
  });

  test('a suffix reaches pricing as the same decision that produced it', () => {
    // The two halves have to agree: whatever the parser writes onto the OS string, the
    // pipeline must read back as the same licence. That is the whole reason they share a
    // module rather than each carrying their own regexes.
    const os = `Windows${sqlLicenceSuffix('Windows 2022 / SQL Server Enterprise Amazon EC2')}`;
    expect(sqlLicensing(`${os} Amazon EC2`)).toEqual({ mentioned: true, billed: 'SQL Ent' });

    const byol = `Windows${sqlLicenceSuffix('Windows 2022 / SQL Server Enterprise Amazon EC2', 'BYOL')}`;
    expect(sqlLicensing(`${byol} Amazon EC2`)).toEqual({ mentioned: true, billed: 'NA', unbilled: 'BYOL' });
  });
});
