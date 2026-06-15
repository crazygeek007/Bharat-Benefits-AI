/**
 * Empty-state component shown when filters or search return zero schemes.
 *
 * Implements Requirement 2.7 by displaying a clear "no results" message
 * along with concrete suggestions to broaden filters or rephrase the
 * search query. Active filters and the current search term are listed so
 * the citizen can pinpoint which constraint to relax.
 */

import Link from 'next/link';
import type { SchemeFilters } from '../lib/api';

export interface ZeroResultsProps {
  appliedFilters?: SchemeFilters;
  /** Path used to clear all filters (defaults to the page's pathname). */
  clearFiltersHref: string;
  /** The search term that returned zero results, if any. */
  searchQuery?: string;
}

function describeFilter(key: keyof SchemeFilters, value: unknown): string {
  switch (key) {
    case 'state':
      return `State: ${value}`;
    case 'category':
      return `Category: ${value}`;
    case 'benefitType':
      return `Benefit type: ${value}`;
    case 'gender':
      return `Gender: ${value}`;
    case 'occupation':
      return `Occupation: ${value}`;
    case 'age':
      return `Age: ${value}`;
    case 'incomeLevel':
      return `Income: ₹${Number(value).toLocaleString('en-IN')}`;
    default:
      return `${key}: ${value}`;
  }
}

export function ZeroResults({
  appliedFilters = {},
  clearFiltersHref,
  searchQuery,
}: ZeroResultsProps) {
  const activeFilters = (Object.keys(appliedFilters) as (keyof SchemeFilters)[])
    .filter((key) => appliedFilters[key] !== undefined)
    .map((key) => ({ key, label: describeFilter(key, appliedFilters[key]) }));

  const hasSearchQuery = typeof searchQuery === 'string' && searchQuery.length > 0;
  const heading = hasSearchQuery
    ? `No schemes found for "${searchQuery}"`
    : 'No schemes match your filters';

  return (
    <section
      role="status"
      aria-live="polite"
      style={{
        padding: 24,
        border: '1px dashed #d0d7de',
        borderRadius: 8,
        background: '#f6f8fa',
        textAlign: 'center',
      }}
    >
      <h2 style={{ marginTop: 0 }}>{heading}</h2>
      <p style={{ color: '#57606a' }}>
        {hasSearchQuery
          ? 'Try broadening your search terms or removing one of the filters below.'
          : 'Try broadening your search or removing one of the filters below.'}
      </p>

      {(hasSearchQuery || activeFilters.length > 0) && (
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'center',
            listStyle: 'none',
            padding: 0,
            margin: '12px 0',
          }}
        >
          {hasSearchQuery && (
            <li
              key="search-term"
              style={{
                padding: '4px 10px',
                background: '#fff',
                border: '1px solid #d0d7de',
                borderRadius: 999,
                fontSize: 13,
              }}
            >
              Search: “{searchQuery}”
            </li>
          )}
          {activeFilters.map(({ key, label }) => (
            <li
              key={key}
              style={{
                padding: '4px 10px',
                background: '#fff',
                border: '1px solid #d0d7de',
                borderRadius: 999,
                fontSize: 13,
              }}
            >
              {label}
            </li>
          ))}
        </ul>
      )}

      <ul
        style={{
          textAlign: 'left',
          maxWidth: 480,
          margin: '12px auto',
          color: '#24292f',
          paddingLeft: 20,
        }}
      >
        {hasSearchQuery && (
          <>
            <li>Try fewer or more general keywords (e.g. &quot;loan&quot; instead of &quot;PM Vidya Loan&quot;).</li>
            <li>Check spelling — search is forgiving but typos still hurt accuracy.</li>
            <li>Try a related category from the filters above.</li>
          </>
        )}
        <li>Remove the state filter to include Central Government schemes everywhere.</li>
        <li>Try a broader category (e.g. Financial Assistance instead of Pension).</li>
        <li>Adjust the income level — many schemes apply to higher income brackets.</li>
        <li>Clear demographic filters such as age, gender, or occupation.</li>
      </ul>

      <Link
        href={clearFiltersHref}
        style={{
          display: 'inline-block',
          marginTop: 8,
          padding: '8px 16px',
          background: '#0b5394',
          color: '#fff',
          borderRadius: 4,
          textDecoration: 'none',
        }}
      >
        {hasSearchQuery ? 'Clear search and filters' : 'Clear all filters'}
      </Link>
    </section>
  );
}
