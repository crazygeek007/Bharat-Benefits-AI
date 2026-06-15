'use client';

/**
 * Client-side search input for the scheme listing page.
 *
 * Implements Requirement 2.6 — accepts queries of at least 2 characters
 * and feeds them into the backend's hybrid (semantic + full-text) search
 * pipeline by updating the URL's `q` query parameter.
 *
 * UX rules:
 *   - Debounces typed input (300ms) before pushing to the URL so server
 *     fetches are coalesced while the user is still typing.
 *   - Shows an inline hint when the query is shorter than 2 characters
 *     so the citizen understands why nothing has updated yet. The hint
 *     is programmatically associated with the input via
 *     `aria-describedby` (Req 20.7) and announced to screen readers
 *     through its `aria-live="polite"` region (Req 20.6).
 *   - Submitting the form (Enter) bypasses the debounce and navigates
 *     immediately. A clear button removes `q` from the URL entirely.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SEARCH_MIN_QUERY_LENGTH } from '../lib/api';

export interface SchemeSearchInputProps {
  /** Initial value applied on first render, typically read from URL. */
  initialQuery?: string;
  /** Path used when navigating with updated `q` values. */
  pathname?: string;
  /** Debounce window in milliseconds. */
  debounceMs?: number;
  /** Placeholder text rendered inside the input. */
  placeholder?: string;
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 8,
  marginBottom: 12,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 12px',
  border: '1px solid #d0d7de',
  borderRadius: 4,
  fontSize: 15,
  minWidth: 0,
};

const buttonStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: '#0b5394',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
};

const clearButtonStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: '#fff',
  color: '#24292f',
  border: '1px solid #d0d7de',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#57606a',
  marginTop: 0,
  marginBottom: 12,
};

export function SchemeSearchInput({
  initialQuery = '',
  pathname,
  debounceMs = 300,
  placeholder = 'Search schemes by name, category, or keywords…',
}: SchemeSearchInputProps) {
  const router = useRouter();
  const currentPathname = usePathname();
  const searchParams = useSearchParams();
  const targetPath = pathname ?? currentPathname;

  const [value, setValue] = useState(initialQuery);
  const lastNavigatedRef = useRef<string>(initialQuery);

  // Build the navigation URL while preserving any non-`q`/`page` params.
  function navigateTo(query: string) {
    const params = new URLSearchParams();
    for (const [key, val] of searchParams.entries()) {
      if (key === 'q' || key === 'page') continue;
      params.set(key, val);
    }
    const trimmed = query.trim();
    if (trimmed.length >= SEARCH_MIN_QUERY_LENGTH) {
      params.set('q', trimmed);
    }
    const qs = params.toString();
    const next = qs ? `${targetPath}?${qs}` : targetPath;
    router.push(next);
  }

  // Debounced auto-submit: navigate after the user pauses typing.
  useEffect(() => {
    const trimmed = value.trim();

    // Treat sub-minimum queries as "clear the search".
    const effective = trimmed.length >= SEARCH_MIN_QUERY_LENGTH ? trimmed : '';

    if (effective === lastNavigatedRef.current) return;

    const handle = window.setTimeout(() => {
      lastNavigatedRef.current = effective;
      navigateTo(effective);
    }, debounceMs);

    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, debounceMs]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    const effective = trimmed.length >= SEARCH_MIN_QUERY_LENGTH ? trimmed : '';
    lastNavigatedRef.current = effective;
    navigateTo(effective);
  }

  function handleClear() {
    setValue('');
    lastNavigatedRef.current = '';
    navigateTo('');
  }

  const trimmed = value.trim();
  const tooShort =
    trimmed.length > 0 && trimmed.length < SEARCH_MIN_QUERY_LENGTH;

  // Stable ids so `aria-describedby` keeps pointing at the right hint
  // node across renders (Req 20.7 — programmatic association).
  const reactId = useId();
  const inputId = `bb-search-input-${reactId.replace(/:/g, '')}`;
  const hintId = `bb-search-hint-${reactId.replace(/:/g, '')}`;

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      aria-label="Search schemes"
      style={{ marginBottom: 8 }}
    >
      <div style={containerStyle}>
        <label htmlFor={inputId} className="sr-only">
          Search schemes
        </label>
        <input
          id={inputId}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label="Search schemes"
          aria-describedby={tooShort ? hintId : undefined}
          aria-invalid={tooShort ? 'true' : undefined}
          style={inputStyle}
          autoComplete="off"
          inputMode="search"
          minLength={0}
        />
        <button type="submit" style={buttonStyle} aria-label="Run search">
          Search
        </button>
        {value.length > 0 && (
          <button
            type="button"
            style={clearButtonStyle}
            onClick={handleClear}
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </div>
      {tooShort && (
        <p id={hintId} style={hintStyle} role="status" aria-live="polite">
          Enter at least {SEARCH_MIN_QUERY_LENGTH} characters to start searching.
        </p>
      )}
    </form>
  );
}
