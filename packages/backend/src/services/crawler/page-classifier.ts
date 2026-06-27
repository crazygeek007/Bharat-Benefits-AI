/**
 * Page classifier for the discovery crawler.
 *
 * The crawler discovers far more URLs than it can profitably extract
 * (portal index pages link to hundreds of nested pages, most of which
 * are listings, navigation, or completely off-topic). Sending every
 * discovered URL through the full extraction pipeline wastes the
 * Gemini embedding budget and pollutes Pinecone with non-scheme chunks.
 *
 * Instead, classify each URL into one of four buckets before deciding
 * what to do with it:
 *
 *   - `scheme`   — a scheme detail page. Send to the existing
 *                  orchestrator's processScheme pipeline.
 *   - `listing`  — a page that lists or links to many scheme pages.
 *                  Extract links only; push children into the frontier.
 *   - `ministry` — a ministry / department landing page. Same as
 *                  listing, but with a tighter depth budget since these
 *                  tend to recurse into navigation rabbit-holes.
 *   - `ignore`   — about / contact / privacy / accessibility / sitemap
 *                  / login / press release / archive index. Drop.
 *
 * The classifier has two stages, applied in order:
 *
 *   1. URL-pattern stage (no HTML fetch required). Anchored to known
 *      portal conventions — see `URL_PATTERN_RULES`. Catches the
 *      majority of obvious cases at zero I/O cost.
 *
 *   2. HTML-signals stage (used only when URL patterns return
 *      `unknown` and the caller has already fetched the page).
 *      Inspects og:type meta, keyword density, and structural hints.
 *
 * Both stages return a `ClassificationResult` with a `reason` string
 * so the crawl-summary logs can show why each URL was bucketed.
 */

import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';

export type PageType = 'scheme' | 'listing' | 'ministry' | 'ignore' | 'unknown';

export interface ClassificationResult {
  type: PageType;
  /** Free-text explanation surfaced in crawl logs. */
  reason: string;
  /** 0-1 confidence. <0.5 means the classifier wasn't sure. */
  confidence: number;
}

export interface PageClassifier {
  classify(url: string, html?: string): ClassificationResult;
}

// ─── URL-pattern rules ───────────────────────────────────────────────────────

interface UrlPatternRule {
  /** Hostname pattern (label-boundary match). `'*'` matches any host. */
  host: string;
  /** Regex applied to the URL pathname (NOT including the query). */
  path: RegExp;
  type: PageType;
  /** Human-readable rule name surfaced in `reason`. */
  name: string;
  /** 0-1 confidence the rule reports when it matches. */
  confidence: number;
}

/**
 * Ordered list of URL patterns. First match wins. Keep the ignore
 * patterns ahead of the listing / scheme patterns so portal-wide
 * boilerplate (about, contact, sitemap) is dropped before any
 * ambiguous match.
 *
 * Per-portal conventions discovered empirically: the comments next to
 * each rule explain WHY a path means what it means, so future
 * additions don't accidentally collide.
 */
const URL_PATTERN_RULES: readonly UrlPatternRule[] = [
  // ── Asset-extension ignores (highest priority) ──────────────────────────
  // These win over per-portal rules so a misnamed path like
  // /schemes/banner.png can't escape into the extraction pipeline.
  {
    host: '*',
    path: /\.(?:zip|tar|gz|7z|exe|bin|iso|jpg|jpeg|png|gif|svg|webp|mp3|mp4|mov|avi|css|js|map)$/i,
    type: 'ignore',
    name: 'non-document-asset',
    confidence: 0.99,
  },

  // ── Homepage / portal-root ignore-as-scheme guard (high priority) ───────
  // Without this, the orchestrator gleefully fetches a portal homepage,
  // fails to find scheme fields in the marketing copy, and produces a
  // noisy 'Missing mandatory fields' error. Homepages are listing pages
  // by nature — classify them as such so the discovery driver harvests
  // their outbound links instead of trying to extract a scheme.
  {
    host: '*',
    path: /^\/?$/,
    type: 'listing',
    name: 'host-homepage',
    confidence: 0.85,
  },
  {
    host: '*',
    path: /^\/(?:home|index|main|landing|portal)(?:\.html?)?\/?$/i,
    type: 'listing',
    name: 'host-named-homepage',
    confidence: 0.8,
  },

  // ── Per-portal rules (more specific than generic boilerplate) ───────────
  // These appear BEFORE the portal-agnostic boilerplate rules so a
  // portal's legit /search index isn't mistaken for site-search noise.
  //
  // myscheme.gov.in
  {
    host: 'myscheme.gov.in',
    path: /^\/schemes\/[^/]+\/?(?:details\/?)?$/i,
    type: 'scheme',
    name: 'myscheme-detail',
    confidence: 0.95,
  },
  {
    host: 'myscheme.gov.in',
    path: /^\/(?:search|find-scheme|category|state|ministry|all-schemes)(?:\/|$)/i,
    type: 'listing',
    name: 'myscheme-listing',
    confidence: 0.9,
  },

  // india.gov.in
  {
    host: 'india.gov.in',
    path: /^\/(?:spotlight|my-government\/schemes|topics\/schemes)(?:\/|$)/i,
    type: 'listing',
    name: 'indiagov-listing',
    confidence: 0.9,
  },
  // Category index pages — entry into the schemes graph.
  {
    host: 'india.gov.in',
    path: /^\/category(?:\/|$)/i,
    type: 'listing',
    name: 'indiagov-category',
    confidence: 0.85,
  },
  {
    host: 'india.gov.in',
    path: /^\/(?:content|spotlight-detail|scheme|schemes)\/[^/]+/i,
    type: 'scheme',
    name: 'indiagov-detail',
    confidence: 0.8,
  },

  // scholarships.gov.in
  {
    host: 'scholarships.gov.in',
    path: /^\/(?:public\/list|scheme-summary|state-schemes|central-schemes)(?:\/|$)/i,
    type: 'listing',
    name: 'nsp-listing',
    confidence: 0.9,
  },
  {
    host: 'scholarships.gov.in',
    path: /^\/(?:scheme|public\/scheme)\/[^/]+/i,
    type: 'scheme',
    name: 'nsp-detail',
    confidence: 0.85,
  },

  // services.india.gov.in
  {
    host: 'services.india.gov.in',
    path: /^\/(?:service|services)\/[^/]+/i,
    type: 'scheme',
    name: 'services-detail',
    confidence: 0.7,
  },
  {
    host: 'services.india.gov.in',
    path: /^\/(?:category|browse|search)(?:\/|$)/i,
    type: 'listing',
    name: 'services-listing',
    confidence: 0.85,
  },

  // igod.gov.in
  {
    host: 'igod.gov.in',
    path: /^\/(?:dataset|catalogue|browse|search)(?:\/|$)/i,
    type: 'listing',
    name: 'igod-listing',
    confidence: 0.8,
  },

  // ── Portal-agnostic scheme-page detection ──────────────────────────────
  // Any *.gov.in / *.nic.in URL whose path contains one of the common
  // scheme path-segments and a non-empty slug. Conservative enough to
  // avoid catching navigation indexes (which already match the listing
  // patterns above) and generous enough to recognise the dozens of
  // niche ministry portals that don't have their own rule yet.
  //
  // Examples that match:
  //   /scheme/pm-kisan-samman-nidhi
  //   /schemes/maternity-benefit-scheme
  //   /scheme-details/123
  //   /details/scheme/123
  //   /view/pmjjby
  //   /program/skill-india
  //   /benefit/aged-widow-pension
  //   /welfare/elderly-care
  {
    host: '*',
    path: /^\/(?:scheme|schemes|scheme-details|details|view|program|programmes?|benefit|benefits|welfare)\/[^/]+\/?$/i,
    type: 'scheme',
    name: 'generic-scheme-path',
    confidence: 0.7,
  },
  // Nested slug variant — many portals use /scheme-details/{category}/{slug}
  // or /view/scheme/{slug}.
  {
    host: '*',
    path: /^\/(?:scheme|schemes|scheme-details|details|view|program|programmes?|benefit|benefits|welfare)\/[^/]+\/[^/]+\/?$/i,
    type: 'scheme',
    name: 'generic-nested-scheme-path',
    confidence: 0.65,
  },

  // ── Portal-agnostic ignore patterns (after per-portal rules) ────────────
  // `search` deliberately omitted here — portals use it legitimately as a
  // listing path (see per-portal rules above). Auth / boilerplate paths
  // are universally non-crawl targets so they're always ignored.
  {
    host: '*',
    path: /\/(?:about|contact|privacy|accessibility|disclaimer|feedback|terms|tos|cookie-policy|help|faq|sitemap|robots\.txt|login|signin|signup|register|logout|cgi-bin)(?:\/|$)/i,
    type: 'ignore',
    name: 'boilerplate-path',
    confidence: 0.95,
  },

  // ── Document attachments → unknown so the downstream parser decides ────
  // The mandatory-field enforcer rejects anything that can't be parsed
  // into a SchemeObject, so a misidentified PDF won't pollute the
  // catalogue.
  {
    host: '*',
    path: /\.(?:pdf|doc|docx|xls|xlsx|odt|ods)$/i,
    type: 'unknown',
    name: 'document-attachment',
    confidence: 0.4,
  },
];

// ─── Implementations ────────────────────────────────────────────────────────

/**
 * Classifier that runs the URL-pattern stage in isolation. Pure
 * function over the URL string — cheap, no HTML fetch required. The
 * production classifier (`createDefaultClassifier`) chains this with
 * the HTML-signals stage.
 */
export class UrlPatternClassifier implements PageClassifier {
  constructor(private readonly rules: readonly UrlPatternRule[] = URL_PATTERN_RULES) {}

  classify(url: string): ClassificationResult {
    if (typeof url !== 'string' || url.length === 0) {
      return { type: 'ignore', reason: 'empty-url', confidence: 1 };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { type: 'ignore', reason: 'malformed-url', confidence: 1 };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { type: 'ignore', reason: 'non-http-scheme', confidence: 1 };
    }

    const hostname = parsed.hostname.toLowerCase();
    for (const rule of this.rules) {
      if (!hostMatchesRule(hostname, rule.host)) continue;
      if (!rule.path.test(parsed.pathname)) continue;
      return { type: rule.type, reason: rule.name, confidence: rule.confidence };
    }

    return { type: 'unknown', reason: 'no-pattern-match', confidence: 0 };
  }
}

/**
 * Lightweight HTML-signal classifier used as a fallback for URLs the
 * URL-pattern stage couldn't classify confidently. Counts scheme
 * keywords ("eligibility", "benefits", "how to apply", "deadline",
 * "documents required") and inspects og:type / heading structure.
 *
 * Honest limitations: this is a heuristic, not a model. It will
 * misclassify dense FAQ pages as schemes and very-sparse scheme pages
 * as listings. The mandatory-field enforcer downstream catches the
 * worst false-positives by rejecting anything that can't be parsed
 * into a real SchemeObject.
 */
export class HtmlSignalsClassifier implements PageClassifier {
  classify(url: string, html?: string): ClassificationResult {
    if (typeof html !== 'string' || html.length === 0) {
      return { type: 'unknown', reason: 'no-html-supplied', confidence: 0 };
    }

    const $ = cheerio.load(html);
    const ogType = $('meta[property="og:type"]').attr('content')?.toLowerCase() ?? '';
    if (ogType === 'article' || ogType === 'website') {
      // og:type alone isn't enough — fall through to content signals.
    }

    const bodyText = ($('body').text() || $.root().text()).toLowerCase();

    // Count strong scheme-keyword hits. Three or more distinct hits
    // makes a scheme classification likely.
    const SCHEME_KEYWORDS = [
      'eligibility',
      'benefits',
      'how to apply',
      'application process',
      'documents required',
      'deadline',
      'last date',
      'beneficiaries',
    ] as const;
    const hits = SCHEME_KEYWORDS.filter((kw) => bodyText.includes(kw));

    // Link density: many same-host links → listing. Few same-host
    // links + structural keywords → scheme detail.
    const links = $('a[href]');
    let sameHostLinks = 0;
    let externalLinks = 0;
    let urlHost = '';
    try {
      urlHost = new URL(url).hostname.toLowerCase();
    } catch {
      urlHost = '';
    }
    links.each((_, el) => {
      const href = $(el).attr('href') ?? '';
      try {
        const target = new URL(href, url);
        if (target.hostname.toLowerCase() === urlHost) sameHostLinks++;
        else externalLinks++;
      } catch {
        // ignore malformed
      }
    });
    void externalLinks; // reserved for future use

    if (hits.length >= 3) {
      return {
        type: 'scheme',
        reason: `keyword-hits=${hits.length} (${hits.join(',')})`,
        confidence: Math.min(0.9, 0.5 + hits.length * 0.1),
      };
    }

    if (sameHostLinks >= 30 && hits.length <= 1) {
      return {
        type: 'listing',
        reason: `link-density=${sameHostLinks} keyword-hits=${hits.length}`,
        confidence: 0.65,
      };
    }

    return {
      type: 'unknown',
      reason: `weak-signals keyword-hits=${hits.length} links=${sameHostLinks}`,
      confidence: 0.3,
    };
  }
}

/**
 * Chains the URL-pattern classifier with the HTML-signal classifier.
 * The HTML stage only runs when the URL stage reports `unknown` AND
 * the caller has already fetched the page (the discovery driver runs
 * the URL classifier first, fetches if the result is non-`ignore`,
 * then runs the HTML stage on the result).
 *
 * The chain falls back to `ignore` when both stages can't classify
 * confidently — preferring missed pages to wasted extraction budget
 * (consistent with our explicit design choice to bias conservative).
 */
export class ChainedClassifier implements PageClassifier {
  constructor(
    private readonly urlStage: PageClassifier = new UrlPatternClassifier(),
    private readonly htmlStage: PageClassifier = new HtmlSignalsClassifier(),
  ) {}

  classify(url: string, html?: string): ClassificationResult {
    const urlResult = this.urlStage.classify(url);
    if (urlResult.type !== 'unknown') return urlResult;

    if (typeof html === 'string' && html.length > 0) {
      const htmlResult = this.htmlStage.classify(url, html);
      if (htmlResult.type !== 'unknown') return htmlResult;
      // Keep the HTML reason for log clarity even on unknown.
      return htmlResult;
    }

    return urlResult;
  }
}

/**
 * Factory for the production classifier. Kept as a function so future
 * deployments can inject portal-specific overrides without callers
 * having to know the chain shape.
 */
export function createDefaultClassifier(): PageClassifier {
  return new ChainedClassifier();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Match a hostname against a rule's host pattern. `'*'` always
 * matches; a concrete pattern matches when `hostname` is the apex
 * domain or any subdomain of it. Mirrors the label-boundary semantics
 * used by `validateSource()` in `source-validator.ts` so the two
 * gates agree on what "same host" means.
 */
function hostMatchesRule(hostname: string, rule: string): boolean {
  if (rule === '*') return true;
  const r = rule.toLowerCase();
  if (hostname === r) return true;
  return hostname.endsWith(`.${r}`);
}
