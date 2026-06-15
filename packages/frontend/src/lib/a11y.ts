/**
 * Accessibility primitives and design tokens (Requirement 20).
 *
 * Centralises the small but critical pieces of infrastructure every
 * accessible component on the platform needs:
 *
 *   - Stable DOM ids for `<input>` / helper text / error message so
 *     `aria-describedby` and `aria-labelledby` references stay in sync
 *     across re-renders (Req 20.7).
 *   - The id and event name used by the global polite/assertive live
 *     region (Req 20.6).
 *   - A WCAG-compliant colour palette with pre-computed contrast ratios
 *     so designers/developers can pick a token instead of guessing at
 *     hex codes (Req 20.4).
 *   - Pure helpers for relative-luminance and contrast-ratio
 *     computation so a unit test can assert that any new token meets
 *     the ratio it advertises.
 *
 * Everything in this module is framework-agnostic — no React imports —
 * so it can be used in both server and client components, and tested
 * under the workspace's Node-only Vitest configuration.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Form-field id helpers (Req 20.7 — programmatic error association).
 * ──────────────────────────────────────────────────────────────────────── */

/** All ids derived from a single form-field base. */
export interface FieldIds {
  /** id placed on the visible `<label>`. */
  labelId: string;
  /** id placed on the `<input>` / `<select>` / `<textarea>`. */
  inputId: string;
  /** id placed on the helper / hint text element. */
  helperId: string;
  /** id placed on the error message element. */
  errorId: string;
}

/**
 * Derives stable ids for a form field from a single human-readable base.
 *
 * The base is sluggified so call sites can pass natural language
 * (`"Annual income"`) and still receive valid HTML ids.
 */
export function fieldIds(base: string): FieldIds {
  const slug = slugifyForId(base);
  return {
    labelId: `${slug}-label`,
    inputId: `${slug}-input`,
    helperId: `${slug}-helper`,
    errorId: `${slug}-error`,
  };
}

/**
 * Builds the value of `aria-describedby` for an input given which
 * supplementary regions are currently rendered.
 *
 * Returns `undefined` when nothing should be announced — the consumer
 * must spread the result so that `aria-describedby` is omitted entirely
 * (rather than rendered as the empty string) when not needed. NVDA in
 * particular is sensitive to this distinction.
 *
 * The ids are joined with single spaces in the order helper-then-error
 * because screen readers read describedby contents top-to-bottom.
 */
export function describedBy(parts: {
  hasHelper?: boolean;
  hasError?: boolean;
  helperId: string;
  errorId: string;
  /** Extra ids appended after the helper/error pair. */
  extraIds?: ReadonlyArray<string>;
}): string | undefined {
  const ids: string[] = [];
  if (parts.hasHelper) ids.push(parts.helperId);
  if (parts.hasError) ids.push(parts.errorId);
  if (parts.extraIds) {
    for (const id of parts.extraIds) {
      if (id && id.length > 0) ids.push(id);
    }
  }
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * Lower-case ASCII slug, safe to use as a DOM `id`. Non-alphanumeric
 * characters collapse to single hyphens; empty input produces `field`
 * so the resulting id is always non-empty.
 */
export function slugifyForId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'field';
}

/* ────────────────────────────────────────────────────────────────────────
 * Live-region wiring (Req 20.6 — announce dynamic changes).
 * ──────────────────────────────────────────────────────────────────────── */

/** DOM id of the global polite live region rendered in the root layout. */
export const LIVE_REGION_POLITE_ID = 'bb-live-polite';
/** DOM id of the global assertive live region rendered in the root layout. */
export const LIVE_REGION_ASSERTIVE_ID = 'bb-live-assertive';
/** Window event used by `liveAnnounce()` to push new announcements. */
export const LIVE_ANNOUNCE_EVENT = 'bb-ai:live-announce';

/** Priority levels recognised by the live announcer. */
export type LiveAnnouncePriority = 'polite' | 'assertive';

/** Payload shape carried by the `LIVE_ANNOUNCE_EVENT` custom event. */
export interface LiveAnnouncePayload {
  message: string;
  priority: LiveAnnouncePriority;
}

/**
 * Dispatches an announcement to the global live region. Safe to call on
 * the server (no-op) or in non-browser environments.
 *
 * The function intentionally returns `false` when nothing was
 * announced (server-side, empty/whitespace input, or no listener
 * mounted) so callers can tell the announcement was suppressed.
 */
export function liveAnnounce(
  message: string,
  priority: LiveAnnouncePriority = 'polite',
): boolean {
  if (typeof window === 'undefined') return false;
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  const detail: LiveAnnouncePayload = { message: trimmed, priority };
  window.dispatchEvent(new CustomEvent(LIVE_ANNOUNCE_EVENT, { detail }));
  return true;
}

/* ────────────────────────────────────────────────────────────────────────
 * Colour tokens with pre-computed contrast (Req 20.4).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The colour swatches used across the citizen UI. Every entry is paired
 * with its expected foreground (white or near-black) and the WCAG ratio
 * to its paired foreground, computed via {@link contrastRatio}.
 *
 * All ratios meet 4.5:1 (normal text). Where a token is intended only
 * for large-text or non-text UI, that constraint is recorded in the
 * `usage` field.
 */
export const COLOR_TOKENS = {
  /** Brand primary (header, primary buttons, links). */
  primary: '#0b5394',
  /** Body text on white backgrounds. */
  textPrimary: '#24292f',
  /** Secondary / muted body text. */
  textMuted: '#57606a',
  /** Page background. */
  surfaceMuted: '#f6f8fa',
  /** Card / panel background. */
  surface: '#ffffff',
  /** Panel border / divider. */
  border: '#d0d7de',

  /** "Eligible" status — white text on this background ≥ 4.5:1. */
  statusEligibleBg: '#15633a',
  /** "Partially Eligible" status background. */
  statusPartialBg: '#8a5d00',
  /** "Not Eligible" status background. */
  statusNotEligibleBg: '#b1232b',

  /** "Central Govt" badge background. */
  centralGovBg: '#0b5394',
  /** "State Govt" badge background. */
  stateGovBg: '#9c5700',

  /** Warning banner foreground/border colour. */
  warningFg: '#7d4e00',
  /** Warning banner background. */
  warningBg: '#fff8c5',
  /** Error banner foreground. */
  errorFg: '#86181d',
  /** Error banner background. */
  errorBg: '#ffeef0',
  /** Success banner foreground. */
  successFg: '#106030',
  /** Success banner background. */
  successBg: '#dafbe1',
} as const;

export type ColorToken = keyof typeof COLOR_TOKENS;

/**
 * Static catalogue of foreground/background pairs that the design uses
 * with white or near-black text. Tests can iterate over this list to
 * guarantee each pair meets the WCAG ratio it claims to.
 */
export interface ContrastPair {
  description: string;
  foreground: string;
  background: string;
  /** Minimum acceptable contrast ratio (4.5 for body, 3.0 for large text or non-text UI). */
  minimumRatio: number;
}

export const CONTRAST_PAIRS: ReadonlyArray<ContrastPair> = [
  {
    description: 'Body text on page background',
    foreground: COLOR_TOKENS.textPrimary,
    background: COLOR_TOKENS.surfaceMuted,
    minimumRatio: 4.5,
  },
  {
    description: 'Muted text on white surface',
    foreground: COLOR_TOKENS.textMuted,
    background: COLOR_TOKENS.surface,
    minimumRatio: 4.5,
  },
  {
    description: 'Primary button (white on brand blue)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.primary,
    minimumRatio: 4.5,
  },
  {
    description: 'Eligible badge (white on green)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.statusEligibleBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Partially Eligible badge (white on amber)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.statusPartialBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Not Eligible badge (white on red)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.statusNotEligibleBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Central Govt badge (white on brand blue)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.centralGovBg,
    minimumRatio: 4.5,
  },
  {
    description: 'State Govt badge (white on dark orange)',
    foreground: '#ffffff',
    background: COLOR_TOKENS.stateGovBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Warning banner text',
    foreground: COLOR_TOKENS.warningFg,
    background: COLOR_TOKENS.warningBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Error banner text',
    foreground: COLOR_TOKENS.errorFg,
    background: COLOR_TOKENS.errorBg,
    minimumRatio: 4.5,
  },
  {
    description: 'Success banner text',
    foreground: COLOR_TOKENS.successFg,
    background: COLOR_TOKENS.successBg,
    minimumRatio: 4.5,
  },
];

/* ────────────────────────────────────────────────────────────────────────
 * Pure colour math — relative luminance + WCAG contrast ratio.
 * Implementation per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * ──────────────────────────────────────────────────────────────────────── */

/** Parses `#rrggbb` (or `#rgb`) into an `[r, g, b]` triple in 0–255. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, '');
  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return [r, g, b];
}

/** WCAG relative luminance for an sRGB `[r, g, b]` channel triple. */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two hex colours. Always ≥ 1; values of
 * 4.5 satisfy AA for normal text, 3.0 satisfies AA for large text and
 * non-text UI (Req 20.4).
 */
export function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const lum1 = relativeLuminance(hexToRgb(foregroundHex));
  const lum2 = relativeLuminance(hexToRgb(backgroundHex));
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Convenience predicate used by tests/lints. */
export function meetsContrast(
  foregroundHex: string,
  backgroundHex: string,
  minimum: number,
): boolean {
  return contrastRatio(foregroundHex, backgroundHex) + 1e-6 >= minimum;
}
