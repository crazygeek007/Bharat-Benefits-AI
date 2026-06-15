/**
 * Server component that renders a paginated list of scheme cards plus the
 * Central/State labelling and the zero-results empty state.
 *
 * Used by the main scheme listing page, the category-specific listing
 * pages, and the search results page so that pagination, decoration, and
 * empty-state behaviour stay identical.
 */

import type {
  SchemeFilters,
  SchemeListResponse,
  SchemeSearchResponse,
} from '../lib/api';
import { SchemeCard } from './SchemeCard';
import { Pagination } from './Pagination';
import { ZeroResults } from './ZeroResults';

/** Discriminated union of list/search response shapes. */
type ListLikeResponse = SchemeListResponse | SchemeSearchResponse;

export interface SchemeListProps {
  data: ListLikeResponse;
  /** Pathname (without query string) used to build pagination links. */
  pathname: string;
  /** Search params (without `page`) used to build pagination links. */
  searchParamsWithoutPage: URLSearchParams;
  /** Path used by the empty-state "Clear filters" link. */
  clearFiltersHref: string;
  /** Filters that were applied — drives the zero-state chip list. */
  appliedFilters?: SchemeFilters;
  /** Search query (when this list is showing search results). */
  searchQuery?: string;
}

function isSearchResponse(data: ListLikeResponse): data is SchemeSearchResponse {
  return typeof (data as SchemeSearchResponse).query === 'string';
}

export function SchemeList({
  data,
  pathname,
  searchParamsWithoutPage,
  clearFiltersHref,
  appliedFilters,
  searchQuery,
}: SchemeListProps) {
  const filters: SchemeFilters =
    appliedFilters ??
    (isSearchResponse(data) ? {} : ((data as SchemeListResponse).appliedFilters ?? {}));
  const effectiveQuery =
    searchQuery ?? (isSearchResponse(data) ? data.query : undefined);

  if (data.totalCount === 0) {
    return (
      <ZeroResults
        appliedFilters={filters}
        clearFiltersHref={clearFiltersHref}
        searchQuery={effectiveQuery}
      />
    );
  }

  function buildHref(page: number): string {
    const params = new URLSearchParams(searchParamsWithoutPage);
    if (page > 1) params.set('page', String(page));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const isSearch = isSearchResponse(data);

  return (
    <div>
      <div
        aria-live="polite"
        style={{
          marginBottom: 12,
          fontSize: 14,
          color: '#57606a',
        }}
      >
        {isSearch ? (
          <>
            Showing {data.schemes.length} of {data.totalCount} matches for{' '}
            <strong>“{(data as SchemeSearchResponse).query}”</strong>
          </>
        ) : (
          <>
            Showing {data.schemes.length} of {data.totalCount} schemes
          </>
        )}
        {data.totalPages > 1 ? ` (page ${data.page} of ${data.totalPages})` : ''}
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {data.schemes.map((scheme) => (
          <li key={scheme.id}>
            <SchemeCard scheme={scheme} />
          </li>
        ))}
      </ul>
      <Pagination
        page={data.page}
        totalPages={data.totalPages}
        buildHref={buildHref}
      />
    </div>
  );
}
