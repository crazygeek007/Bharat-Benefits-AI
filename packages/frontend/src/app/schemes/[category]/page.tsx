/**
 * Category-specific scheme listing page (Requirement 2.1).
 *
 * Maps a kebab-case URL slug (e.g. `/schemes/skill-development`) back to the
 * canonical `SchemeCategory` value, then re-uses the same listing pipeline
 * as the main page. The category filter is fixed by the route, so the
 * inline filter form hides its category select to avoid confusion.
 */

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { SchemeCategory } from '@bharat-benefits/shared';
import { fetchSchemes, type SchemeListResponse } from '../../../lib/api';
import {
  parseFiltersFromSearchParams,
  parsePageFromSearchParams,
  SCHEME_CATEGORIES,
} from '../../../lib/filters';
import { SchemeFiltersForm } from '../../../components/SchemeFilters';
import { SchemeList } from '../../../components/SchemeList';
import { SchemeComparisonBar } from '../../../components/SchemeComparisonBar';
import { MAIN_CONTENT_ID } from '../../../components/SkipLink';

interface PageProps {
  params: { category: string };
  searchParams?: Record<string, string | string[] | undefined>;
}

function slugToCategory(slug: string): SchemeCategory | null {
  const normalised = slug.trim().toLowerCase();
  for (const category of SCHEME_CATEGORIES) {
    if (categoryToSlug(category) === normalised) return category;
  }
  return null;
}

function categoryToSlug(category: SchemeCategory): string {
  return category.toLowerCase().replace(/\s+/g, '-');
}

export function generateStaticParams() {
  return SCHEME_CATEGORIES.map((category) => ({ category: categoryToSlug(category) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const category = slugToCategory(params.category);
  if (!category) {
    return { title: 'Schemes — Bharat Benefits AI' };
  }
  return {
    title: `${category} Schemes — Bharat Benefits AI`,
    description: `Browse government welfare schemes in the ${category} category.`,
  };
}

export default async function CategoryPage({ params, searchParams = {} }: PageProps) {
  const category = slugToCategory(params.category);
  if (!category) notFound();

  // Filter selections from the URL are merged on top of the route's category.
  // The category from `searchParams` is intentionally ignored here — the
  // route is the source of truth.
  const baseFilters = parseFiltersFromSearchParams(searchParams);
  const filters = { ...baseFilters, category };
  const page = parsePageFromSearchParams(searchParams);

  let data: SchemeListResponse;
  let loadError: string | null = null;
  try {
    data = await fetchSchemes(filters, { page });
  } catch (err) {
    loadError = err instanceof Error ? err.message : 'Unknown error';
    data = {
      schemes: [],
      page,
      pageSize: 20,
      totalCount: 0,
      totalPages: 0,
      appliedFilters: filters,
      activeFilterCount: 0,
    };
  }

  const slug = categoryToSlug(category);
  const pathname = `/schemes/${slug}`;

  // Build the search params used by pagination links — drop `page` and
  // `category` (the latter is determined by the route segment).
  const linkParams = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === 'page' || key === 'category') continue;
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
      <nav style={{ fontSize: 13, color: '#57606a', marginBottom: 8 }}>
        <a href="/schemes" style={{ color: '#0b5394' }}>
          All Schemes
        </a>{' '}
        / {category}
      </nav>
      <h1 style={{ marginBottom: 8 }}>{category} Schemes</h1>
      <p style={{ color: '#57606a', marginTop: 0 }}>
        Government welfare schemes in the {category} category. Apply filters to
        narrow down by state, age, income, and more.
      </p>

      <SchemeFiltersForm initialFilters={filters} hideCategory />

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
          Could not load schemes right now. Please try again in a moment.
        </div>
      )}

      <SchemeList
        data={data}
        pathname={pathname}
        searchParamsWithoutPage={linkParams}
        clearFiltersHref={pathname}
      />
      <SchemeComparisonBar />
    </main>
  );
}
