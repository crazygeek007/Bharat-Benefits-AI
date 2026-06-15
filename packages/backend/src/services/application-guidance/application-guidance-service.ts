/**
 * Application Guidance Service — produces the step-by-step application
 * instructions surfaced when a Citizen taps "Apply" on a Scheme.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5.
 *
 * Responsibilities:
 *   - Build numbered step-by-step application instructions, each with an
 *     `action` and `expectedOutcome` (Req 9.1).
 *   - Surface the official application URL (Req 9.2).
 *   - List at least 3 common mistakes — preferring scheme-specific mistakes
 *     extracted from the official description, with a per-category fallback
 *     of three or more generic mistakes (Req 9.3).
 *   - Indicate online / offline / hybrid mode and, for offline + hybrid,
 *     return the parsed office name(s) and address(es) (Req 9.4).
 *   - Probe the official portal with a configurable timeout so the UI can
 *     warn the citizen if the portal is unreachable (Req 9.5).
 *
 * The `checkPortalAccessible` helper is exposed on the class so the same
 * probe contract can be reused by callers (e.g., the assistant pipeline).
 *
 * The Prisma surface is declared structurally so unit tests can drop in a
 * fake without standing up a database.
 */

import type { ApplicationStep, SchemeCategory } from '@bharat-benefits/shared';
import prisma from '../../lib/prisma';

// ─── Public types ────────────────────────────────────────────────────────────

/** Application mode label exposed to the UI (Req 9.4). */
export type ApplicationMode = 'online' | 'offline' | 'hybrid';

/**
 * Result of `getGuidance` (Req 9.1, 9.2, 9.3, 9.4, 9.5).
 *
 * `applicationUrl` may be `null` when the official source did not publish
 * a portal link — the UI should fall back to the office addresses for
 * offline/hybrid modes.
 *
 * `officeAddresses` is `null` for purely online schemes; for offline /
 * hybrid schemes it carries every office line parsed from the official
 * description (Req 9.4). An empty array is normalised to `null` so the UI
 * can rely on a single "missing data" check.
 *
 * `portalAccessible` is `null` when no probe was performed (e.g. the
 * scheme has no portal URL or the caller did not request a probe). When
 * the probe runs it is `true` if the portal responded within the timeout
 * and `false` otherwise (Req 9.5 — the caller is expected to surface the
 * last verified date and an alternate contact in that case).
 */
export interface ApplicationGuidance {
  steps: ApplicationStep[];
  applicationUrl: string | null;
  mode: ApplicationMode;
  commonMistakes: string[];
  officeAddresses: string[] | null;
  portalAccessible: boolean | null;
}

/**
 * HTTP probe contract used by `checkPortalAccessible`. Decoupling from the
 * global `fetch` lets unit tests stub the network without touching globals
 * or relying on network availability.
 */
export interface HttpProbe {
  /**
   * Returns `true` if the portal at `url` responded within `timeoutMs`,
   * `false` otherwise. Implementations MUST treat any thrown error
   * (timeout, DNS failure, connection refused) as `false` rather than
   * propagating — the public contract only signals reachability.
   */
  probe(url: string, timeoutMs: number): Promise<boolean>;
}

/** Options for `getGuidance`. */
export interface GetGuidanceOptions {
  /**
   * When true (default), `getGuidance` runs the HTTP probe against
   * `applicationUrl` and populates `portalAccessible`. Set to `false` to
   * skip the network call (e.g. for cached responses).
   */
  probePortal?: boolean;
  /**
   * Per-call probe timeout override. Defaults to
   * `DEFAULT_PORTAL_PROBE_TIMEOUT_MS`.
   */
  probeTimeoutMs?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Req 9.5 — portal is considered inaccessible after 30 seconds. */
export const DEFAULT_PORTAL_PROBE_TIMEOUT_MS = 30_000;

/** Req 9.3 — the platform must surface at least three common mistakes. */
export const MIN_COMMON_MISTAKES = 3;

// ─── Prisma surface ──────────────────────────────────────────────────────────

/**
 * Minimal Prisma surface this service needs. Declared locally so unit
 * tests can supply an in-memory fake without depending on the generated
 * Prisma types or running a database.
 */
export interface ApplicationGuidancePrisma {
  scheme: {
    findUnique(args: { where: { id: string } }): Promise<SchemeRow | null>;
  };
}

/** Subset of the `Scheme` row used by the guidance service. */
export interface SchemeRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  applicationMode: string | null;
  applicationUrl: string | null;
  applicationSteps: unknown;
  sourceUrl: string;
}

// ─── Default common-mistakes fallbacks (Req 9.3) ─────────────────────────────

/**
 * Generic application mistakes that apply to nearly every Indian
 * government scheme. Used as the universal fallback when neither the
 * scheme description nor the per-category list provides three suggestions.
 *
 * Each entry is phrased as a concrete, actionable warning so citizens can
 * self-check before submitting.
 */
const GENERIC_COMMON_MISTAKES: readonly string[] = [
  'Submitting an incomplete application without all required mandatory documents.',
  'Entering personal details (name, age, address) that do not match your Aadhaar or supporting ID.',
  'Missing the official deadline by submitting after the published cut-off date.',
  'Uploading documents in an unsupported file format or above the maximum size limit.',
  'Skipping the final acknowledgement / submission confirmation and assuming the application was filed.',
];

/**
 * Per-category common-mistake fallbacks. Each list contains at least three
 * scheme-category-specific mistakes so the service can satisfy Req 9.3
 * even when the official source does not enumerate them. The exhaustive
 * `Record<SchemeCategory, ...>` type keeps the fallback set in sync with
 * the supported category list.
 */
const CATEGORY_COMMON_MISTAKES: Record<SchemeCategory, readonly string[]> = {
  Education: [
    'Forgetting to attach the latest mark sheet or admission proof.',
    'Listing a bank account that is not in the student or parent name as recorded in the institution records.',
    'Missing the institution-level verification step before the state-level deadline.',
  ],
  Agriculture: [
    'Submitting land records that are out of date or not in the applicant\'s name.',
    'Skipping Aadhaar seeding of the bank account, which blocks Direct Benefit Transfer credits.',
    'Selecting an incorrect crop / season code mismatched with the land records.',
  ],
  Healthcare: [
    'Not attaching the latest medical certificate from a government-empanelled hospital.',
    'Selecting the wrong empanelled hospital in the application form.',
    'Missing the income certificate that establishes the BPL / SECC eligibility category.',
  ],
  Women: [
    'Missing the marriage / widowhood certificate where required for the scheme category.',
    'Listing a bank account that is not solely in the woman beneficiary\'s name.',
    'Skipping the self-declaration form mandated for women-specific schemes.',
  ],
  Employment: [
    'Forgetting to register on the relevant employment exchange or Skill India portal first.',
    'Submitting an out-of-date résumé or without the verified work-experience proof.',
    'Skipping the in-person verification step at the local employment office.',
  ],
  'Skill Development': [
    'Choosing a training centre that is not affiliated with the scheme implementing agency.',
    'Missing the previous qualification certificate required for course eligibility.',
    'Forgetting to complete the pre-assessment test before applying for the training slot.',
  ],
  Housing: [
    'Submitting land records or property documents that conflict with the village revenue records.',
    'Missing the affidavit declaring no other government-assisted house in the family.',
    'Listing co-applicants whose Aadhaar details do not match the land/property records.',
  ],
  Startups: [
    'Filing without a valid DPIIT recognition number where the scheme requires one.',
    'Submitting an incomplete pitch deck or business plan against the published template.',
    'Missing the founder Aadhaar / PAN linkage required for due-diligence.',
  ],
  MSME: [
    'Applying without an active Udyam / Udyog Aadhaar registration.',
    'Submitting GST returns or financial statements that are inconsistent with the Udyam record.',
    'Missing the bank account statement covering the last six months.',
  ],
  Pension: [
    'Submitting an age proof that disagrees with the Aadhaar-recorded date of birth.',
    'Missing the life certificate / Jeevan Pramaan submission required for ongoing pension disbursal.',
    'Listing a bank account that is not Aadhaar-seeded for Direct Benefit Transfer.',
  ],
  Scholarships: [
    'Missing the bonafide / institution verification step on the National Scholarship Portal.',
    'Submitting a family income certificate older than the financial year required by the scheme.',
    'Forgetting to renew the scholarship application in subsequent academic years.',
  ],
  'Financial Assistance': [
    'Submitting a bank account that is not in the applicant\'s name or not Aadhaar-linked.',
    'Missing the income / BPL / SECC certificate that establishes the eligibility band.',
    'Filing an incomplete affidavit or self-declaration mandated by the scheme guidelines.',
  ],
};

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalises the scheme's `applicationMode` column to the public
 * `ApplicationMode` enum. Unknown / missing values default to `'online'`
 * so the citizen-facing UI can still render — most schemes default to an
 * online portal even when the source does not flag the mode explicitly.
 */
export function normalizeApplicationMode(raw: string | null | undefined): ApplicationMode {
  if (typeof raw !== 'string') return 'online';
  const value = raw.trim().toLowerCase();
  if (value === 'offline') return 'offline';
  if (value === 'hybrid') return 'hybrid';
  return 'online';
}

/**
 * Re-numbers parsed steps so the citizen-facing list always reads
 * `1, 2, 3, …` regardless of how the official source numbered them.
 * Step entries that fail validation (missing `action`) are dropped — an
 * empty action would render as a blank bullet.
 */
export function normalizeApplicationSteps(raw: unknown): ApplicationStep[] {
  if (!Array.isArray(raw)) return [];
  const out: ApplicationStep[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const action = typeof e.action === 'string' ? e.action.trim() : '';
    if (!action) continue;
    const expected =
      typeof e.expectedOutcome === 'string' ? e.expectedOutcome.trim() : '';
    out.push({
      stepNumber: out.length + 1,
      action,
      expectedOutcome: expected,
    });
  }
  return out;
}

/**
 * Looks up the canonical category fallback list. Returns the generic list
 * when the category is not one of the supported `SchemeCategory` values.
 */
export function getCategoryFallbackMistakes(
  category: string | null | undefined,
): readonly string[] {
  if (!category) return GENERIC_COMMON_MISTAKES;
  const list = CATEGORY_COMMON_MISTAKES[category as SchemeCategory];
  return list ?? GENERIC_COMMON_MISTAKES;
}

/**
 * Extracts up to a handful of explicit "common mistakes" lines from the
 * scheme description. Looks for a labelled section ("Common Mistakes",
 * "Mistakes to Avoid", "Avoid these mistakes") followed by a bullet /
 * numbered list. Returns an empty array when no such section exists.
 *
 * The parser is intentionally conservative — we only surface mistakes
 * that a human author labelled as such, rather than guessing from the
 * surrounding prose.
 */
export function extractCommonMistakesFromDescription(
  description: string | null | undefined,
): string[] {
  if (typeof description !== 'string' || description.trim() === '') return [];

  const headingRe =
    /(common mistakes(?: to avoid)?|mistakes to avoid|avoid (?:these|the following) mistakes|things to avoid|do not)\s*[:\-—]?\s*\n/i;
  const match = headingRe.exec(description);
  if (!match) return [];

  const after = description.slice(match.index + match[0].length);

  // Stop at the next blank line or the next top-level heading-like line.
  const stopRe = /\n\s*\n|\n\s*[A-Z][^\n]{0,60}:\s*\n/;
  const stopMatch = stopRe.exec(after);
  const block = stopMatch ? after.slice(0, stopMatch.index) : after;

  const lines = block
    .split('\n')
    .map((line) => line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);

  return lines;
}

/**
 * Extracts office name(s) / address(es) from the official description for
 * offline + hybrid schemes. Looks for a labelled section ("Office Address",
 * "Submit at", "Submission Office") followed by a bullet / numbered list
 * or a single line, and falls back to scanning for free-form lines that
 * begin with "Office" / "Address". Returns an empty array when no offices
 * can be identified — callers normalise this to `null` for the public
 * `officeAddresses` field.
 */
export function extractOfficeAddresses(
  description: string | null | undefined,
): string[] {
  if (typeof description !== 'string' || description.trim() === '') return [];

  const headingRe =
    /(office addresses?|submission office|submit (?:at|to)|where to apply|office name(?: and address)?)\s*[:\-—]?\s*\n/i;
  const match = headingRe.exec(description);

  let block: string;
  if (match) {
    const after = description.slice(match.index + match[0].length);
    const stopRe = /\n\s*\n|\n\s*[A-Z][^\n]{0,60}:\s*\n/;
    const stopMatch = stopRe.exec(after);
    block = stopMatch ? after.slice(0, stopMatch.index) : after;
  } else {
    // Fallback: collect lines that explicitly begin with "Office" / "Address".
    const direct = description
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(office|address)\s*[:\-—]/i.test(line))
      .map((line) => line.replace(/^(office|address)\s*[:\-—]\s*/i, '').trim())
      .filter((line) => line.length > 0);
    return direct;
  }

  return block
    .split('\n')
    .map((line) => line.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Combines scheme-specific mistakes (extracted from the description) with
 * the per-category fallback list, deduplicating on a normalised form, and
 * guarantees at least `MIN_COMMON_MISTAKES` entries — falling through to
 * the generic list if needed (Req 9.3).
 */
export function buildCommonMistakes(
  description: string | null | undefined,
  category: string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  // 1. Scheme-specific mistakes (highest priority).
  for (const line of extractCommonMistakesFromDescription(description)) {
    push(line);
  }

  // 2. Category-specific fallback.
  if (out.length < MIN_COMMON_MISTAKES) {
    for (const line of getCategoryFallbackMistakes(category)) {
      push(line);
      if (out.length >= MIN_COMMON_MISTAKES) break;
    }
  }

  // 3. Generic fallback to guarantee the minimum (Req 9.3).
  if (out.length < MIN_COMMON_MISTAKES) {
    for (const line of GENERIC_COMMON_MISTAKES) {
      push(line);
      if (out.length >= MIN_COMMON_MISTAKES) break;
    }
  }

  return out;
}

// ─── Default HTTP probe ──────────────────────────────────────────────────────

/**
 * Default `HttpProbe` implementation backed by the global `fetch` API.
 *
 * Uses an HTTP `HEAD` request because we only care about reachability and
 * a HEAD avoids downloading the full portal page. Falls back to `GET` if
 * the server explicitly rejects HEAD with `405 Method Not Allowed`. Any
 * thrown error (network failure, abort) is normalised to `false`.
 */
export class FetchHttpProbe implements HttpProbe {
  async probe(url: string, timeoutMs: number): Promise<boolean> {
    if (typeof url !== 'string' || url.trim() === '') return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      if (res.status === 405) {
        res = await fetch(url, { method: 'GET', signal: controller.signal });
      }
      // 2xx / 3xx are considered reachable. 4xx / 5xx mean the portal is
      // up but blocking — still reachable from the citizen's perspective
      // because the page renders (e.g. a 401 login wall).
      return res.status >= 200 && res.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

const defaultHttpProbe: HttpProbe = new FetchHttpProbe();

// ─── ApplicationGuidanceService ──────────────────────────────────────────────

/**
 * `ApplicationGuidanceService` ties the pure helpers above to a database
 * client and an HTTP probe so callers can fetch a scheme's complete
 * application guidance with a single call.
 */
export class ApplicationGuidanceService {
  constructor(
    private readonly db: ApplicationGuidancePrisma = prisma as unknown as ApplicationGuidancePrisma,
    private readonly httpProbe: HttpProbe = defaultHttpProbe,
  ) {}

  /**
   * Builds the citizen-facing application guidance for `schemeId`
   * (Req 9.1, 9.2, 9.3, 9.4, 9.5).
   *
   * Throws `TypeError` when `schemeId` is empty and a `SchemeNotFoundError`
   * when no scheme with that id exists.
   */
  async getGuidance(
    schemeId: string,
    options: GetGuidanceOptions = {},
  ): Promise<ApplicationGuidance> {
    if (!schemeId) {
      throw new TypeError('schemeId is required');
    }

    const row = await this.db.scheme.findUnique({ where: { id: schemeId } });
    if (!row) {
      throw new SchemeNotFoundError(schemeId);
    }

    const mode = normalizeApplicationMode(row.applicationMode);
    const steps = normalizeApplicationSteps(row.applicationSteps);
    const commonMistakes = buildCommonMistakes(row.description, row.category);

    let officeAddresses: string[] | null = null;
    if (mode === 'offline' || mode === 'hybrid') {
      const parsed = extractOfficeAddresses(row.description);
      officeAddresses = parsed.length > 0 ? parsed : null;
    }

    let portalAccessible: boolean | null = null;
    const probePortal = options.probePortal ?? true;
    if (probePortal && row.applicationUrl) {
      const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PORTAL_PROBE_TIMEOUT_MS;
      portalAccessible = await this.checkPortalAccessible(
        row.applicationUrl,
        timeoutMs,
      );
    }

    return {
      steps,
      applicationUrl: row.applicationUrl ?? null,
      mode,
      commonMistakes,
      officeAddresses,
      portalAccessible,
    };
  }

  /**
   * Probes the official portal for reachability with the given timeout.
   * Re-exposed on the class so callers can drive their own portal-status
   * banners without standing up a fresh probe instance.
   */
  async checkPortalAccessible(
    url: string,
    timeoutMs: number = DEFAULT_PORTAL_PROBE_TIMEOUT_MS,
  ): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    return this.httpProbe.probe(url, timeoutMs);
  }
}

/** Thrown when `getGuidance` is called with an unknown scheme id. */
export class SchemeNotFoundError extends Error {
  constructor(public readonly schemeId: string) {
    super(`Scheme not found: ${schemeId}`);
    this.name = 'SchemeNotFoundError';
  }
}

/** Default singleton suitable for HTTP handlers and downstream services. */
export const applicationGuidanceService = new ApplicationGuidanceService();
