/**
 * Unit tests for the accessibility utility module.
 *
 * Validates the pieces of `lib/a11y.ts` that other components rely on
 * to satisfy Requirement 20:
 *
 *   - `fieldIds` / `slugifyForId` produce stable, valid HTML ids so
 *     `aria-describedby` and `aria-labelledby` references remain
 *     correctly wired (Req 20.7 — programmatic error association).
 *   - `describedBy` joins ids in the order helper-then-error and
 *     returns `undefined` when nothing should be announced.
 *   - `liveAnnounce` dispatches the correct custom-event payload so
 *     the global `LiveAnnouncer` can pick it up (Req 20.6).
 *   - `contrastRatio` matches the canonical WCAG examples to the third
 *     decimal place, and every entry in `CONTRAST_PAIRS` actually
 *     meets the ratio it claims to (Req 20.4).
 */

import { describe, expect, test, vi } from 'vitest';
import {
  CONTRAST_PAIRS,
  COLOR_TOKENS,
  LIVE_ANNOUNCE_EVENT,
  contrastRatio,
  describedBy,
  fieldIds,
  hexToRgb,
  liveAnnounce,
  meetsContrast,
  relativeLuminance,
  slugifyForId,
} from './a11y';

describe('slugifyForId', () => {
  test('lowercases and replaces non-alphanumeric runs with hyphens', () => {
    expect(slugifyForId('Annual Income (₹/year)')).toBe('annual-income-year');
  });

  test('strips leading and trailing hyphens', () => {
    expect(slugifyForId('---hello---')).toBe('hello');
  });

  test('returns "field" for inputs with no usable characters', () => {
    expect(slugifyForId('---')).toBe('field');
    expect(slugifyForId('')).toBe('field');
    expect(slugifyForId('₹₹₹')).toBe('field');
  });

  test('preserves digits', () => {
    expect(slugifyForId('Field 42')).toBe('field-42');
  });
});

describe('fieldIds', () => {
  test('derives all four ids from a single base', () => {
    const ids = fieldIds('email');
    expect(ids).toEqual({
      labelId: 'email-label',
      inputId: 'email-input',
      helperId: 'email-helper',
      errorId: 'email-error',
    });
  });

  test('slugifies the base before constructing ids', () => {
    const ids = fieldIds('Date of Birth');
    expect(ids.inputId).toBe('date-of-birth-input');
    expect(ids.errorId).toBe('date-of-birth-error');
  });
});

describe('describedBy', () => {
  const ids = { helperId: 'f-helper', errorId: 'f-error' };

  test('returns undefined when nothing should be announced', () => {
    expect(describedBy({ ...ids })).toBeUndefined();
    expect(describedBy({ ...ids, hasHelper: false, hasError: false })).toBeUndefined();
  });

  test('returns helper id only when only the helper is present', () => {
    expect(describedBy({ ...ids, hasHelper: true })).toBe('f-helper');
  });

  test('returns error id only when only the error is present', () => {
    expect(describedBy({ ...ids, hasError: true })).toBe('f-error');
  });

  test('joins helper before error when both are present', () => {
    expect(
      describedBy({ ...ids, hasHelper: true, hasError: true }),
    ).toBe('f-helper f-error');
  });

  test('appends extra ids and skips empty entries', () => {
    expect(
      describedBy({
        ...ids,
        hasHelper: true,
        extraIds: ['extra-1', '', 'extra-2'],
      }),
    ).toBe('f-helper extra-1 extra-2');
  });
});

describe('liveAnnounce', () => {
  test('returns false when called outside the browser', () => {
    // `globalThis.window` is undefined under Vitest's node environment
    // by default, so this exercises the SSR-safety branch.
    expect(liveAnnounce('hello')).toBe(false);
  });

  test('returns false when the message is empty or whitespace', () => {
    // Provide a minimal window shim for this case.
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as unknown as { window: { dispatchEvent: () => boolean } }).window = {
      dispatchEvent: () => true,
    };
    try {
      expect(liveAnnounce('')).toBe(false);
      expect(liveAnnounce('   ')).toBe(false);
    } finally {
      if (original === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = original;
      }
    }
  });

  test('dispatches a CustomEvent with the trimmed message and priority', () => {
    const dispatchEvent = vi.fn();
    const original = (globalThis as { window?: unknown }).window;
    const originalCustomEvent = (globalThis as { CustomEvent?: unknown })
      .CustomEvent;

    class FakeCustomEvent<T> {
      type: string;
      detail: T;
      constructor(type: string, init: { detail: T }) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    (globalThis as { CustomEvent?: unknown }).CustomEvent = FakeCustomEvent;
    (globalThis as { window?: unknown }).window = { dispatchEvent };

    try {
      const announced = liveAnnounce('  Form saved.  ', 'assertive');
      expect(announced).toBe(true);
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      const event = dispatchEvent.mock.calls[0][0] as InstanceType<typeof FakeCustomEvent<{
        message: string;
        priority: string;
      }>>;
      expect(event.type).toBe(LIVE_ANNOUNCE_EVENT);
      expect(event.detail).toEqual({
        message: 'Form saved.',
        priority: 'assertive',
      });
    } finally {
      if (original === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = original;
      }
      if (originalCustomEvent === undefined) {
        delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
      } else {
        (globalThis as { CustomEvent?: unknown }).CustomEvent = originalCustomEvent;
      }
    }
  });
});

describe('hexToRgb', () => {
  test('parses 6-digit hex codes', () => {
    expect(hexToRgb('#0b5394')).toEqual([11, 83, 148]);
    expect(hexToRgb('0b5394')).toEqual([11, 83, 148]);
  });

  test('expands 3-digit hex codes', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000')).toEqual([0, 0, 0]);
  });

  test('throws on invalid input', () => {
    expect(() => hexToRgb('not-a-color')).toThrow();
    expect(() => hexToRgb('#12')).toThrow();
  });
});

describe('relativeLuminance', () => {
  test('white has luminance 1.0', () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  test('black has luminance 0.0', () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  test('white on black yields 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2);
  });

  test('any colour against itself yields 1:1', () => {
    expect(contrastRatio('#0b5394', '#0b5394')).toBeCloseTo(1, 5);
  });

  test('order of arguments does not change the result', () => {
    const a = contrastRatio('#0b5394', '#ffffff');
    const b = contrastRatio('#ffffff', '#0b5394');
    expect(a).toBeCloseTo(b, 5);
  });
});

describe('meetsContrast', () => {
  test('reports pass when ratio is above the threshold', () => {
    expect(meetsContrast('#0b5394', '#ffffff', 4.5)).toBe(true);
  });

  test('reports fail when ratio is below the threshold', () => {
    // Light gray on white — ~1.4:1.
    expect(meetsContrast('#cccccc', '#ffffff', 4.5)).toBe(false);
  });
});

describe('CONTRAST_PAIRS — every documented pair meets WCAG AA', () => {
  for (const pair of CONTRAST_PAIRS) {
    test(`${pair.description} meets ${pair.minimumRatio}:1`, () => {
      const ratio = contrastRatio(pair.foreground, pair.background);
      expect(ratio).toBeGreaterThanOrEqual(pair.minimumRatio);
    });
  }
});

describe('COLOR_TOKENS — sanity', () => {
  test('every token resolves to a valid hex code', () => {
    for (const value of Object.values(COLOR_TOKENS)) {
      expect(() => hexToRgb(value)).not.toThrow();
    }
  });
});
