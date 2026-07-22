import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { getFileContent, saveFileContent, s3Client } from '../shared/aws.js';

const CAREERS_ORIGIN = 'https://minfytech.zohorecruit.com';
const CAREERS_LIST_URL = `${CAREERS_ORIGIN}/jobs/Careers`;
const CATALOG_KEY = 'public-sources/minfy-careers/catalog.json';
const DETAIL_PREFIX = 'public-sources/minfy-careers/jobs';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface MinfyCareerJob {
  id: string;
  title: string;
  department?: string;
  location?: string;
  sourceUrl: string;
}

export interface MinfyCareerJobDetail extends MinfyCareerJob {
  description: string;
  fetchedAt: number;
}

interface CachedCatalog {
  fetchedAt: number;
  jobs: MinfyCareerJob[];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlToText(value: string): string {
  return decodeHtml(value)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeJavaScriptString(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }

    const escape = value[index + 1];
    if (!escape) {
      decoded += '\\';
      continue;
    }

    if (escape === 'x' && /^[\da-f]{2}$/i.test(value.slice(index + 2, index + 4))) {
      decoded += String.fromCharCode(parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
      continue;
    }
    if (escape === 'u' && /^[\da-f]{4}$/i.test(value.slice(index + 2, index + 6))) {
      decoded += String.fromCharCode(parseInt(value.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }

    const simpleEscapes: Record<string, string> = {
      '\\': '\\',
      "'": "'",
      '"': '"',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
    };
    decoded += simpleEscapes[escape] ?? escape;
    index += 1;
  }
  return decoded;
}

function parseEscapedJobs(html: string): Record<string, unknown>[] {
  const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('([\s\S]*?)'\)\s*;/i);
  const candidates: string[] = [];
  if (match?.[1]) candidates.push(decodeJavaScriptString(match[1]));

  for (const input of html.matchAll(/<input\b[^>]*\bvalue="([^"]*)"[^>]*>/gi)) {
    const value = decodeHtml(input[1] || '').trim();
    if (value.startsWith('[{') && value.includes('"Job_Opening_Name"')) {
      candidates.push(value);
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const jobs = parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
        if (jobs.some((job) => asString(job.Job_Opening_Name || job.Posting_Title))) return jobs;
      }
    } catch {
      // Zoho currently serves two encodings; continue to the next supported one.
    }
  }

  throw new Error('The Minfy Careers source did not return a readable job catalogue.');
}

function mapCareerJob(value: Record<string, unknown>): MinfyCareerJob | undefined {
  const id = asString(value.id || value.Job_Opening_ID || value.jobId || value.Job_ID);
  const title = asString(value.Job_Opening_Name || value.title || value.Job_Title || value.name);
  if (!/^\d{8,32}$/.test(id) || !title) return undefined;

  const rawLocation = [value.City, value.State, value.Country, value.Location]
    .map(asString)
    .filter(Boolean)
    .filter((part, index, parts) => parts.indexOf(part) === index)
    .join(', ');

  return {
    id,
    title,
    department: asString(value.Department || value.Department_Name || value.Industry) || undefined,
    location: rawLocation || undefined,
    sourceUrl: `${CAREERS_ORIGIN}/jobs/Careers/${id}`,
  };
}

async function fetchCareersPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Minfy-AI-Interview-Assistant/1.0 (+https://www.minfytech.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) throw new Error(`Minfy Careers returned HTTP ${response.status}.`);
    return response.text();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Minfy Careers is taking longer than expected. Please try again shortly.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readCachedJson<T>(bucket: string, key: string): Promise<T | undefined> {
  try {
    return JSON.parse(await getFileContent(bucket, key)) as T;
  } catch {
    return undefined;
  }
}

async function isFresh(bucket: string, key: string): Promise<boolean> {
  try {
    const response = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return !!response.LastModified && Date.now() - response.LastModified.getTime() < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export async function listMinfyCareerJobs(bucket: string): Promise<CachedCatalog> {
  const cached = await readCachedJson<CachedCatalog>(bucket, CATALOG_KEY);
  if (cached?.jobs?.length && await isFresh(bucket, CATALOG_KEY)) return cached;

  try {
    const html = await fetchCareersPage(CAREERS_LIST_URL);
    const jobs = parseEscapedJobs(html)
      .map(mapCareerJob)
      .filter((job): job is MinfyCareerJob => !!job)
      .sort((left, right) => left.title.localeCompare(right.title));
    if (!jobs.length) throw new Error('No active roles were returned by Minfy Careers.');

    const catalogue = { fetchedAt: Date.now(), jobs };
    await saveFileContent(bucket, CATALOG_KEY, JSON.stringify(catalogue));
    return catalogue;
  } catch (error) {
    if (cached?.jobs?.length) return cached;
    throw error;
  }
}

export async function getMinfyCareerJob(bucket: string, jobId: string): Promise<MinfyCareerJobDetail> {
  if (!/^\d{8,32}$/.test(jobId)) throw new Error('Invalid Minfy Careers job reference.');

  const detailKey = `${DETAIL_PREFIX}/${jobId}.json`;
  const cached = await readCachedJson<MinfyCareerJobDetail>(bucket, detailKey);
  if (cached?.description && await isFresh(bucket, detailKey)) return cached;

  const catalog = await listMinfyCareerJobs(bucket);
  const catalogJob = catalog.jobs.find((job) => job.id === jobId);
  if (!catalogJob) throw new Error('That Minfy Careers role is no longer published. Refresh the role list and choose another role.');

  const html = await fetchCareersPage(catalogJob.sourceUrl);
  const detailData = parseEscapedJobs(html)[0];
  const description = htmlToText(asString(detailData?.Job_Description || detailData?.description));
  if (!description || description.length < 80) {
    throw new Error('The selected role does not currently include a readable job description.');
  }

  const detail: MinfyCareerJobDetail = { ...catalogJob, description, fetchedAt: Date.now() };
  await saveFileContent(bucket, detailKey, JSON.stringify(detail));
  return detail;
}
