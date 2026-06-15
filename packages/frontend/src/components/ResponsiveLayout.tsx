/**
 * Responsive layout wrapper component.
 *
 * Implements Requirement 19 — Mobile-First Responsive Design:
 *   - 19.1: No horizontal scrolling from 320px to 2560px
 *   - 19.2: Mobile-first breakpoint strategy (default 320-767px, 768px+ enhanced)
 *   - 19.5: Performance optimizations (lazy loading, font display)
 *
 * This component provides the structural shell for all pages:
 *   - Sticky header with collapsible navigation
 *   - Responsive main content area
 *   - Overflow-hidden wrapper preventing horizontal scroll
 *
 * Usage:
 *   <ResponsiveLayout currentPath="/schemes">
 *     <YourPageContent />
 *   </ResponsiveLayout>
 */

import React from 'react';
import { SiteHeader } from './SiteHeader';
import { MAIN_CONTENT_ID } from './SkipLink';

export interface ResponsiveLayoutProps {
  /** Page content to render in the main area. */
  children: React.ReactNode;
  /** Current route path, used to highlight active nav link. */
  currentPath?: string;
  /** Optional additional CSS class for the main element. */
  mainClassName?: string;
}

/**
 * Primary layout shell enforcing responsive constraints:
 * - `overflow-x: hidden` on the wrapper prevents horizontal scroll (Req 19.1)
 * - Mobile-first CSS in responsive.css handles breakpoints (Req 19.2)
 * - SiteHeader provides collapsible nav below 768px (Req 19.6)
 */
export function ResponsiveLayout({
  children,
  currentPath,
  mainClassName,
}: ResponsiveLayoutProps) {
  const mainClasses = ['bb-main', mainClassName].filter(Boolean).join(' ');

  return (
    <div className="bb-layout-root">
      <SiteHeader currentPath={currentPath} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className={mainClasses}>
        {children}
      </main>
    </div>
  );
}

/**
 * Responsive container that constrains content width at larger breakpoints.
 * Mobile: full width with 16px padding.
 * Tablet (768px+): max-width 768px, 24px padding.
 * Desktop (1024px+): max-width 1024px, 32px padding.
 * Large (1280px+): max-width 1200px.
 */
export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const classes = ['bb-container', className].filter(Boolean).join(' ');
  return <div className={classes}>{children}</div>;
}

/**
 * Responsive grid that adapts columns based on viewport:
 * Mobile: 1 column
 * Tablet (768px+): 2 columns
 * Desktop (1024px+): configurable up to 4 columns
 */
export function ResponsiveGrid({
  children,
  columns = 2,
  className,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  const colClass = columns === 3 ? 'bb-grid--3-col' : columns === 4 ? 'bb-grid--4-col' : '';
  const classes = ['bb-grid', colClass, className].filter(Boolean).join(' ');
  return <div className={classes}>{children}</div>;
}

/**
 * Responsive card component with proper padding at breakpoints.
 */
export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const classes = ['bb-card', className].filter(Boolean).join(' ');
  return <div className={classes}>{children}</div>;
}

/**
 * Ensures interactive elements meet the 44x44px minimum touch target
 * requirement on mobile (Req 19.4).
 */
export function TouchTarget({
  children,
  as: Component = 'button',
  className,
  ...props
}: {
  children: React.ReactNode;
  as?: 'button' | 'a' | 'div';
  className?: string;
  [key: string]: unknown;
}) {
  const classes = ['bb-touch-target', className].filter(Boolean).join(' ');
  return (
    <Component className={classes} {...props}>
      {children}
    </Component>
  );
}

/**
 * Lazy-loaded section that uses content-visibility for offscreen
 * performance optimization (Req 19.5).
 */
export function LazySection({
  children,
  className,
  estimatedHeight = 300,
}: {
  children: React.ReactNode;
  className?: string;
  estimatedHeight?: number;
}) {
  const classes = ['bb-lazy-section', className].filter(Boolean).join(' ');
  return (
    <section
      className={classes}
      style={{ containIntrinsicSize: `auto ${estimatedHeight}px` }}
    >
      {children}
    </section>
  );
}

/**
 * Responsive image component with lazy loading and proper sizing
 * attributes for performance (Req 19.5).
 */
export function ResponsiveImage({
  src,
  alt,
  width,
  height,
  sizes = '(min-width: 1024px) 33vw, (min-width: 768px) 50vw, 100vw',
  className,
  priority = false,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  sizes?: string;
  className?: string;
  priority?: boolean;
}) {
  const classes = ['bb-responsive-img', className].filter(Boolean).join(' ');
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      sizes={sizes}
      className={classes}
      loading={priority ? 'eager' : 'lazy'}
      decoding={priority ? 'sync' : 'async'}
    />
  );
}
