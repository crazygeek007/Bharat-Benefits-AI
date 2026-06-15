-- AI observability subsystem (Requirement 21).
--
-- Three tables:
--   * assistant_query_logs       — every Scheme_Assistant query / response.
--                                  Retained for 90 days (Req 21.1) by the
--                                  daily retention sweep against `created_at`.
--   * assistant_response_feedback — citizen helpful / unhelpful ratings
--                                  (Req 21.3). One row per (trace_id, user_id)
--                                  pair so re-rating replaces the prior row.
--   * evaluation_runs            — weekly automated evaluation results
--                                  (Req 21.6).

-- ─── assistant_query_logs ───────────────────────────────────────────────────
CREATE TABLE "assistant_query_logs" (
    "id"               UUID NOT NULL,
    "trace_id"         TEXT NOT NULL,
    "session_id"       TEXT NOT NULL,
    "user_id"          UUID,
    "query"            TEXT NOT NULL,
    "response"         TEXT NOT NULL,
    "retrieved_chunks" JSONB NOT NULL,
    "sources"          JSONB NOT NULL,
    "language"         TEXT NOT NULL,
    "duration_ms"      INTEGER NOT NULL,
    "degraded"         BOOLEAN NOT NULL DEFAULT FALSE,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_query_logs_pkey" PRIMARY KEY ("id")
);

-- The trace id is the primary join column from feedback rows. We make it
-- unique so the FK from assistant_response_feedback can target it
-- directly without bringing in the surrogate id.
CREATE UNIQUE INDEX "uq_assistant_query_log_trace_id"
    ON "assistant_query_logs"("trace_id");

CREATE INDEX "idx_assistant_query_log_session_id"
    ON "assistant_query_logs"("session_id");

CREATE INDEX "idx_assistant_query_log_user_id"
    ON "assistant_query_logs"("user_id");

-- Drives the daily retention sweep (Req 21.1) and the recent-traces
-- admin dashboard view.
CREATE INDEX "idx_assistant_query_log_created_at"
    ON "assistant_query_logs"("created_at");

-- Drives the "degraded traces" admin dashboard view (Req 21.7).
CREATE INDEX "idx_assistant_query_log_degraded"
    ON "assistant_query_logs"("degraded");

-- ─── assistant_response_feedback ────────────────────────────────────────────
CREATE TABLE "assistant_response_feedback" (
    "id"         UUID NOT NULL,
    "trace_id"   TEXT NOT NULL,
    "user_id"    UUID,
    "rating"     TEXT NOT NULL,
    "comment"    TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_response_feedback_pkey" PRIMARY KEY ("id")
);

-- One rating per (trace_id, user_id) pair (Req 21.3).
CREATE UNIQUE INDEX "uq_assistant_response_feedback_trace_user"
    ON "assistant_response_feedback"("trace_id", "user_id");

CREATE INDEX "idx_assistant_response_feedback_trace_id"
    ON "assistant_response_feedback"("trace_id");

CREATE INDEX "idx_assistant_response_feedback_user_id"
    ON "assistant_response_feedback"("user_id");

-- Drives the rolling 100-response helpfulness window (Req 21.4).
CREATE INDEX "idx_assistant_response_feedback_created_at"
    ON "assistant_response_feedback"("created_at");

CREATE INDEX "idx_assistant_response_feedback_rating"
    ON "assistant_response_feedback"("rating");

-- Cascade so feedback rows go away when their query log is purged by
-- the 90-day retention sweep.
ALTER TABLE "assistant_response_feedback"
    ADD CONSTRAINT "assistant_response_feedback_trace_id_fkey"
    FOREIGN KEY ("trace_id") REFERENCES "assistant_query_logs"("trace_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── evaluation_runs ────────────────────────────────────────────────────────
CREATE TABLE "evaluation_runs" (
    "id"                   UUID NOT NULL,
    "started_at"           TIMESTAMP(3) NOT NULL,
    "finished_at"          TIMESTAMP(3) NOT NULL,
    "total_cases"          INTEGER NOT NULL,
    "precision"            DECIMAL(6,4) NOT NULL,
    "recall"               DECIMAL(6,4) NOT NULL,
    "answer_correct_count" INTEGER NOT NULL,
    "results"              JSONB NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_evaluation_run_started_at"
    ON "evaluation_runs"("started_at");

CREATE INDEX "idx_evaluation_run_finished_at"
    ON "evaluation_runs"("finished_at");
