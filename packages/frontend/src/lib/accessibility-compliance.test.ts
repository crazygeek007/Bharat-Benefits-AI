/**
 * WCAG 2.1 AA Accessibility Compliance Tests (Requirements 20.1–20.7).
 *
 * These tests verify that the accessibility infrastructure satisfies
 * each acceptance criterion from Requirement 20:
 *
 *   20.1 — WCAG 2.1 Level AA conformance (holistic)
 *   20.2 — Keyboard navigation with visible focus indicators
 *   20.3 — ARIA labels for all interactive components
 *   20.4 — 4.5:1 contrast ratio for normal text, 3:1 for large/UI
 *   20.5 — Heading hierarchy and landmark regions
 *   20.6 — ARIA live regions for dynamic content
 *   20.7 — Programmatic error association for form fields
 *
 * @vitest-environment jsdom
 */

import { describe, expect, test } from 'vitest';
import {
  CONTRAST_PAIRS,
  COLOR_TOKENS,
  contrastRatio,
  meetsContrast,
  fieldIds,
  describedBy,
  liveAnnounce,
  LIVE_REGION_POLITE_ID,
  LIVE_REGION_ASSERTIVE_ID,
} from './a11y';
import { validateHeadingHierarchy, getChildHeadingLevel } from './headingHierarchy';
import {
  getFocusableElements,
  trapFocus,
  rovingTabIndex,
  handleHomeEnd,
} from './useKeyboardNavigation';

describe('Requirement 20.2 — Keyboard navigation', () => {
  test('focus indicator uses a colour with sufficient contrast on white', () => {
    // The focus ring is #0b5394 on white (#ffffff)
    const ratio = contrastRatio('#0b5394', '#ffffff');
    // Non-text UI component minimum is 3:1 (WCAG 2.1 SC 1.4.11)
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  test('focus indicator uses a colour with sufficient contrast on page background', () => {
    const ratio = contrastRatio('#0b5394', COLOR_TOKENS.surfaceMuted);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  test('getFocusableElements identifies correct interactive elements', () => {
    const container = document.createElement('div');

    const button = document.createElement('button');
    Object.defineProperty(button, 'offsetWidth', { value: 80 });
    Object.defineProperty(button, 'offsetHeight', { value: 40 });

    const link = document.createElement('a');
    link.setAttribute('href', '/test');
    Object.defineProperty(link, 'offsetWidth', { value: 100 });
    Object.defineProperty(link, 'offsetHeight', { value: 20 });

    const divNonFocusable = document.createElement('div');
    Object.defineProperty(divNonFocusable, 'offsetWidth', { value: 200 });
    Object.defineProperty(divNonFocusable, 'offsetHeight', { value: 40 });

    container.appendChild(button);
    container.appendChild(link);
    container.appendChild(divNonFocusable);

    const focusable = getFocusableElements(container);
    expect(focusable).toHaveLength(2);
    expect(focusable).toContain(button);
    expect(focusable).toContain(link);
  });

  test('trapFocus prevents Tab from escaping a modal-like container', () => {
    const container = document.createElement('div');
    const btn1 = document.createElement('button');
    const btn2 = document.createElement('button');
    Object.defineProperty(btn1, 'offsetWidth', { value: 80 });
    Object.defineProperty(btn1, 'offsetHeight', { value: 40 });
    Object.defineProperty(btn2, 'offsetWidth', { value: 80 });
    Object.defineProperty(btn2, 'offsetHeight', { value: 40 });
    container.appendChild(btn1);
    container.appendChild(btn2);
    document.body.appendChild(container);

    // Focus on last button, Tab should wrap to first
    Object.defineProperty(document, 'activeElement', {
      value: btn2,
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    const result = trapFocus(event, container);
    expect(result).toBe(true);

    document.body.removeChild(container);
  });

  test('rovingTabIndex supports keyboard navigation within widget groups', () => {
    const items: HTMLElement[] = [];
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('button');
      el.setAttribute('tabindex', i === 0 ? '0' : '-1');
      items.push(el);
    }

    Object.defineProperty(document, 'activeElement', {
      value: items[0],
      configurable: true,
    });

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    });
    const handled = rovingTabIndex(event, items, { orientation: 'horizontal' });

    expect(handled).toBe(true);
    expect(items[0].getAttribute('tabindex')).toBe('-1');
    expect(items[1].getAttribute('tabindex')).toBe('0');
  });
});

describe('Requirement 20.3 — ARIA labels for interactive components', () => {
  test('fieldIds generates valid id strings for ARIA references', () => {
    const ids = fieldIds('Annual Income');
    expect(ids.inputId).toBe('annual-income-input');
    expect(ids.labelId).toBe('annual-income-label');
    expect(ids.helperId).toBe('annual-income-helper');
    expect(ids.errorId).toBe('annual-income-error');
  });

  test('fieldIds handles special characters', () => {
    const ids = fieldIds('Date of Birth (DD/MM/YYYY)');
    expect(ids.inputId).toMatch(/^[a-z0-9-]+-input$/);
    // Should not contain any special characters
    expect(ids.inputId).not.toMatch(/[^a-z0-9-]/);
  });

  test('all form field components get unique, non-empty ARIA ids', () => {
    const fields = ['name', 'age', 'income', 'state', 'gender'];
    const allIds = new Set<string>();

    for (const field of fields) {
      const ids = fieldIds(field);
      expect(ids.inputId.length).toBeGreaterThan(0);
      expect(ids.labelId.length).toBeGreaterThan(0);
      expect(ids.errorId.length).toBeGreaterThan(0);
      expect(ids.helperId.length).toBeGreaterThan(0);
      // All ids should be unique
      allIds.add(ids.inputId);
      allIds.add(ids.labelId);
      allIds.add(ids.errorId);
      allIds.add(ids.helperId);
    }
    // 5 fields × 4 ids each = 20 unique ids
    expect(allIds.size).toBe(20);
  });
});

describe('Requirement 20.4 — Contrast ratio compliance', () => {
  test('all documented colour pairs meet their stated minimum ratio', () => {
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(pair.foreground, pair.background);
      expect(
        ratio,
        `${pair.description}: ${ratio.toFixed(2)}:1 should be ≥ ${pair.minimumRatio}:1`,
      ).toBeGreaterThanOrEqual(pair.minimumRatio);
    }
  });

  test('body text (#24292f) on white (#ffffff) exceeds 4.5:1', () => {
    expect(meetsContrast('#24292f', '#ffffff', 4.5)).toBe(true);
  });

  test('body text (#24292f) on page bg (#f6f8fa) exceeds 4.5:1', () => {
    expect(meetsContrast('#24292f', '#f6f8fa', 4.5)).toBe(true);
  });

  test('muted text (#57606a) on white (#ffffff) exceeds 4.5:1', () => {
    expect(meetsContrast('#57606a', '#ffffff', 4.5)).toBe(true);
  });

  test('link colour (#0b5394) on white (#ffffff) exceeds 4.5:1', () => {
    expect(meetsContrast('#0b5394', '#ffffff', 4.5)).toBe(true);
  });

  test('error text (#86181d) on error bg (#ffeef0) exceeds 4.5:1', () => {
    expect(meetsContrast('#86181d', '#ffeef0', 4.5)).toBe(true);
  });

  test('focus ring (#0b5394) on white meets 3:1 for non-text UI', () => {
    expect(meetsContrast('#0b5394', '#ffffff', 3)).toBe(true);
  });

  test('all status badge backgrounds pass with white text', () => {
    const badges = [
      COLOR_TOKENS.statusEligibleBg,
      COLOR_TOKENS.statusPartialBg,
      COLOR_TOKENS.statusNotEligibleBg,
    ];
    for (const bg of badges) {
      expect(meetsContrast('#ffffff', bg, 4.5)).toBe(true);
    }
  });

  test('government level badge backgrounds pass with white text', () => {
    expect(meetsContrast('#ffffff', COLOR_TOKENS.centralGovBg, 4.5)).toBe(true);
    expect(meetsContrast('#ffffff', COLOR_TOKENS.stateGovBg, 4.5)).toBe(true);
  });
});

describe('Requirement 20.5 — Heading hierarchy and landmark regions', () => {
  test('a typical page with h1 → h2 → h3 structure is valid', () => {
    const result = validateHeadingHierarchy([1, 2, 3, 3, 2, 3]);
    expect(result.valid).toBe(true);
  });

  test('skipping heading levels is detected as invalid', () => {
    // h1 → h3 skips h2
    const result = validateHeadingHierarchy([1, 3]);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain('skipped');
  });

  test('pages starting without h1 are flagged', () => {
    const result = validateHeadingHierarchy([2, 3]);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain('h1');
  });

  test('getChildHeadingLevel correctly computes subsection levels', () => {
    expect(getChildHeadingLevel(1)).toBe(2);
    expect(getChildHeadingLevel(2)).toBe(3);
    expect(getChildHeadingLevel(5)).toBe(6);
    expect(getChildHeadingLevel(6)).toBe(6); // capped
  });

  test('live region container ids are defined and non-empty', () => {
    expect(LIVE_REGION_POLITE_ID).toBeTruthy();
    expect(LIVE_REGION_ASSERTIVE_ID).toBeTruthy();
    expect(LIVE_REGION_POLITE_ID).not.toBe(LIVE_REGION_ASSERTIVE_ID);
  });
});

describe('Requirement 20.6 — ARIA live regions for dynamic content', () => {
  test('liveAnnounce returns false on empty/whitespace messages', () => {
    // In node env (no window), should return false
    expect(liveAnnounce('')).toBe(false);
    expect(liveAnnounce('   ')).toBe(false);
  });

  test('liveAnnounce dispatches an event in a browser environment', () => {
    // In jsdom, window exists so liveAnnounce dispatches the event
    expect(liveAnnounce('Test announcement')).toBe(true);
  });

  test('polite and assertive live region ids are distinct', () => {
    expect(LIVE_REGION_POLITE_ID).toBe('bb-live-polite');
    expect(LIVE_REGION_ASSERTIVE_ID).toBe('bb-live-assertive');
  });
});

describe('Requirement 20.7 — Programmatic error association', () => {
  test('describedBy returns undefined when no helper/error is present', () => {
    const result = describedBy({
      helperId: 'field-helper',
      errorId: 'field-error',
      hasHelper: false,
      hasError: false,
    });
    expect(result).toBeUndefined();
  });

  test('describedBy returns only helper id when helper is present', () => {
    const result = describedBy({
      helperId: 'field-helper',
      errorId: 'field-error',
      hasHelper: true,
      hasError: false,
    });
    expect(result).toBe('field-helper');
  });

  test('describedBy returns only error id when error is present', () => {
    const result = describedBy({
      helperId: 'field-helper',
      errorId: 'field-error',
      hasHelper: false,
      hasError: true,
    });
    expect(result).toBe('field-error');
  });

  test('describedBy joins helper and error in correct order', () => {
    const result = describedBy({
      helperId: 'income-helper',
      errorId: 'income-error',
      hasHelper: true,
      hasError: true,
    });
    // Helper comes first, then error — screen readers read top to bottom
    expect(result).toBe('income-helper income-error');
  });

  test('fieldIds produce consistent helper/error ids for aria-describedby', () => {
    const ids = fieldIds('email');
    expect(ids.helperId).toBe('email-helper');
    expect(ids.errorId).toBe('email-error');

    // The input can reference both via aria-describedby
    const ariaDescribedBy = describedBy({
      ...ids,
      hasHelper: true,
      hasError: true,
    });
    expect(ariaDescribedBy).toContain(ids.helperId);
    expect(ariaDescribedBy).toContain(ids.errorId);
  });

  test('field error ids are valid HTML id attributes', () => {
    const testCases = [
      'Annual Income (₹/year)',
      'Date of Birth',
      'State / Union Territory',
      '   Leading Spaces   ',
    ];

    for (const base of testCases) {
      const ids = fieldIds(base);
      // Valid HTML id: no spaces, no special chars besides hyphen
      expect(ids.errorId).toMatch(/^[a-z0-9-]+$/);
      expect(ids.inputId).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
