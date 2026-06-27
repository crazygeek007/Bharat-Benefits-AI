/**
 * Portal-aware extractors for the HTML parser.
 *
 * The generic {@link parseHTML} extractor uses heading-driven heuristics
 * ("any heading matching /eligib/i + the list after it") which works
 * surprisingly well across the long tail of gov.in / nic.in scheme
 * portals but leaves a lot of value on the table for the five major
 * sources we crawl daily:
 *
 *   - myscheme.gov.in
 *   - india.gov.in
 *   - services.india.gov.in
 *   - scholarships.gov.in
 *   - igod.gov.in
 *
 * Each of those portals has a predictable layout with stable CSS hooks
 * (`.scheme-detail`, `[data-section="benefits"]`, `.field--name-body`,
 * etc). Rather than complicate the generic parser with N branches, we
 * keep portal knowledge in this module behind a small {@link PortalExtractor}
 * interface and run it as a POST-PROCESSING step on top of the generic
 * result — the generic extraction provides the safety net, the
 * portal-specific extractor enriches what it can.
 *
 * Design notes:
 *   - Each extractor MUST be non-destructive. If the generic parser
 *     already produced a value for a field, the portal extractor
 *     should only override it when it has strictly higher-confidence
 *     data (e.g., a structured eligibility list under a known DOM
 *     selector vs the generic "first ul after /eligib/i heading"
 *     result).
 *   - Extractors are pure (cheerio in, partial object out). They never
 *     fetch additional URLs, never log, and never throw — any DOM-shape
 *     surprise should fall back to leaving the existing field as-is.
 *   - The router (`extractWithPortalAwareness`) picks the first matching
 *     extractor by `matches(url)` predicate. There's no chaining today
 *     because no URL is plausibly hosted by two portals at once.
 *
 * Adding a new portal:
 *   1. Implement {@link PortalExtractor.matches} so it returns `true`
 *      for hostnames you own and `false` everywhere else (use
 *      label-boundary matching — `endsWith('.host')` or
 *      `=== 'host'`, never a substring check).
 *   2. Implement {@link PortalExtractor.enrich} — read the cheerio
 *      handle, extract any fields you can with high confidence, and
 *      return them as a partial. Don't repeat fields you didn't
 *      extract.
 *   3. Register the extractor in `PORTAL_EXTRACTORS` below. Order does
 *      not matter for current portals (no domain overlap) but the
 *      router uses first-match-wins so prefer specificity.
 *
 * Validates: Requirement 22.1 (mandatory fields), 22.2 (best-effort
 * extraction with structured fallback).
 */

import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';
import type {
  Benefit,
  EligibilityCriterion,
  SchemeObject,
} from '@bharat-benefits/shared';

import { extractRupeeAmount } from './html.parser';

// ─── Interface ──────────────────────────────────────────────────────────────

export interface PortalExtractor {
  /** Human-readable name shown in any future diagnostic logging. */
  readonly name: string;
  /** Returns true when this extractor applies to the given URL. */
  matches(url: string): boolean;
  /**
   * Reads portal-specific DOM selectors and returns enrichments to
   * merge over the generic extraction. Implementations MUST NOT throw;
   * any structural surprise should result in an empty return.
   */
  enrich(
    $: CheerioAPI,
    generic: Partial<SchemeObject>,
    url: string,
  ): Partial<SchemeObject>;
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * Extract list-style values under any of the supplied selectors. Stops
 * at the first selector that yields ≥1 non-empty item so the more
 * specific selectors win when multiple are present.
 */
function extractListItems($: CheerioAPI, selectors: readonly string[]): string[] {
  for (const selector of selectors) {
    const items: string[] = [];
    $(selector).each((_, el) => {
      const text = clean($(el).text());
      if (text) items.push(text);
    });
    if (items.length > 0) return items;
  }
  return [];
}

/**
 * Read the first non-empty text out of the supplied selector list.
 */
function firstNonEmpty($: CheerioAPI, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const value = clean($(selector).first().text());
    if (value) return value;
  }
  return null;
}

/**
 * Same as {@link firstNonEmpty} but reads a named attribute (e.g.
 * `content`) rather than the element's text content.
 */
function firstAttr(
  $: CheerioAPI,
  selectors: readonly string[],
  attr: string,
): string | null {
  for (const selector of selectors) {
    const value = clean($(selector).first().attr(attr));
    if (value) return value;
  }
  return null;
}

function toEligibility(items: string[]): EligibilityCriterion[] {
  return items.map((text) => ({
    field: 'unknown',
    operator: 'eq',
    value: null,
    description: text,
  }));
}

function toBenefits(items: string[]): Benefit[] {
  return items.map((text) => {
    const amount = extractRupeeAmount(text);
    return {
      type: amount === null ? 'non-monetary' : 'monetary',
      amount,
      description: text,
    };
  });
}

/** Host-suffix match honouring label boundaries. */
function hostMatches(url: string, suffix: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === suffix) return true;
    return host.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}

// ─── myscheme.gov.in extractor ──────────────────────────────────────────────

/**
 * myscheme.gov.in renders scheme detail pages through a React SPA.
 * The server-rendered HTML usually contains the structured fields
 * directly inside `<section>` or `<div>` blocks with `data-section`
 * / `data-testid` attributes. The actual prod selectors evolve with
 * NeGD's frontend releases so we list multiple known variants and
 * take the first one that yields data.
 */
const myschemeExtractor: PortalExtractor = {
  name: 'myscheme.gov.in',
  matches(url) {
    return hostMatches(url, 'myscheme.gov.in');
  },
  enrich($, generic) {
    const out: Partial<SchemeObject> = {};

    // Name — myScheme uses a prominent h1 with class `scheme-name` OR
    // a data-testid hook on the scheme card.
    const name = firstNonEmpty($, [
      '[data-testid="schemeName"]',
      'h1.scheme-name',
      'h1.SchemeName',
      'header h1',
    ]);
    if (name && !generic.name) out.name = name;

    // Description — the "Details" section typically opens with a long
    // paragraph; meta description is a reliable fallback.
    const description =
      firstNonEmpty($, [
        '[data-section="details"] p',
        '.scheme-details p:first-of-type',
      ]) ?? firstAttr($, ['meta[name="description"]', 'meta[property="og:description"]'], 'content');
    if (description && !generic.description) out.description = description;

    // Ministry / Department / Nodal agency.
    const ministry = firstNonEmpty($, [
      '[data-field="ministry"]',
      '[data-field="nodal-ministry"]',
      '.nodal-ministry-value',
      '.scheme-ministry',
    ]);
    if (ministry) out.ministry = ministry;

    // Eligibility — strongly preferred over generic when present.
    const eligibilityItems = extractListItems($, [
      '[data-section="eligibility"] li',
      '#eligibility li',
      '.eligibility-section li',
    ]);
    if (eligibilityItems.length > 0) {
      out.eligibilityCriteria = toEligibility(eligibilityItems);
    }

    // Benefits.
    const benefitItems = extractListItems($, [
      '[data-section="benefits"] li',
      '#benefits li',
      '.benefits-section li',
    ]);
    if (benefitItems.length > 0) {
      out.benefits = toBenefits(benefitItems);
    }

    return out;
  },
};

// ─── india.gov.in extractor ─────────────────────────────────────────────────

/**
 * india.gov.in is a Drupal site whose scheme/content pages render
 * inside a `field--name-body` wrapper. Most structured fields live
 * inside that wrapper as `<dl>` definition lists or as headed
 * sections.
 */
const indiaGovExtractor: PortalExtractor = {
  name: 'india.gov.in',
  matches(url) {
    return hostMatches(url, 'india.gov.in');
  },
  enrich($, generic) {
    const out: Partial<SchemeObject> = {};

    // Name — Drupal page-title block.
    const name = firstNonEmpty($, [
      'h1.page-title',
      '.block-page-title-block h1',
      'h1.title',
      'header h1',
    ]);
    if (name && !generic.name) out.name = name;

    // Description — first paragraph inside body field, OR meta tag.
    const description =
      firstNonEmpty($, [
        '.field--name-body p:first-of-type',
        '.field-name-body p:first-of-type',
        '.node--type-scheme .body p',
      ]) ?? firstAttr($, ['meta[name="description"]'], 'content');
    if (description && !generic.description) out.description = description;

    // Ministry — sourced from a `field--name-field-ministry` element
    // OR a definition-list term/data pair.
    const ministry =
      firstNonEmpty($, [
        '.field--name-field-ministry .field__item',
        '.field--name-field-nodal-ministry .field__item',
        '.field-name-field-ministry',
      ]) ?? extractDlValue($, /^(ministry|department|nodal\s+ministry)$/i);
    if (ministry) out.ministry = ministry;

    // Eligibility — usually inside a section with id="eligibility" or
    // a Drupal field.
    const eligibilityItems = extractListItems($, [
      '#eligibility li',
      '.field--name-field-eligibility li',
      '.eligibility li',
    ]);
    if (eligibilityItems.length > 0) {
      out.eligibilityCriteria = toEligibility(eligibilityItems);
    }

    // Benefits.
    const benefitItems = extractListItems($, [
      '#benefits li',
      '.field--name-field-benefits li',
      '.benefits li',
    ]);
    if (benefitItems.length > 0) {
      out.benefits = toBenefits(benefitItems);
    }

    return out;
  },
};

// ─── services.india.gov.in extractor ────────────────────────────────────────

/**
 * services.india.gov.in is a service-catalogue rather than a scheme
 * portal — pages describe "services" with `.service-detail` blocks.
 * We still treat well-classified service pages as scheme candidates
 * because many of them ARE schemes (PM-KISAN, Ayushman Bharat, etc.)
 * presented through the services lens.
 */
const servicesIndiaExtractor: PortalExtractor = {
  name: 'services.india.gov.in',
  matches(url) {
    return hostMatches(url, 'services.india.gov.in');
  },
  enrich($, generic) {
    const out: Partial<SchemeObject> = {};

    const name = firstNonEmpty($, [
      '.service-title',
      '.service-detail h1',
      'h1.service-name',
      'header h1',
    ]);
    if (name && !generic.name) out.name = name;

    const description =
      firstNonEmpty($, [
        '.service-description',
        '.service-detail .description',
        '.service-detail p:first-of-type',
      ]) ?? firstAttr($, ['meta[name="description"]'], 'content');
    if (description && !generic.description) out.description = description;

    const ministry =
      firstNonEmpty($, [
        '.service-ministry',
        '.service-detail .ministry',
        '.parent-ministry',
      ]) ?? extractDlValue($, /^(ministry|department|provider)$/i);
    if (ministry) out.ministry = ministry;

    // Eligibility & benefits are less consistent on services portal;
    // try the obvious id selectors and fall back to the generic
    // heading-driven extraction the caller has already attempted.
    const eligibilityItems = extractListItems($, [
      '#eligibility li',
      '.service-eligibility li',
    ]);
    if (eligibilityItems.length > 0) {
      out.eligibilityCriteria = toEligibility(eligibilityItems);
    }

    const benefitItems = extractListItems($, [
      '#benefits li',
      '.service-benefits li',
    ]);
    if (benefitItems.length > 0) {
      out.benefits = toBenefits(benefitItems);
    }

    return out;
  },
};

// ─── scholarships.gov.in (NSP) extractor ────────────────────────────────────

/**
 * NSP is a JSP application — scheme detail pages render in a server-
 * rendered table layout with `<th>Label</th><td>value</td>` rows. The
 * keys are stable across schemes ("Eligibility", "Benefits", "Last
 * Date", etc.) so a table-row lookup gives us reliable extraction.
 */
const nspExtractor: PortalExtractor = {
  name: 'scholarships.gov.in',
  matches(url) {
    return hostMatches(url, 'scholarships.gov.in');
  },
  enrich($, generic) {
    const out: Partial<SchemeObject> = {};

    const name = firstNonEmpty($, [
      '.scheme-title',
      'h1.scheme-name',
      'h2.scheme-name',
      'header h1',
    ]);
    if (name && !generic.name) out.name = name;

    const descriptionRaw =
      firstNonEmpty($, [
        '.scheme-description',
        '.scheme-detail-description',
      ]) ?? extractTableRow($, /^(description|about\s+the\s+scheme|scheme\s+description)$/i)
        ?? firstAttr($, ['meta[name="description"]'], 'content');
    // Description is a single-line field; collapse any newlines the
    // table-row extractor preserved.
    const description = descriptionRaw
      ? descriptionRaw.replace(/\s+/g, ' ').trim()
      : null;
    if (description && !generic.description) out.description = description;

    const ministryRaw =
      firstNonEmpty($, ['.scheme-ministry', '.nodal-ministry']) ??
      extractTableRow($, /^(ministry|department|nodal\s+ministry)$/i);
    const ministry = ministryRaw
      ? ministryRaw.replace(/\s+/g, ' ').trim()
      : null;
    if (ministry) out.ministry = ministry;

    // NSP tables list eligibility as a single multi-line cell. Split
    // on newlines / bullet markers when we find it.
    const eligibilityText = extractTableRow(
      $,
      /^(eligibility|eligibility\s+criteria)$/i,
    );
    if (eligibilityText) {
      const items = splitMultilineCell(eligibilityText);
      if (items.length > 0) {
        out.eligibilityCriteria = toEligibility(items);
      }
    }

    const benefitsText = extractTableRow($, /^(benefits|scheme\s+benefits)$/i);
    if (benefitsText) {
      const items = splitMultilineCell(benefitsText);
      if (items.length > 0) {
        out.benefits = toBenefits(items);
      }
    }

    return out;
  },
};

// ─── igod.gov.in extractor ──────────────────────────────────────────────────

/**
 * iGOD is an open-data catalogue (CKAN-style). Scheme references on
 * iGOD come as dataset descriptions — there are no structured
 * eligibility / benefits fields. We extract title + description only
 * and let the generic heading extractor handle anything else.
 */
const igodExtractor: PortalExtractor = {
  name: 'igod.gov.in',
  matches(url) {
    return hostMatches(url, 'igod.gov.in');
  },
  enrich($, generic) {
    const out: Partial<SchemeObject> = {};

    const name = firstNonEmpty($, [
      'h1.dataset-title',
      'h1.title',
      '.dataset h1',
      'header h1',
    ]);
    if (name && !generic.name) out.name = name;

    const description =
      firstNonEmpty($, [
        '.dataset-description',
        '.notes',
        '.dataset-content p:first-of-type',
      ]) ?? firstAttr($, ['meta[name="description"]'], 'content');
    if (description && !generic.description) out.description = description;

    const ministry =
      firstNonEmpty($, ['.dataset-organization', '.organization-title']) ??
      extractDlValue($, /^(organization|publisher|department|ministry)$/i);
    if (ministry) out.ministry = ministry;

    return out;
  },
};

// ─── Registration & router ──────────────────────────────────────────────────

const PORTAL_EXTRACTORS: readonly PortalExtractor[] = [
  // Order matters: more-specific hostnames (services.india.gov.in,
  // scholarships.gov.in) must appear BEFORE the broader india.gov.in
  // suffix match so the router picks the most-specific extractor.
  myschemeExtractor,
  servicesIndiaExtractor,
  nspExtractor,
  indiaGovExtractor,
  igodExtractor,
];

/**
 * Find the first matching portal extractor for the given URL, or null
 * when no portal-specific knowledge applies (e.g. a long-tail ministry
 * site that the generic extractor handles by itself).
 */
export function findPortalExtractor(url: string): PortalExtractor | null {
  for (const extractor of PORTAL_EXTRACTORS) {
    if (extractor.matches(url)) return extractor;
  }
  return null;
}

/**
 * Apply portal-aware enrichment on top of a generic-parser result.
 *
 * Implementation contract:
 *   - Always returns a Partial<SchemeObject>. Never throws.
 *   - When no portal extractor matches the URL, returns `generic`
 *     unchanged so the caller can use this as a no-op router.
 *   - When a portal extractor matches and returns enrichments, those
 *     enrichments OVERRIDE the generic result field-by-field. Fields
 *     the portal extractor doesn't return are left untouched.
 *   - Optional fields (applicationProcess, requiredDocuments, deadline)
 *     are NOT touched by portal extractors today — they continue to
 *     come from the generic extractor.
 */
export function extractWithPortalAwareness(
  html: string,
  url: string,
  generic: Partial<SchemeObject>,
): Partial<SchemeObject> {
  const extractor = findPortalExtractor(url);
  if (!extractor) return generic;

  let enrichment: Partial<SchemeObject> = {};
  try {
    const $ = cheerio.load(html ?? '');
    enrichment = extractor.enrich($, generic, url);
  } catch {
    // Portal extractor failure must not break the pipeline — the
    // generic result is always a safe baseline.
    return generic;
  }

  return { ...generic, ...enrichment };
}

// ─── Selector helpers shared across portal extractors ───────────────────────

/**
 * Looks for `<dt>label</dt><dd>value</dd>` pairs in any definition
 * list on the page and returns the value text when the label matches
 * the given regex. Returns the first match (definition lists are
 * typically not duplicated for the same key on a scheme page).
 */
function extractDlValue($: CheerioAPI, labelRegex: RegExp): string | null {
  let found: string | null = null;
  $('dl').each((_, dl) => {
    if (found) return;
    const $dl = $(dl);
    const dts = $dl.find('dt');
    dts.each((_idx, dt) => {
      const label = clean($(dt).text());
      if (label && labelRegex.test(label)) {
        const dd = $(dt).next('dd');
        const value = clean(dd.text());
        if (value) {
          found = value;
        }
      }
    });
  });
  return found;
}

/**
 * Looks for `<th>label</th><td>value</td>` rows in any table on the
 * page and returns the value text when the label matches the given
 * regex. Used by NSP-style pages where scheme metadata is rendered as
 * a server-side HTML table.
 *
 * Line breaks inside the value cell are PRESERVED — NSP cells frequently
 * contain multi-line content (eligibility bullets separated by `<br>`
 * tags or literal newlines), and {@link splitMultilineCell} needs those
 * separators to bucket the cell into discrete items. We replace `<br>`
 * and `<li>` boundaries with `\n` before reading text content so both
 * source styles produce the same split.
 */
function extractTableRow($: CheerioAPI, labelRegex: RegExp): string | null {
  let found: string | null = null;
  $('table tr').each((_, tr) => {
    if (found) return;
    const $tr = $(tr);
    const th = $tr.find('th').first();
    const labelText = clean(th.text());
    if (labelText && labelRegex.test(labelText)) {
      const td = $tr.find('td').first();
      const value = cellTextPreservingBreaks($, td);
      if (value) {
        found = value;
      }
    }
  });
  return found;
}

/**
 * Read the visible text of a cell while preserving the line breaks the
 * HTML author used to separate items. `<br>` tags are converted to `\n`,
 * each `<li>` boundary is converted to `\n`, then we trim and return
 * the result WITHOUT collapsing internal whitespace (so a downstream
 * splitter can use the newlines).
 */
function cellTextPreservingBreaks(
  $: CheerioAPI,
  $cell: ReturnType<CheerioAPI>,
): string | null {
  if ($cell.length === 0) return null;
  // Work on a clone so the source DOM stays intact for any subsequent
  // selectors that might run against the same page.
  const cloned = $cell.clone();
  cloned.find('br').replaceWith('\n');
  cloned.find('li').each((_, li) => {
    $(li).append('\n');
  });
  const raw = cloned.text();
  if (typeof raw !== 'string') return null;
  // Trim trailing whitespace on each line but keep newline structure.
  const normalised = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return normalised.length > 0 ? normalised : null;
}

/**
 * Splits a multi-line table-cell value into discrete bullet items.
 * NSP cells often contain content like:
 *
 *   - Indian citizen
 *   - Annual family income below ₹2.5 lakh
 *   - Age between 18 and 35
 *
 * rendered as a single string with newlines and/or bullet glyphs.
 */
function splitMultilineCell(text: string): string[] {
  return text
    .split(/(?:\r?\n|\u2022|\u25cf|;)+/)
    .map((part) => clean(part))
    .filter((part): part is string => part !== null && part.length > 1);
}
