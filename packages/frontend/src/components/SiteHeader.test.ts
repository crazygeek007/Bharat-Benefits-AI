/**
 * Unit tests for the pure helpers exported alongside {@link SiteHeader}.
 *
 * Validates: Requirements 19.6 (the navigation surface used to satisfy
 * the collapsible-menu contract uses these helpers to mark the active
 * link).
 *
 * The component itself relies on the DOM and the i18n provider, which
 * are exercised end-to-end via Playwright in the responsive testing
 * lane. These tests cover the pure path-matching rules so the
 * highlighting behaviour stays deterministic across refactors.
 */

import { describe, it, expect } from 'vitest';
import { isActivePath } from './SiteHeader';

describe('isActivePath', () => {
  describe('home link ("/")', () => {
    it('matches exactly the root path', () => {
      expect(isActivePath('/', '/')).toBe(true);
    });

    it('treats an empty current path as the root', () => {
      expect(isActivePath('', '/')).toBe(true);
    });

    it('does not match nested routes', () => {
      // Otherwise every page would light up the Home tab.
      expect(isActivePath('/schemes', '/')).toBe(false);
      expect(isActivePath('/dashboard', '/')).toBe(false);
    });
  });

  describe('non-home links', () => {
    it('matches when the path equals the link href', () => {
      expect(isActivePath('/schemes', '/schemes')).toBe(true);
      expect(isActivePath('/dashboard', '/dashboard')).toBe(true);
    });

    it('matches nested routes via prefix + slash boundary', () => {
      expect(isActivePath('/schemes/detail/abc', '/schemes')).toBe(true);
      expect(isActivePath('/profile/edit', '/profile')).toBe(true);
    });

    it('does NOT match a partial-prefix sibling route', () => {
      // `/schemes-archive` should never light up the `/schemes` link.
      expect(isActivePath('/schemes-archive', '/schemes')).toBe(false);
    });

    it('does not match unrelated paths', () => {
      expect(isActivePath('/dashboard', '/schemes')).toBe(false);
      expect(isActivePath('/', '/schemes')).toBe(false);
    });
  });
});
