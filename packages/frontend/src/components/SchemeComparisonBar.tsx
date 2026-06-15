'use client';

/**
 * Client-side comparison selection bar (Requirement 24).
 *
 * Provides the selection UX referenced by every scheme listing page:
 *   - Renders a checkbox next to each scheme card via the
 *     `<CompareCheckbox />` companion component (the cards remain server
 *     components — only the checkbox is client-side).
 *   - Tracks the selection in `localStorage` so it survives navigation
 *     between the main listing, category pages, and the search results.
 *   - Shows a floating bar at the bottom of the viewport listing the
 *     currently-selected schemes, with a "Compare" button that links to
 *     `/schemes/compare?ids=...`.
 *   - Enforces the 3-scheme maximum (Req 24.3) by disabling additional
 *     checkboxes once the limit is reached and surfacing a "max reached"
 *     message; the citizen must remove a scheme before adding another.
 *
 * The bar uses a tiny pub/sub bridge (a `BroadcastChannel`-style
 * `EventTarget` on the window) so multiple `CompareCheckbox` instances
 * stay in sync without a global state library.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MAX_COMPARISON_SCHEMES,
  MIN_COMPARISON_SCHEMES,
} from '../lib/api';

const STORAGE_KEY = 'bb-ai:comparison-selection';
const EVENT_NAME = 'bb-ai:comparison-selection-changed';

/**
 * Reads the current selection from `localStorage`. Returns an empty array
 * on the server, when the value is missing, or when it is malformed —
 * defensive parsing keeps a corrupted entry from breaking the page.
 */
function readSelection(): SelectionEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: SelectionEntry[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { id?: unknown }).id === 'string' &&
        typeof (entry as { name?: unknown }).name === 'string'
      ) {
        result.push({
          id: String((entry as { id: string }).id),
          name: String((entry as { name: string }).name),
        });
      }
    }
    // Cap at the maximum just in case stale data accumulated.
    return result.slice(0, MAX_COMPARISON_SCHEMES);
  } catch {
    return [];
  }
}

function writeSelection(entries: ReadonlyArray<SelectionEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be disabled in private modes — silently ignore.
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export interface SelectionEntry {
  id: string;
  name: string;
}

/**
 * Hook used by the bar and each checkbox to subscribe to the shared
 * selection state. The hook re-reads from `localStorage` whenever the
 * custom selection-change event fires (in this tab) or a `storage` event
 * fires (cross-tab).
 */
function useSelection(): {
  selection: SelectionEntry[];
  isSelected: (id: string) => boolean;
  add: (entry: SelectionEntry) => void;
  remove: (id: string) => void;
  clear: () => void;
  isFull: boolean;
} {
  const [selection, setSelection] = useState<SelectionEntry[]>([]);

  // Hydrate after mount so SSR markup matches the empty initial state.
  useEffect(() => {
    setSelection(readSelection());
    function handleChange() {
      setSelection(readSelection());
    }
    window.addEventListener(EVENT_NAME, handleChange);
    window.addEventListener('storage', handleChange);
    return () => {
      window.removeEventListener(EVENT_NAME, handleChange);
      window.removeEventListener('storage', handleChange);
    };
  }, []);

  const add = useCallback((entry: SelectionEntry) => {
    setSelection((prev) => {
      if (prev.some((e) => e.id === entry.id)) return prev;
      if (prev.length >= MAX_COMPARISON_SCHEMES) return prev;
      const next = [...prev, entry];
      writeSelection(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setSelection((prev) => {
      const next = prev.filter((e) => e.id !== id);
      writeSelection(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelection([]);
    writeSelection([]);
  }, []);

  return {
    selection,
    isSelected: (id) => selection.some((e) => e.id === id),
    add,
    remove,
    clear,
    isFull: selection.length >= MAX_COMPARISON_SCHEMES,
  };
}

// ─── <CompareCheckbox /> ────────────────────────────────────────────────────

export interface CompareCheckboxProps {
  schemeId: string;
  schemeName: string;
}

/**
 * Per-scheme checkbox. Renders inline next to the scheme name on the
 * listing card. Disables itself when the citizen has already selected
 * `MAX_COMPARISON_SCHEMES` schemes and the current scheme is not part of
 * that selection (Req 24.3).
 */
export function CompareCheckbox({
  schemeId,
  schemeName,
}: CompareCheckboxProps) {
  const { isSelected, isFull, add, remove } = useSelection();
  const checked = isSelected(schemeId);
  const disabled = !checked && isFull;

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        color: disabled ? '#8c959f' : '#24292f',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      title={
        disabled
          ? `Maximum of ${MAX_COMPARISON_SCHEMES} schemes reached. Remove one to add another.`
          : 'Add to compare'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.checked) add({ id: schemeId, name: schemeName });
          else remove(schemeId);
        }}
        aria-label={
          checked
            ? `Remove ${schemeName} from comparison`
            : `Add ${schemeName} to comparison`
        }
      />
      Compare
    </label>
  );
}

// ─── <SchemeComparisonBar /> ────────────────────────────────────────────────

/**
 * Floating bar pinned to the bottom of the viewport. Only renders when at
 * least one scheme is selected — keeps the listing clean for citizens who
 * are not using the comparison tool.
 */
export function SchemeComparisonBar() {
  const { selection, remove, clear, isFull } = useSelection();

  if (selection.length === 0) return null;

  const canCompare = selection.length >= MIN_COMPARISON_SCHEMES;
  const compareHref = `/schemes/compare?ids=${selection
    .map((e) => encodeURIComponent(e.id))
    .join(',')}`;

  return (
    <div
      role="region"
      aria-label="Selected schemes for comparison"
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 50,
        background: '#fff',
        border: '1px solid #d0d7de',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
        padding: 12,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>
          Compare ({selection.length}/{MAX_COMPARISON_SCHEMES}):
        </strong>
        {selection.map((entry) => (
          <span
            key={`pill-${entry.id}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              padding: '4px 8px',
              border: '1px solid #d0d7de',
              borderRadius: 16,
              background: '#f6f8fa',
            }}
          >
            <span
              style={{
                maxWidth: 220,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.name}
            </span>
            <button
              type="button"
              onClick={() => remove(entry.id)}
              aria-label={`Remove ${entry.name} from comparison`}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#57606a',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </span>
        ))}
        {isFull && (
          <span
            role="status"
            style={{ fontSize: 12, color: '#7d4e00' }}
          >
            Maximum reached — remove a scheme to add another.
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={clear}
          style={{
            border: '1px solid #d0d7de',
            background: '#fff',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Clear
        </button>
        {canCompare ? (
          <a
            href={compareHref}
            style={{
              background: '#0b5394',
              color: '#fff',
              borderRadius: 6,
              padding: '6px 16px',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Compare {selection.length} schemes →
          </a>
        ) : (
          <span style={{ fontSize: 12, color: '#57606a' }}>
            Select at least {MIN_COMPARISON_SCHEMES} to compare
          </span>
        )}
      </div>
    </div>
  );
}
