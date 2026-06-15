'use client';

/**
 * Loading state announcer for screen readers (Requirement 20.6).
 *
 * When data is being fetched or a computation is in progress, sighted
 * users see a spinner or skeleton UI. Screen reader users need an
 * equivalent announcement. This component:
 *
 *   - Announces the loading state via `aria-live="polite"` when
 *     `isLoading` becomes true.
 *   - Announces completion (or the result message) when loading ends.
 *   - Shows a visible loading indicator for sighted users.
 *   - Supports customizable loading and completed messages.
 */

import { useEffect, useRef } from 'react';
import { liveAnnounce } from '../lib/a11y';

export interface LoadingAnnouncerProps {
  /** Whether content is currently loading. */
  isLoading: boolean;
  /** Message announced when loading starts. */
  loadingMessage?: string;
  /** Message announced when loading completes. */
  completedMessage?: string;
  /** Whether to show the visual loading indicator. */
  showVisual?: boolean;
  /** Optional class name for the visual indicator container. */
  className?: string;
}

const spinnerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 0',
  color: '#57606a',
  fontSize: 14,
};

export function LoadingAnnouncer({
  isLoading,
  loadingMessage = 'Loading content, please wait.',
  completedMessage = 'Content loaded.',
  showVisual = true,
  className,
}: LoadingAnnouncerProps) {
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    if (isLoading && !wasLoadingRef.current) {
      liveAnnounce(loadingMessage, 'polite');
    }
    if (!isLoading && wasLoadingRef.current) {
      liveAnnounce(completedMessage, 'polite');
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, loadingMessage, completedMessage]);

  if (!isLoading || !showVisual) {
    return (
      <div role="status" aria-live="polite" className="sr-only">
        {!isLoading && wasLoadingRef.current ? completedMessage : ''}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={className}
      style={spinnerStyle}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 16,
          height: 16,
          border: '2px solid #d0d7de',
          borderTopColor: '#0b5394',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span>{loadingMessage}</span>
    </div>
  );
}
