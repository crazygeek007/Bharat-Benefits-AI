/**
 * HTML Parser for Scheme Data
 *
 * Heuristic best-effort extractor for scheme metadata from gov.in / nic.in
 * HTML pages. The returned {@link SchemeObject} is a Partial — mandatory
 * field enforcement happens in {@link enforceMandatoryFields}.
 *
 * Supports the following common gov.in HTML patterns:
 *   - Scheme name from h1, h2, or `.scheme-name` selectors
 *   - Description from `.description`, `p.intro`, or first non-empty <p>
 *     inside the main content region
 *   - Eligibility criteria from sections with headings matching /eligib/i
 *   - Benefits from sections with headings matching /benefit/i
 *   - Required documents from list items in sections matching /documents?/i
 *   - Application process from sections matching /how to apply|application
 *     process/i
 *   - Ministry from <meta> tags or footer text
 *   - Deadline from text matching date patterns near deadline keywords
 *
 * Validates: Requirements 22.1, 22.2, 22.5, 22.7
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type {
  ApplicationStep,
  Benefit,
  DocumentRequirement,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

import { extractWithPortalAwareness } from './portal-extractors';

const ELIGIBILITY_HEADING_RE = /eligib/i;
const BENEFITS_HEADING_RE = /benefit/i;
const DOCUMENTS_HEADING_RE = /documents?/i;
const APPLICATION_HEADING_RE = /how to apply|application process|how_to_apply/i;
const DEADLINE_KEYWORDS_RE = /(deadline|last date|closing date|apply by|due date)/i;

/**
 * Parses an HTML scheme page into a Partial<SchemeObject>.
 *
 * Always returns an object — fields that cannot be extracted are simply
 * absent (or set to null for optional fields). Validation against the
 * mandatory-field requirement is the responsibility of the caller.
 */
export function parseHTML(content: string, sourceUrl: string): Partial<SchemeObject> {
  const $ = cheerio.load(content ?? '');

  const result: Partial<SchemeObject> = { sourceUrl };

  // ─── Name ────────────────────────────────────────────────────────────────
  const name = extractName($);
  if (name) result.name = name;

  // ─── Description ─────────────────────────────────────────────────────────
  const description = extractDescription($);
  if (description) result.description = description;

  // ─── Ministry ────────────────────────────────────────────────────────────
  const ministry = extractMinistry($);
  if (ministry) result.ministry = ministry;

  // ─── Eligibility ─────────────────────────────────────────────────────────
  const eligibility = extractEligibility($);
  if (eligibility.length > 0) result.eligibilityCriteria = eligibility;

  // ─── Benefits ────────────────────────────────────────────────────────────
  const benefits = extractBenefits($);
  if (benefits.length > 0) result.benefits = benefits;

  // ─── Optional: Documents ─────────────────────────────────────────────────
  const documents = extractDocuments($);
  result.requiredDocuments = documents.length > 0 ? documents : null;

  // ─── Optional: Application process ───────────────────────────────────────
  const application = extractApplicationSteps($);
  result.applicationProcess = application.length > 0 ? application : null;

  // ─── Optional: Deadline ──────────────────────────────────────────────────
  const deadline = extractDeadline($);
  result.deadline = deadline;

  // ─── Portal-aware enrichment ─────────────────────────────────────────────
  // Layer portal-specific selectors on top of the heuristic result.
  // Returns `result` untouched for any URL that doesn't match a known
  // portal (long-tail ministry sites), so this call is a safe no-op
  // in the worst case.
  return extractWithPortalAwareness(content ?? '', sourceUrl, result);
}

// ─── Field Extractors ────────────────────────────────────────────────────────

function extractName($: CheerioAPI): string | null {
  const candidates = [
    $('.scheme-name').first().text(),
    $('h1').first().text(),
    $('h2').first().text(),
    $('meta[property="og:title"]').attr('content') ?? '',
    $('title').first().text(),
  ];
  for (const c of candidates) {
    const cleaned = clean(c);
    if (cleaned) return cleaned;
  }
  return null;
}

function extractDescription($: CheerioAPI): string | null {
  const candidates = [
    $('meta[name="description"]').attr('content') ?? '',
    $('.description').first().text(),
    $('p.intro').first().text(),
    $('main p').first().text(),
    $('article p').first().text(),
    $('p').first().text(),
  ];
  for (const c of candidates) {
    const cleaned = clean(c);
    if (cleaned) return cleaned;
  }
  return null;
}

function extractMinistry($: CheerioAPI): string | null {
  const metaCandidates = [
    $('meta[name="ministry"]').attr('content'),
    $('meta[name="department"]').attr('content'),
    $('meta[property="ministry"]').attr('content'),
  ];
  for (const c of metaCandidates) {
    const cleaned = clean(c ?? '');
    if (cleaned) return cleaned;
  }

  // Try a `.ministry` CSS hook
  const ministryEl = clean($('.ministry').first().text());
  if (ministryEl) return ministryEl;

  // Fallback: scan footer text for "Ministry of …" or "Department of …"
  const footerText = $('footer').text() + ' ' + $('body').text();
  const match = footerText.match(/(Ministry of [^\n.,;|]+)/i);
  if (match) return clean(match[1]);
  const dept = footerText.match(/(Department of [^\n.,;|]+)/i);
  if (dept) return clean(dept[1]);

  return null;
}

function extractEligibility($: CheerioAPI): EligibilityCriterion[] {
  const items = collectListItemsForHeading($, ELIGIBILITY_HEADING_RE);
  return items.map<EligibilityCriterion>((text) => ({
    field: 'unknown',
    operator: 'eq',
    value: null,
    description: text,
  }));
}

function extractBenefits($: CheerioAPI): Benefit[] {
  const items = collectListItemsForHeading($, BENEFITS_HEADING_RE);
  return items.map<Benefit>((text) => {
    const amount = extractRupeeAmount(text);
    return {
      type: amount === null ? 'non-monetary' : 'monetary',
      amount,
      description: text,
    };
  });
}

function extractDocuments($: CheerioAPI): DocumentRequirement[] {
  const items = collectListItemsForHeading($, DOCUMENTS_HEADING_RE);
  return items.map<DocumentRequirement>((text) => ({
    documentName: text,
    description: text,
    format: 'unknown',
    required: true,
  }));
}

function extractApplicationSteps($: CheerioAPI): ApplicationStep[] {
  const items = collectListItemsForHeading($, APPLICATION_HEADING_RE);
  return items.map<ApplicationStep>((text, idx) => ({
    stepNumber: idx + 1,
    action: text,
    expectedOutcome: '',
  }));
}

function extractDeadline($: CheerioAPI): Date | null {
  const bodyText = $('body').text() || $.root().text();
  // Find any line that mentions deadline-like keywords and contains a date.
  const lines = bodyText.split(/\r?\n|\.|;/);
  for (const line of lines) {
    if (!DEADLINE_KEYWORDS_RE.test(line)) continue;
    const date = parseDateFromText(line);
    if (date) return date;
  }
  return null;
}

// ─── Heading-driven section traversal ────────────────────────────────────────

/**
 * Finds the first heading matching `headingRegex` and gathers list items
 * that follow it until the next heading of the same or higher level.
 *
 * Looks at:
 *   1. <ul>/<ol> elements that are siblings or descendants until next heading
 *   2. Falls back to splitting the section's plain text by newlines if no
 *      list elements are present
 */
function collectListItemsForHeading(
  $: CheerioAPI,
  headingRegex: RegExp,
): string[] {
  const items: string[] = [];
  const heading = $('h1, h2, h3, h4, h5, h6')
    .filter((_, el) => headingRegex.test($(el).text()))
    .first();

  if (heading.length === 0) return items;

  const headingTag = heading[0].tagName?.toLowerCase() ?? 'h2';
  const stopAtLevel = headingLevel(headingTag);
  // Use object identity to dedupe <li> nodes already collected from
  // outer containers when we descend into nested lists.
  const seen = new WeakSet<object>();

  let current = heading.next();
  while (current.length > 0) {
    const tag = current[0].tagName?.toLowerCase();
    if (tag && /^h[1-6]$/.test(tag) && headingLevel(tag) <= stopAtLevel) break;

    // Direct lists
    if (tag === 'ul' || tag === 'ol') {
      current.find('li').each((_, li) => {
        if (seen.has(li)) return;
        seen.add(li);
        const text = clean($(li).text());
        if (text) items.push(text);
      });
    } else {
      // Nested lists inside divs/sections
      current.find('ul li, ol li').each((_, li) => {
        if (seen.has(li)) return;
        seen.add(li);
        const text = clean($(li).text());
        if (text) items.push(text);
      });
    }
    current = current.next();
  }

  // Heuristic fallback: if no list found, split heading-following paragraph
  // text on commas / semicolons / newlines.
  if (items.length === 0) {
    const sib = heading.nextUntil('h1, h2, h3, h4, h5, h6');
    const paragraphText = clean(sib.text());
    if (paragraphText) {
      const parts = paragraphText
        .split(/(?:\r?\n|\u2022|;|,)+/)
        .map((s) => clean(s))
        .filter((s): s is string => s !== null && s.length > 0);
      items.push(...parts);
    }
  }

  return items;
}

function headingLevel(tag: string): number {
  const m = tag.match(/^h([1-6])$/i);
  return m ? Number(m[1]) : 99;
}

// ─── Text utilities ──────────────────────────────────────────────────────────

function clean(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** Extracts a rupee amount (in INR) from a benefit description, or null. */
export function extractRupeeAmount(text: string): number | null {
  if (!text) return null;
  // Match patterns like "Rs. 5000", "₹5,000", "INR 12000", "Rs 1,00,000"
  const re = /(?:rs\.?|₹|inr)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i;
  const m = text.match(re);
  if (!m) return null;
  const numeric = m[1].replace(/,/g, '');
  const value = Number(numeric);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses a date out of a free-text snippet. Handles:
 *   - 31/12/2024, 31-12-2024 (dd/mm/yyyy or dd-mm-yyyy)
 *   - 2024-12-31 (ISO yyyy-mm-dd)
 *   - 31 December 2024 / December 31, 2024
 */
export function parseDateFromText(text: string): Date | null {
  if (!text) return null;

  // ISO yyyy-mm-dd
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const d = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // dd/mm/yyyy or dd-mm-yyyy
  const dmy = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    const d = new Date(
      Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])),
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // "31 December 2024" or "December 31, 2024"
  const months = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const monthRe = `(${months.join('|')})`;
  const ddMonthYear = new RegExp(`(\\d{1,2})\\s+${monthRe}\\s+(\\d{4})`, 'i');
  const monthDdYear = new RegExp(`${monthRe}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i');

  const m1 = text.match(ddMonthYear);
  if (m1) {
    const day = Number(m1[1]);
    const month = months.indexOf(m1[2].toLowerCase());
    const year = Number(m1[3]);
    const d = new Date(Date.UTC(year, month, day));
    if (!Number.isNaN(d.getTime())) return d;
  }

  const m2 = text.match(monthDdYear);
  if (m2) {
    const month = months.indexOf(m2[1].toLowerCase());
    const day = Number(m2[2]);
    const year = Number(m2[3]);
    const d = new Date(Date.UTC(year, month, day));
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}
