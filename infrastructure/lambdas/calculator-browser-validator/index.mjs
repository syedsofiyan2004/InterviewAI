import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

const NAVIGATION_TIMEOUT_MS = 60_000;
const REHYDRATION_TIMEOUT_MS = 60_000;

function numberFromCurrency(text) {
  const match = String(text || '').match(/([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export const handler = async (event = {}) => {
  const url = String(event.url || '');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { validUrl: false, reason: 'The returned shareable link is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('calculator.aws')) {
    return { validUrl: false, reason: 'The URL is not an HTTPS calculator.aws link.' };
  }

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await page.goto(url, { waitUntil: 'networkidle2' });

    await page.waitForFunction(() => {
      const controls = [...document.querySelectorAll(
        'button, a, [role="button"], [data-testid*="export" i], [aria-label*="export" i]',
      )];
      const exportControl = controls.find((element) => {
        const text = (element.textContent || '').trim();
        const aria = element.getAttribute('aria-label') || '';
        const testId = element.getAttribute('data-testid') || '';
        return /^export(?: estimate)?$/i.test(text) || /export/i.test(`${aria} ${testId}`);
      });
      return Boolean(exportControl
        && !exportControl.hasAttribute('disabled')
        && exportControl.getAttribute('aria-disabled') !== 'true');
    }, { timeout: REHYDRATION_TIMEOUT_MS });

    const rendered = await page.evaluate(() => {
      const controls = [...document.querySelectorAll(
        'button, a, [role="button"], [data-testid*="export" i], [aria-label*="export" i]',
      )];
      const exportControl = controls.find((element) => {
        const text = (element.textContent || '').trim();
        const aria = element.getAttribute('aria-label') || '';
        const testId = element.getAttribute('data-testid') || '';
        return /^export(?: estimate)?$/i.test(text) || /export/i.test(`${aria} ${testId}`);
      });
      const disabled = !exportControl
        || exportControl.hasAttribute('disabled')
        || exportControl.getAttribute('aria-disabled') === 'true';
      const bodyText = document.body?.innerText || '';
      const summaryMatch = /Upfront cost\s+([\d,.]+\s+USD)\s+Monthly cost\s+([\d,.]+\s+USD)\s+Total 12 months cost\s+([\d,.]+\s+USD)/i.exec(bodyText);
      const visibleErrors = bodyText.split(/\n+/).map((line) => line.trim()).filter((line) => (
        /please specify value|read[- ]only mode|unable to (?:load|calculate)|failed to (?:load|calculate)/i.test(line)
      )).slice(0, 20);
      const currencyTexts = [...document.querySelectorAll('body *')]
        .filter((element) => /\bUSD\b/.test(element.textContent || '')
          && ![...element.children].some((child) => /\bUSD\b/.test(child.textContent || '')))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      const rows = [...document.querySelectorAll('tr, [role="row"]')].flatMap((row) => {
        const cells = [...row.querySelectorAll('td, [role="cell"]')].map((cell) => (cell.textContent || '').trim());
        const usdAt = cells.findIndex((cell) => /\bUSD\b/.test(cell));
        if (usdAt < 1 || cells.filter((cell) => /\bUSD\b/.test(cell)).length < 2) return [];
        return [{
          service: cells[usdAt - 1],
          upfrontText: cells[usdAt],
          monthlyText: cells[usdAt + 1] || '',
          configSummary: cells[usdAt + 4] || '',
        }];
      });
      return {
        title: document.title,
        disabled,
        visibleErrors,
        summaryTexts: summaryMatch ? summaryMatch.slice(1, 4) : [],
        currencyTexts,
        rows,
      };
    });

    if (rendered.disabled) {
      return { validUrl: false, reason: 'Calculator rehydration left the estimate in read-only mode.' };
    }
    if (rendered.visibleErrors.length) {
      return { validUrl: false, reason: `Calculator displayed validation errors: ${rendered.visibleErrors.join(' | ')}` };
    }
    const labelledValues = rendered.summaryTexts.map(numberFromCurrency).filter((value) => value !== null);
    const values = labelledValues.length === 3
      ? labelledValues
      : rendered.currencyTexts.map(numberFromCurrency).filter((value) => value !== null);
    if (values.length < 3) {
      return { validUrl: false, reason: 'Calculator did not render upfront, monthly, and 12-month totals.' };
    }
    const [upfront, monthly, total12Months] = values;
    if (monthly <= 0 && upfront <= 0) {
      return { validUrl: false, reason: 'Calculator rendered a zero-cost estimate.' };
    }
    return {
      validUrl: true,
      title: rendered.title,
      upfront,
      monthly,
      total12Months,
      services: rendered.rows.map((row) => ({
        service: row.service,
        upfront: numberFromCurrency(row.upfrontText),
        monthly: numberFromCurrency(row.monthlyText),
        configSummary: row.configSummary,
      })),
    };
  } catch (error) {
    return { validUrl: false, reason: `Calculator browser validation failed: ${String(error?.message || error).slice(0, 500)}` };
  } finally {
    await browser.close();
  }
};
