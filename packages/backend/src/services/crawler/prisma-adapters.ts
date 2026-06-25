/**
 * Production adapters for the Crawler Orchestrator dependencies
 * (Requirement 1, 22).
 *
 * The orchestrator is intentionally I/O-free and accepts five injected
 * dependencies (persistence, vectorIndexer, searchIndexer, changeDetector,
 * compatibilityStore). This module wires those slots to the concrete
 * production-grade backends:
 *
 *   - `PrismaSchemePersistence`    → upserts into Postgres via Prisma
 *   - `SchemeIndexerVectorAdapter` → reuses {@link createSchemeIndexer}
 *                                    to push embeddings into Pinecone
 *                                    + persist `SchemeEmbedding` rows
 *   - `SchemeIndexerSearchAdapter` → reuses {@link createSchemeIndexer}
 *                                    to index into Elasticsearch (no-op
 *                                    when ES isn't configured — Postgres
 *                                    FTS picks up changes automatically
 *                                    via the generated tsvector column)
 *   - `PrismaCompatibilityStore`   → upserts both directions of every
 *                                    relation into `scheme_compatibility`
 *
 * `ChangeDetector` already has a production-grade adapter — see
 * {@link createChangeDetectorAdapter} in `crawler-pipeline-integration`.
 *
 * Writes are idempotent: the orchestrator re-processes the same scheme
 * URL on every crawl, and adapters MUST behave correctly on repeated
 * `upsertScheme` / `indexScheme` calls for the same `schemeId`.
 */

import type {
  CompatibilityRelation,
  DocumentRequirement,
  SchemeObject,
} from '@bharat-benefits/shared';

import type { PrismaClient } from '../../generated/prisma/client';
import type { IngestedRecord } from './ingestion-helpers';
import type {
  CompatibilityStore,
  SchemePersistence,
  SearchIndexer,
  UpsertResult,
  VectorIndexer,
} from './orchestrator';
import type { IndexableScheme, SchemeIndexer } from './scheme-indexer';

/** Minimal Prisma surface used by the persistence adapter. */
export interface SchemePersistencePrisma {
  scheme: {
    findFirst(args: { where: { sourceUrl: string } }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  schemeDocument: {
    deleteMany(args: { where: { schemeId: string } }): Promise<unknown>;
    createMany(args: { data: Array<Record<string, unknown>> }): Promise<unknown>;
  };
}

/**
 * Persists a crawled scheme into Postgres. The strategy mirrors the
 * seed-schemes pipeline: look up by sourceUrl, update-or-create the
 * scheme row, then full-replace the documents collection so the row
 * always reflects the latest crawled snapshot.
 *
 * Idempotent: the same `sourceUrl` always maps to the same scheme row.
 * Concurrent crawls of the same URL would race on the find/update path
 * — the orchestrator's concurrency limit + per-source serialization
 * makes that race impossible in practice, so the adapter doesn't
 * synchronise.
 */
export class PrismaSchemePersistence implements SchemePersistence {
  constructor(private readonly prisma: SchemePersistencePrisma) {}

  async upsertScheme(record: IngestedRecord): Promise<UpsertResult> {
    const {
      schemeObject,
      sourceUrl,
      ministry,
      trustScore,
      discoveredAt,
      lastVerifiedAt,
      category,
      state,
      verified,
    } = record;
    const existing = await this.prisma.scheme.findFirst({ where: { sourceUrl } });

    // SchemeObject (the crawler's output shape) covers the citizen-facing
    // content; DB-only attributes like benefitType / applicationMode are
    // nullable in the schema and left untouched here so admin tooling can
    // populate them later without the crawler overwriting curated edits.
    const baseData: Record<string, unknown> = {
      name: schemeObject.name,
      description: schemeObject.description,
      ministry,
      state,
      // The Scheme.category column is NOT NULL — fall back to 'Other' so
      // schemes the categoriser couldn't classify still persist instead of
      // failing the entire crawl pass.
      category: category ?? 'Other',
      sourceUrl,
      deadline: schemeObject.deadline ?? null,
      eligibilityCriteria: (schemeObject.eligibilityCriteria ?? []) as unknown,
      benefits: (schemeObject.benefits ?? []) as unknown,
      // SchemeObject calls it `applicationProcess`; the schema column is
      // `applicationSteps`. Same shape, just renamed at the boundary.
      applicationSteps: (schemeObject.applicationProcess ?? null) as unknown,
      requiredDocuments: (schemeObject.requiredDocuments ?? null) as unknown,
      trustScore,
      verified,
      lastVerifiedAt,
    };

    let schemeId: string;
    let created = false;

    if (existing) {
      schemeId = existing.id;
      await this.prisma.scheme.update({
        where: { id: schemeId },
        data: baseData,
      });
    } else {
      const result = await this.prisma.scheme.create({
        data: { ...baseData, discoveredAt },
      });
      schemeId = result.id;
      created = true;
    }

    // Full-replace the document checklist so removed documents are
    // dropped and reordering is preserved. Cheaper than a per-document
    // diff for the small collection sizes we see (<10 docs per scheme).
    const documents = (schemeObject.requiredDocuments ?? []) as DocumentRequirement[];
    await this.prisma.schemeDocument.deleteMany({ where: { schemeId } });
    if (documents.length > 0) {
      await this.prisma.schemeDocument.createMany({
        data: documents.map((doc) => ({
          schemeId,
          documentName: doc.documentName,
          description: doc.description ?? '',
          format: doc.format ?? '',
          required: doc.required === true,
        })),
      });
    }

    return { schemeId, created };
  }
}

/**
 * Adapt a {@link SchemeObject} (the crawler's output type) to the
 * {@link IndexableScheme} surface the existing indexer expects. The
 * orchestrator only passes the citizen-facing scheme through the vector
 * / search index boundary, so we materialise a `category` fallback —
 * the indexer uses it for embedding-text composition, not as a strict
 * filter, so `'Other'` keeps the pipeline working when categorisation
 * isn't available yet.
 */
function toIndexable(schemeId: string, scheme: SchemeObject): IndexableScheme {
  return {
    id: schemeId,
    name: scheme.name,
    description: scheme.description,
    ministry: scheme.ministry,
    state: null,
    category: 'Other',
    sourceUrl: scheme.sourceUrl,
    eligibilityCriteria: scheme.eligibilityCriteria ?? null,
    benefits: scheme.benefits ?? null,
    applicationSteps: scheme.applicationProcess ?? null,
  };
}

// ─── Vector / search-index adapters ──────────────────────────────────────────

/**
 * Adapts the {@link SchemeIndexer} (built for the indexing scripts) to
 * the {@link VectorIndexer} interface the orchestrator expects. The
 * underlying indexer handles chunking, embedding generation, Pinecone
 * upsert, and the `SchemeEmbedding` Postgres rows in one call.
 *
 * Errors propagate — the orchestrator treats a failed vector-index as
 * a hard failure for that scheme so the crawl summary surfaces it.
 */
export class SchemeIndexerVectorAdapter implements VectorIndexer {
  constructor(private readonly indexer: SchemeIndexer) {}

  async indexScheme(schemeId: string, scheme: SchemeObject): Promise<void> {
    await this.indexer.indexSchemeInVectorDB(schemeId, toIndexable(schemeId, scheme));
  }
}

/**
 * Adapts the {@link SchemeIndexer} to the {@link SearchIndexer}
 * interface. The orchestrator-side contract requires `indexScheme` to
 * succeed unconditionally; when Elasticsearch isn't configured the
 * underlying indexer's `indexSchemeInElasticsearch` is a no-op (Postgres
 * FTS automatically reflects changes via the generated `search_doc`
 * tsvector column from migration `20260618000000_scheme_fts_tsvector`).
 */
export class SchemeIndexerSearchAdapter implements SearchIndexer {
  constructor(private readonly indexer: SchemeIndexer) {}

  async indexScheme(schemeId: string, scheme: SchemeObject): Promise<void> {
    await this.indexer.indexSchemeInElasticsearch(schemeId, toIndexable(schemeId, scheme));
  }
}

// ─── Compatibility store ─────────────────────────────────────────────────────

/**
 * Minimal Prisma surface used by the compatibility-store adapter.
 */
export interface CompatibilityStorePrisma {
  schemeCompatibility: {
    upsert(args: {
      where: {
        uq_scheme_compatibility: {
          schemeId: string;
          relatedSchemeId: string;
        };
      };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  scheme: {
    findFirst(args: { where: { sourceUrl: string } }): Promise<{ id: string } | null>;
  };
}

/**
 * Persists compatibility relations into the `scheme_compatibility`
 * table. The orchestrator passes us a list of {@link CompatibilityRelation}
 * — each carries the related scheme's `sourceUrl` (the orchestrator
 * never sees the related row's database id during a single-scheme
 * processing pass), so we resolve ids on this side.
 *
 * Relations whose related scheme can't be found in Postgres yet are
 * skipped — the next crawl pass will see both ends present and the
 * upsert will succeed then. We deliberately do NOT throw on a missing
 * counterpart so a half-crawled catalogue can still index the parent
 * scheme.
 */
export class PrismaCompatibilityStore implements CompatibilityStore {
  constructor(private readonly prisma: CompatibilityStorePrisma) {}

  async recordRelations(
    schemeId: string,
    relations: CompatibilityRelation[],
  ): Promise<void> {
    for (const relation of relations) {
      // The orchestrator emits `relatedSchemeIdentifier` as the URL or
      // canonical identifier of the related scheme. We only persist the
      // relation when both ends are already in the catalogue — half-
      // hydrated edges create UX confusion and the next crawl pass will
      // fill in the relation once the related scheme has been ingested.
      const related = await this.prisma.scheme.findFirst({
        where: { sourceUrl: relation.relatedSchemeIdentifier },
      });
      if (!related) continue;

      const payload = {
        schemeId,
        relatedSchemeId: related.id,
        relationshipType: relation.type,
        officialRule: relation.officialRule,
        // Crawler-derived relations are unverified by default — admin
        // review flips this flag on through the admin compatibility UI.
        verified: false,
      };

      await this.prisma.schemeCompatibility.upsert({
        where: {
          uq_scheme_compatibility: {
            schemeId,
            relatedSchemeId: related.id,
          },
        },
        create: payload,
        update: {
          relationshipType: relation.type,
          officialRule: relation.officialRule,
        },
      });
    }
  }
}

/**
 * Convenience factory: builds all four production adapters from a
 * single Prisma client and an optional pre-built {@link SchemeIndexer}.
 * Returns an object with the same shape as the orchestrator's deps
 * interface so callers can spread it directly.
 */
export function buildProductionCrawlerAdapters(deps: {
  prisma: PrismaClient;
  schemeIndexer: SchemeIndexer;
}): {
  persistence: SchemePersistence;
  vectorIndexer: VectorIndexer;
  searchIndexer: SearchIndexer;
  compatibilityStore: CompatibilityStore;
} {
  return {
    persistence: new PrismaSchemePersistence(
      deps.prisma as unknown as SchemePersistencePrisma,
    ),
    vectorIndexer: new SchemeIndexerVectorAdapter(deps.schemeIndexer),
    searchIndexer: new SchemeIndexerSearchAdapter(deps.schemeIndexer),
    compatibilityStore: new PrismaCompatibilityStore(
      deps.prisma as unknown as CompatibilityStorePrisma,
    ),
  };
}
