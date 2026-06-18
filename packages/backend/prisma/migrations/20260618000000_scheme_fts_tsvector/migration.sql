-- ─────────────────────────────────────────────────────────────────────────────
--  Postgres full-text search column + GIN index on schemes.
--
--  Why
--  ---
--  We're dropping Elasticsearch as a managed service. ES was doing keyword
--  search for `/api/schemes/search`. Postgres FTS (tsvector + tsquery,
--  GIN index) covers the same use case at our scale (≤ 100k schemes) with
--  no extra infrastructure to run, monitor, or pay for. Pinecone remains
--  the semantic side of the hybrid retriever — see services/scheme-search.
--
--  Design
--  ------
--  - One generated `search_doc` column of type `tsvector`. Generated columns
--    stay automatically in sync with their inputs so the application code
--    doesn't need to maintain it (no trigger, no manual UPDATE).
--  - Field weights:
--        A = name        (highest match weight)
--        B = category
--        C = description
--    These match FIELD_WEIGHTS in services/scheme-search/scheme-search.ts
--    so the in-memory fallback and Postgres path rank consistently.
--  - Dictionary: `english`. Indian scheme names are predominantly English
--    transliterations of Hindi (PMKSY, Ayushman Bharat) so the English
--    stemmer/stopwords give the best out-of-the-box behaviour. `simple`
--    would over-match common words; full multilingual support would need
--    a dictionary per language, which is more than we need today.
--  - Index: GIN. Required for tsvector queries to use the index instead
--    of scanning every row.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "schemes"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')),        'A') ||
    setweight(to_tsvector('english', coalesce("category", '')),    'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;

CREATE INDEX "idx_scheme_search_doc"
  ON "schemes"
  USING gin ("search_doc");
