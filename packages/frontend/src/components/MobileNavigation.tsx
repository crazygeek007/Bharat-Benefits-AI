'use client';

/**
 * Mobile navigation component with collapsible menu.
 *
 * Implements Requirement 19.6:
 *   - Displays navigation links within a collapsible menu below 768px
 *   - Accessible via a single tap (hamburger toggle)
 *   - Closes on navigation, Escape key, or outside click
 *
 * Also satisfies:
 *   - Req 19.4: All interactive elements have minimum 44x44px touch targets
 *   - Req 20.3: ARIA labels for the toggle and navigation region
 *   - Req 20.2: Keyboard navigation support (Escape to close)
 *
 * This component is designed to work alongside the SiteHeader. It
 * provides the mobile-specific toggle logic and overlay behavior.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface MobileNavigationProps {
  /** Navigation content (link list) to render inside the collapsible panel. */
  children: React.ReactNode;
  /** Accessible label for the navigation landmark. */
  ariaLabel?: string;
  /** Controlled open state — useful for parent components managing state. */
  isOpen?: boolean;
  /** Callback when the open state changes. */
  onToggle?: (isOpen: boolean) => void;
}

/**
 * Returns the current viewport width category.
 * - 'mobile': < 768px (navigation collapses)
 * - 'desktop': >= 768px (navigation always visible)
 */
export function getViewportCategory(width: number): 'mobile' | 'desktop' {
  return width < 768 ? 'mobile' : 'desktop';
}

/**
 * Validates that a touch target meets the minimum size requirement.
 * Requirement 19.4: minimum 44x44 CSS pixels on screens below 768px.
 */
export function validateTouchTarget(
  width: number,
  height: number,
  viewportWidth: number
): { valid: boolean; reason?: string } {
  // Only enforced below 768px
  if (viewportWidth >= 768) {
    return { valid: true };
  }
  if (width < 44 || height < 44) {
    return {
      valid: false,
      reason: `Touch target ${width}x${height}px is below the required 44x44px minimum`,
    };
  }
  return { valid: true };
}

/**
 * Determines if horizontal scrolling would occur given content and viewport widths.
 * Requirement 19.1: No horizontal scrolling from 320px to 2560px.
 */
export function wouldCauseHorizontalScroll(
  contentWidth: number,
  viewportWidth: number
): boolean {
  return contentWidth > viewportWidth;
}

/**
 * Calculates the responsive breakpoint class for a given viewport width.
 * Returns the applicable breakpoint token following mobile-first strategy.
 *
 * Requirement 19.2: Mobile-first breakpoint strategy.
 */
export function getBreakpoint(
  viewportWidth: number
): 'mobile' | 'tablet' | 'desktop' | 'large' {
  if (viewportWidth >= 1280) return 'large';
  if (viewportWidth >= 1024) return 'desktop';
  if (viewportWidth >= 768) return 'tablet';
  return 'mobile';
}

export function MobileNavigation({
  children,
  ariaLabel = 'Primary navigation',
  isOpen: controlledOpen,
  onToggle,
}: MobileNavigationProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (open: boolean) => {
      setInternalOpen(open);
      onToggle?.(open);
    },
    [onToggle]
  );

  const toggle = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, close]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClick = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        close();
      }
    };

    // Delay to avoid closing immediately on the toggle click
    const timer = setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handleClick);
    };
  }, [isOpen, close]);

  return (
    <nav
      ref={navRef}
      className="bb-mobile-nav"
      role="navigation"
      aria-label={ariaLabel}
      data-open={isOpen ? 'true' : 'false'}
    >
      <button
        type="button"
        className="bb-nav-toggle"
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
        onClick={toggle}
      >
        <span aria-hidden="true">{isOpen ? '✕' : '☰'}</span>
      </button>

      <div className="bb-mobile-nav__panel" aria-hidden={!isOpen}>
        {children}
      </div>
    </nav>
  );
}
