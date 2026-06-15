/**
 * Unit tests for responsive layout components and utilities.
 *
 * Validates: Requirements 19.1, 19.2, 19.4, 19.6
 *
 * Tests cover:
 * - Viewport category detection (mobile vs desktop breakpoint at 768px)
 * - Touch target validation (minimum 44x44px on mobile)
 * - Horizontal scroll prevention logic
 * - Breakpoint classification (mobile-first strategy)
 */

import { describe, it, expect } from 'vitest';
import {
  getViewportCategory,
  validateTouchTarget,
  wouldCauseHorizontalScroll,
  getBreakpoint,
} from './MobileNavigation';

describe('getViewportCategory', () => {
  describe('mobile viewport (< 768px)', () => {
    it('classifies 320px as mobile (minimum supported width)', () => {
      expect(getViewportCategory(320)).toBe('mobile');
    });

    it('classifies 375px as mobile (common phone width)', () => {
      expect(getViewportCategory(375)).toBe('mobile');
    });

    it('classifies 767px as mobile (just below tablet breakpoint)', () => {
      expect(getViewportCategory(767)).toBe('mobile');
    });
  });

  describe('desktop viewport (>= 768px)', () => {
    it('classifies 768px as desktop (tablet breakpoint)', () => {
      expect(getViewportCategory(768)).toBe('desktop');
    });

    it('classifies 1024px as desktop', () => {
      expect(getViewportCategory(1024)).toBe('desktop');
    });

    it('classifies 2560px as desktop (maximum supported width)', () => {
      expect(getViewportCategory(2560)).toBe('desktop');
    });
  });
});

describe('validateTouchTarget', () => {
  describe('on mobile viewports (< 768px)', () => {
    it('passes when touch target is exactly 44x44px', () => {
      const result = validateTouchTarget(44, 44, 375);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('passes when touch target exceeds 44x44px', () => {
      const result = validateTouchTarget(48, 48, 320);
      expect(result.valid).toBe(true);
    });

    it('fails when width is below 44px', () => {
      const result = validateTouchTarget(40, 44, 375);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('below the required 44x44px');
    });

    it('fails when height is below 44px', () => {
      const result = validateTouchTarget(44, 36, 320);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('below the required 44x44px');
    });

    it('fails when both dimensions are below 44px', () => {
      const result = validateTouchTarget(32, 32, 375);
      expect(result.valid).toBe(false);
    });

    it('includes actual dimensions in reason message', () => {
      const result = validateTouchTarget(30, 28, 375);
      expect(result.reason).toContain('30x28');
    });
  });

  describe('on desktop viewports (>= 768px)', () => {
    it('always passes regardless of size at 768px and above', () => {
      const result = validateTouchTarget(20, 20, 768);
      expect(result.valid).toBe(true);
    });

    it('passes with small targets on large screens', () => {
      const result = validateTouchTarget(16, 16, 1920);
      expect(result.valid).toBe(true);
    });
  });
});

describe('wouldCauseHorizontalScroll', () => {
  it('returns false when content fits within viewport', () => {
    expect(wouldCauseHorizontalScroll(300, 320)).toBe(false);
  });

  it('returns false when content equals viewport width', () => {
    expect(wouldCauseHorizontalScroll(320, 320)).toBe(false);
  });

  it('returns true when content exceeds viewport width', () => {
    expect(wouldCauseHorizontalScroll(321, 320)).toBe(true);
  });

  it('returns false for content at maximum supported viewport', () => {
    expect(wouldCauseHorizontalScroll(2560, 2560)).toBe(false);
  });

  it('returns true when content is wider than minimum mobile viewport', () => {
    expect(wouldCauseHorizontalScroll(500, 320)).toBe(true);
  });
});

describe('getBreakpoint', () => {
  describe('mobile-first breakpoint strategy (Req 19.2)', () => {
    it('returns "mobile" for 320px (minimum supported)', () => {
      expect(getBreakpoint(320)).toBe('mobile');
    });

    it('returns "mobile" for 767px (just below first breakpoint)', () => {
      expect(getBreakpoint(767)).toBe('mobile');
    });

    it('returns "tablet" for 768px (first enhanced breakpoint)', () => {
      expect(getBreakpoint(768)).toBe('tablet');
    });

    it('returns "tablet" for 1023px', () => {
      expect(getBreakpoint(1023)).toBe('tablet');
    });

    it('returns "desktop" for 1024px', () => {
      expect(getBreakpoint(1024)).toBe('desktop');
    });

    it('returns "desktop" for 1279px', () => {
      expect(getBreakpoint(1279)).toBe('desktop');
    });

    it('returns "large" for 1280px', () => {
      expect(getBreakpoint(1280)).toBe('large');
    });

    it('returns "large" for 2560px (maximum supported)', () => {
      expect(getBreakpoint(2560)).toBe('large');
    });
  });

  describe('breakpoint boundaries', () => {
    it('mobile range covers 320-767px', () => {
      const mobileWidths = [320, 360, 375, 414, 640, 767];
      for (const w of mobileWidths) {
        expect(getBreakpoint(w)).toBe('mobile');
      }
    });

    it('tablet range covers 768-1023px', () => {
      const tabletWidths = [768, 800, 900, 1023];
      for (const w of tabletWidths) {
        expect(getBreakpoint(w)).toBe('tablet');
      }
    });

    it('desktop range covers 1024-1279px', () => {
      const desktopWidths = [1024, 1100, 1200, 1279];
      for (const w of desktopWidths) {
        expect(getBreakpoint(w)).toBe('desktop');
      }
    });

    it('large range covers 1280px and above', () => {
      const largeWidths = [1280, 1440, 1920, 2560];
      for (const w of largeWidths) {
        expect(getBreakpoint(w)).toBe('large');
      }
    });
  });
});
