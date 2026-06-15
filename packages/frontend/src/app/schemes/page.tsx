/**
 * Main scheme listing page (Requirement 2.1) and search results page
 * (Requirements 2.6, 2.7).
 *
 * Server component that:
 *   - Reads filter, pagination, and search values from `searchParams`,
 *   - Calls the backend `GET /api/schemes/search` endpoint when a usable
 *     `q` is present, otherwise calls `GET /api/schemes`,
 *   - Renders the search input, filter form, paginated list, and
 *     zero-results state.
 */

import type { Metadata } from 'next';
import { fetchSchemeSearch,
  fetchSchemes,
  SEARCH_MIN_QUERY_LENGTH,
  type SchemeListResponse,
  type SchemeSearchResponse,
} from '../../lib/api';
import {
  parseFiltersFromSearchParams,
  parsePageFromSearchParams,
} from '../../lib/filters';
import { SchemeFiltersForm } from '../../components/SchemeFilters';
import { SchemeList } from '../../components/SchemeList';
import { SchemeSearchInput } from '../../components/SchemeSearchInput';
import { SchemeComparisonBar } from '../../components/SchemeComparisonBar';
import { MAIN_CONTENT_ID } from '../../components/SkipLink';

export const metadata: Metadata = {
  title: 'Browse Schemes — Bharat Benefits AI',
  description:
    'Browse government welfare schemes by category, state, income level, and more.',
};

interface PageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

function readQueryParam(
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const raw = searchParams.q ?? searchParams.query;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

export default async function SchemesPage({ searchParams = {} }: PageProps) {
  const filters = parseFiltersFromSearchParams(searchParams);
  const page = parsePageFromSearchParams(searchParams);
  const rawQuery = readQueryParam(searchParams);
  const isSearching = rawQuery.length >= SEARCH_MIN_QUERY_LENGTH;

  let listData: SchemeListResponse | null = null;
  let searchData: SchemeSearchResponse | null = null;
  let loadError: string | null = null;

  try {
    if (isSearching) {
      searchData = await fetchSchemeSearch(rawQuery, { page });
    } else {
      listData = await fetchSchemes(filters, { page });
    }
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Unknown error';
    if (isSearching) {
      searchData = {
        query: rawQuery,
        schemes: [],
        page,
        pageSize: 20,
        totalCount: 0,
        totalPages: 0,
        searchMode: 'in-memory',
      };
    } else {
      listData = {
        schemes: [],
        page,
        pageSize: 20,
        totalCount: 0,
        totalPages: 0,
        appliedFilters: filters,
        activeFilterCount: 0,
      };
    }
  }

  // Build the search params used to render pagination links — drop the
  // current `page` so each link can substitute its own.
  const linkParams = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    if (Array.isArray(value)) {
      if (value[0]) linkParams.set(key, value[0]);
    } else if (value) {
      linkParams.set(key, value);
    }
  }

  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      style={{ maxWidth: 960, margin: '0 auto', padding: 24 }}
    >
      <h1 style={{ marginBottom: 8 }}>Browse Schemes</h1>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Discover central and state government welfare schemes by category, state,
        and personal attributes.
      </p>

      <SchemeSearchInput initialQuery={rawQuery} pathname="/schemes" />

      <SchemeFiltersForm initialFilters={filters} />

      {loadError && (
        <div
          role="alert"
          style={{
            padding: 12,
            border: '1px solid #d73a49',
            background: '#ffeef0',
            color: '#86181d',
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          {isSearching
            ? 'Could not run that search right now. Please try again in a moment.'
            : 'Could not load schemes right now. Please try again in a moment.'}
        </div>
      )}

      <SchemeList
        data={(searchData ?? listData) as SchemeListResponse | SchemeSearchResponse}
        pathname="/schemes"
        searchParamsWithoutPage={linkParams}
        clearFiltersHref="/schemes"
        appliedFilters={filters}
        searchQuery={isSearching ? rawQuery : undefined}
      />
      <SchemeComparisonBar />
    </main>
  );
}
