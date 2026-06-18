/**
 * Scheme Indexer — generates embeddings for scheme content, upserts them
 * into the Pinecone vector index, persists `SchemeEmbedding` rows in
 * Postgres, and (optionally) indexes the scheme document into
 * Elasticsearch for full-text search.
 *
 * Elasticsearch is OPTIONAL — Postgres FTS over the `schemes.search_doc`
 * generated tsvector column (see migration 20260618000000) covers keyword
 * search out of the box without any indexer-side work. When the ES env
 * vars are unset the indexer skips ES operations silently. Tests that
 * inject a stub `esClient` continue to exercise the call paths.
 *
 * Validates: Requirements 6.1, 2.6
 */

import type {
  ApplicationStep,
  Benefit,
  EligibilityCriterion,
  Scheme,
} from '@bharat-benefits/shared';

import { getElasticsearchClient, SCHEMES_INDEX } from '../../lib/elasticsearch';
import { getSchemeIndex, getSchemeNamespace } from '../../lib/vectordb';
import { prisma } from '../../lib/prisma';
import {
  chunkText,
  generateEmbedding,
  type EmbeddingsClient,
} from './embeddings';

// ─── Minimal client interfaces (for dependency injection in tests) ───────────

/** Subset of the Pinecone `Index` API used by this module. */
export interface VectorIndex {
  namespace?(name: string): VectorIndex;
  upsert(records: VectorRecord[]): Promise<unknown>;
  deleteMany(ids: string[]): Promise<unknown>;
}

/** Vector record shape we send to Pinecone. */
export interface VectorRecord {
  id: string;
  values: number[];
  metadata: {
    schemeId: string;
    chunkIndex: number;
    chunkText: string;
  };
}

/** Subset of the Elasticsearch client API used by this module. */
export interface ElasticsearchLikeClient {
  index(args: {
    index: string;
    id: string;
    document: SchemeSearchDocument;
  }): Promise<unknown>;
  delete(args: { index: string; id: string }): Promise<unknown>;
}

/** Subset of the Prisma client surface used by this module. */
export interface SchemeEmbeddingPersister {
  schemeEmbedding: {
    deleteMany(args: { where: { schemeId: string } }): Promise<unknown>;
    createMany(args: {
      data: Array<{ schemeId: string; chunkText: string; chunkIndex: number }>;
    }): Promise<unknown>;
  };
}

/** Document stored in Elasticsearch for a scheme. */
export interface SchemeSearchDocument {
  schemeId: string;
  name: string;
  description: string;
  category: string;
  state: string | null;
  ministry: string;
  eligibilityCriteria: string;
  benefits: string;
  applicationSteps: string;
  sourceUrl: string;
  trustScore: number;
  verified: boolean;
  lastVerifiedAt: string | null;
}

// ─── Public input shape ──────────────────────────────────────────────────────

/**
 * Minimal scheme shape accepted by the indexer. Compatible with the
 * shared `Scheme` interface but uses optional/nullable fields where
 * practical so partially-populated records can still be indexed.
 */
export interface IndexableScheme {
  id?: string;
  name: string;
  description: string;
  ministry: string;
  state?: string | null;
  category: string;
  sourceUrl: string;
  eligibilityCriteria?: EligibilityCriterion[] | null;
  benefits?: Benefit[] | null;
  applicationSteps?: ApplicationStep[] | null;
  trustScore?: number;
  verified?: boolean;
  lastVerifiedAt?: Date | string | null;
}

// ─── Dependency container ────────────────────────────────────────────────────

export interface SchemeIndexerDeps {
  /** Vector index client (Pinecone-like). */
  vectorIndex?: VectorIndex;
  /** Elasticsearch-like client. */
  esClient?: ElasticsearchLikeClient;
  /** Prisma-like client for embedding persistence. */
  db?: SchemeEmbeddingPersister;
  /** Embeddings client used to generate vectors. */
  embeddingsClient?: EmbeddingsClient;
  /** Pinecone namespace, if any. */
  namespace?: string;
  /** Elasticsearch index name. Defaults to {@link SCHEMES_INDEX}. */
  schemesIndex?: string;
}

// ─── Indexer factory ─────────────────────────────────────────────────────────

export interface SchemeIndexer {
  indexSchemeInVectorDB(schemeId: string, scheme: IndexableScheme): Promise<void>;
  indexSchemeInElasticsearch(schemeId: string, scheme: IndexableScheme): Promise<void>;
  removeSchemeFromIndices(schemeId: string): Promise<void>;
}

/**
 * Creates a {@link SchemeIndexer} bound to the given dependencies.
 * Production callers can omit `deps` and the default Pinecone/ES/Prisma
 * clients are used. Tests pass in mocks for full isolation.
 */
export function createSchemeIndexer(deps: SchemeIndexerDeps = {}): SchemeIndexer {
  const schemesIndex = deps.schemesIndex ?? SCHEMES_INDEX;

  function getVectorIndex(): VectorIndex {
    let base: VectorIndex;
    let namespace: string | undefined;

    if (deps.vectorIndex) {
      base = deps.vectorIndex;
      namespace = deps.namespace;
    } else {
      base = getSchemeIndex() as unknown as VectorIndex;
      namespace = deps.namespace ?? getSchemeNamespace();
    }

    if (namespace && typeof base.namespace === 'function') {
      return base.namespace(namespace);
    }
    return base;
  }

  function getEsClient(): ElasticsearchLikeClient | null {
    if (deps.esClient) return deps.esClient;
    // When ELASTICSEARCH_NODE isn't configured, we treat the ES indexer as
    // disabled. Postgres FTS handles keyword search via the schemes table's
    // generated `search_doc` column — no indexer-side work needed for that.
    // Tests that pass an explicit `deps.esClient` still exercise the
    // happy-path code below.
    if (!process.env.ELASTICSEARCH_NODE) return null;
    return getElasticsearchClient() as unknown as ElasticsearchLikeClient;
  }

  function getDb(): SchemeEmbeddingPersister {
    return deps.db ?? (prisma as unknown as SchemeEmbeddingPersister);
  }

  return {
    async indexSchemeInVectorDB(schemeId, scheme) {
      assertSchemeId(schemeId);
      const text = buildSchemeText(scheme);
      const chunks = chunkText(text);

      const db = getDb();
      // Always clear existing rows for idempotent re-indexing.
      await db.schemeEmbedding.deleteMany({ where: { schemeId } });

      if (chunks.length === 0) {
        return;
      }

      const vectorIndex = getVectorIndex();
      const records: VectorRecord[] = [];
      const dbRows: Array<{
        schemeId: string;
        chunkText: string;
        chunkIndex: number;
      }> = [];

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const embedding = deps.embeddingsClient
          ? await generateEmbedding(chunk, deps.embeddingsClient)
          : await generateEmbedding(chunk);

        records.push({
          id: `${schemeId}-${chunkIndex}`,
          values: embedding,
          metadata: { schemeId, chunkIndex, chunkText: chunk },
        });

        dbRows.push({ schemeId, chunkText: chunk, chunkIndex });
      }

      await vectorIndex.upsert(records);
      await db.schemeEmbedding.createMany({ data: dbRows });
    },

    async indexSchemeInElasticsearch(schemeId, scheme) {
      assertSchemeId(schemeId);
      const client = getEsClient();
      // No client configured ⇒ ES disabled. Postgres FTS already indexes
      // the scheme via the `search_doc` generated column at write time.
      if (!client) return;
      const document = buildSearchDocument(schemeId, scheme);
      await client.index({
        index: schemesIndex,
        id: schemeId,
        document,
      });
    },

    async removeSchemeFromIndices(schemeId) {
      assertSchemeId(schemeId);

      // 1. Find existing embedding chunk count so we can delete the
      //    corresponding Pinecone vectors. We rely on the Postgres rows
      //    as the source of truth for chunk indices; the same rows are
      //    deleted afterwards.
      const db = getDb() as SchemeEmbeddingPersister & {
        schemeEmbedding: {
          findMany?: (args: {
            where: { schemeId: string };
            select?: { chunkIndex: boolean };
          }) => Promise<Array<{ chunkIndex: number }>>;
        };
      };

      let chunkIndices: number[] = [];
      if (typeof db.schemeEmbedding.findMany === 'function') {
        const rows = await db.schemeEmbedding.findMany({
          where: { schemeId },
          select: { chunkIndex: true },
        });
        chunkIndices = rows.map((r) => r.chunkIndex);
      }

      const vectorIds = chunkIndices.map((i) => `${schemeId}-${i}`);
      if (vectorIds.length > 0) {
        await getVectorIndex().deleteMany(vectorIds);
      }

      await db.schemeEmbedding.deleteMany({ where: { schemeId } });

      const client = getEsClient();
      // ES disabled ⇒ nothing to remove from the keyword index. Postgres
      // FTS handles deletion automatically when the scheme row is removed.
      if (!client) return;
      try {
        await client.delete({ index: schemesIndex, id: schemeId });
      } catch (error) {
        // Ignore 404s when the document was never indexed; rethrow others.
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
    },
  };
}

// ─── Convenience module-level wrappers ───────────────────────────────────────

/** Index a scheme into Pinecone + Postgres using the default clients. */
export async function indexSchemeInVectorDB(
  schemeId: string,
  scheme: IndexableScheme,
): Promise<void> {
  return createSchemeIndexer().indexSchemeInVectorDB(schemeId, scheme);
}

/** Index a scheme document into Elasticsearch using the default client. */
export async function indexSchemeInElasticsearch(
  schemeId: string,
  scheme: IndexableScheme,
): Promise<void> {
  return createSchemeIndexer().indexSchemeInElasticsearch(schemeId, scheme);
}

/** Remove a scheme from all search indices using the default clients. */
export async function removeSchemeFromIndices(schemeId: string): Promise<void> {
  return createSchemeIndexer().removeSchemeFromIndices(schemeId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertSchemeId(schemeId: string): void {
  if (typeof schemeId !== 'string' || schemeId.trim().length === 0) {
    throw new Error('schemeId must be a non-empty string');
  }
}

/**
 * Concatenates the scheme's textual content into a single document
 * suitable for embedding/chunking. Sections are separated by blank
 * lines so chunk boundaries respect logical structure.
 */
export function buildSchemeText(scheme: IndexableScheme): string {
  const sections: string[] = [];

  if (scheme.name) {
    sections.push(`Name: ${scheme.name}`);
  }
  if (scheme.ministry) {
    sections.push(`Ministry: ${scheme.ministry}`);
  }
  if (scheme.state) {
    sections.push(`State: ${scheme.state}`);
  }
  if (scheme.category) {
    sections.push(`Category: ${scheme.category}`);
  }
  if (scheme.description) {
    sections.push(`Description: ${scheme.description}`);
  }

  const criteriaText = stringifyCriteria(scheme.eligibilityCriteria);
  if (criteriaText) {
    sections.push(`Eligibility Criteria:\n${criteriaText}`);
  }

  const benefitsText = stringifyBenefits(scheme.benefits);
  if (benefitsText) {
    sections.push(`Benefits:\n${benefitsText}`);
  }

  const stepsText = stringifyApplicationSteps(scheme.applicationSteps);
  if (stepsText) {
    sections.push(`Application Steps:\n${stepsText}`);
  }

  return sections.join('\n\n');
}

function stringifyCriteria(
  criteria: EligibilityCriterion[] | null | undefined,
): string {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return '';
  }
  return criteria
    .map((c) => {
      const desc = c.description ? c.description : `${c.field} ${c.operator} ${formatValue(c.value)}`;
      return `- ${desc}`;
    })
    .join('\n');
}

function stringifyBenefits(benefits: Benefit[] | null | undefined): string {
  if (!Array.isArray(benefits) || benefits.length === 0) {
    return '';
  }
  return benefits
    .map((b) => {
      const amount = b.amount != null ? ` (₹${b.amount})` : '';
      return `- ${b.description ?? b.type}${amount}`;
    })
    .join('\n');
}

function stringifyApplicationSteps(
  steps: ApplicationStep[] | null | undefined,
): string {
  if (!Array.isArray(steps) || steps.length === 0) {
    return '';
  }
  return steps
    .slice()
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((s) => `${s.stepNumber}. ${s.action} → ${s.expectedOutcome}`)
    .join('\n');
}

function formatValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map((v) => formatValue(v)).join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Builds the Elasticsearch document for a scheme. Concatenates structured
 * lists into searchable text fields.
 */
export function buildSearchDocument(
  schemeId: string,
  scheme: IndexableScheme,
): SchemeSearchDocument {
  return {
    schemeId,
    name: scheme.name,
    description: scheme.description,
    category: scheme.category,
    state: scheme.state ?? null,
    ministry: scheme.ministry,
    eligibilityCriteria: stringifyCriteria(scheme.eligibilityCriteria),
    benefits: stringifyBenefits(scheme.benefits),
    applicationSteps: stringifyApplicationSteps(scheme.applicationSteps),
    sourceUrl: scheme.sourceUrl,
    trustScore: scheme.trustScore ?? 0,
    verified: scheme.verified ?? false,
    lastVerifiedAt: toIsoString(scheme.lastVerifiedAt),
  };
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const e = error as { statusCode?: number; meta?: { statusCode?: number }; name?: string };
  if (e.statusCode === 404 || e.meta?.statusCode === 404) {
    return true;
  }
  if (e.name === 'ResponseError' && e.meta?.statusCode === 404) {
    return true;
  }
  return false;
}

// Re-exports for convenience.
export type { Scheme };
