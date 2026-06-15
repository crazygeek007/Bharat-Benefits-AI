-- ─────────────────────────────────────────────────────────────────────────────
--  Align scheme embedding dimension with the active embedding model and add a
--  vector index for fast similarity search.
--
--  The application embedded with OpenAI (1536 dims) historically; the codebase
--  has since switched to Gemini text-embedding-004 (768 dims). With the column
--  defined as vector(1536) every insert from the new pipeline raises
--  "expected 1536 dimensions, not 768" and the table goes silent.
--
--  Sequential scans over a vector(768) column become expensive past a few
--  thousand rows. An HNSW index on cosine distance gives sub-100ms similarity
--  search up to millions of rows.
--
--  Strategy
--  1. Drop the existing column. We cannot ALTER the dim of a pgvector column
--     without losing data, but the column has historically been written by
--     the no-op crawler stub so existing rows have no semantic meaning.
--     The crawler will repopulate on the next run.
--  2. Recreate as vector(768).
--  3. Add an HNSW index with cosine ops — matches the operator the assistant
--     uses (`<#>` for inner product, `<=>` for cosine distance).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop dependent indexes / constraints first.
DROP INDEX IF EXISTS "idx_scheme_embedding_scheme_id";

-- 2. Truncate then drop & recreate the column to change its dimension.
--    `IF EXISTS` so re-running the migration on a fresh DB is safe.
ALTER TABLE "scheme_embeddings" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "scheme_embeddings" ADD COLUMN "embedding" vector(768);

-- 3. Recreate the trivial scheme_id index.
CREATE INDEX "idx_scheme_embedding_scheme_id" ON "scheme_embeddings" ("scheme_id");

-- 4. HNSW similarity index — cosine distance matches the assistant's
--    `MIN_CHUNK_SIMILARITY` cutoff (0.2 cosine similarity).
--    Builds may take a while on large tables; on an empty table this is fast.
CREATE INDEX IF NOT EXISTS "idx_scheme_embedding_vector"
  ON "scheme_embeddings"
  USING hnsw ("embedding" vector_cosine_ops);


-- Drop the redundant non-unique index on assistant_query_logs.trace_id.
-- The `@unique` constraint Prisma applies to that column already creates
-- an index that the trace-id lookup hits. Keeping both wastes disk and
-- adds write amplification on every insert.
DROP INDEX IF EXISTS "idx_assistant_query_log_trace_id";
