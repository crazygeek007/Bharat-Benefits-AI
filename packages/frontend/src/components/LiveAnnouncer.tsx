'use client';

/**
 * Global ARIA live regions (Requirement 20.6).
 *
 * Renders two `aria-live` containers — one polite, one assertive — at
 * the top of the body so dynamic content changes anywhere in the app
 * can be announced to assistive technology without each component
 * having to manage its own region.
 *
 * Components push messages by calling {@link liveAnnounce} from
 * `lib/a11y.ts`. The announcer subscribes to a window event so it does
 * not need a context provider — keeps the wiring server-component
 * friendly (only this leaf is `'use client'`).
 *
 * UX details:
 *   - The text is cleared after 1 second so the same string can be
 *     re-announced (some readers ignore identical sequential updates).
 *   - The `key` prop on the inner span is rotated each update so React
 *     replaces the node, which forces every screen reader to
 *     re-announce even when the text is unchanged.
 */

import { useEffect, useRef, useState } from 'react';
import {
  LIVE_ANNOUNCE_EVENT,
  LIVE_REGION_ASSERTIVE_ID,
  LIVE_REGION_POLITE_ID,
  type LiveAnnouncePayload,
} from '../lib/a11y';

interface AnnouncementState {
  /** Message currently in the polite region (empty string clears it). */
  polite: string;
  /** Message currently in the assertive region. */
  assertive: string;
  /** Monotonic counter that forces React to re-render the inner span. */
  bump: number;
}

const INITIAL_STATE: AnnouncementState = {
  polite: '',
  assertive: '',
  bump: 0,
};

/** Time after which an announcement is cleared so it can be repeated. */
const CLEAR_AFTER_MS = 1000;

const REGION_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function LiveAnnouncer() {
  const [state, setState] = useState<AnnouncementState>(INITIAL_STATE);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handle(event: Event) {
      const detail = (event as CustomEvent<LiveAnnouncePayload>).detail;
      if (!detail || typeof detail.message !== 'string') return;

      setState((prev) => {
        const next: AnnouncementState = {
          polite: detail.priority === 'polite' ? detail.message : '',
          assertive: detail.priority === 'assertive' ? detail.message : '',
          bump: prev.bump + 1,
        };
        return next;
      });

      // Schedule a clear so the same message can be re-announced later.
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        setState((prev) => ({
          polite: '',
          assertive: '',
          bump: prev.bump + 1,
        }));
        clearTimerRef.current = null;
      }, CLEAR_AFTER_MS);
    }

    window.addEventListener(LIVE_ANNOUNCE_EVENT, handle);
    return () => {
      window.removeEventListener(LIVE_ANNOUNCE_EVENT, handle);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  return (
    <>
      <div
        id={LIVE_REGION_POLITE_ID}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={REGION_STYLE}
      >
        <span key={`polite-${state.bump}`}>{state.polite}</span>
      </div>
      <div
        id={LIVE_REGION_ASSERTIVE_ID}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={REGION_STYLE}
      >
        <span key={`assertive-${state.bump}`}>{state.assertive}</span>
      </div>
    </>
  );
}
