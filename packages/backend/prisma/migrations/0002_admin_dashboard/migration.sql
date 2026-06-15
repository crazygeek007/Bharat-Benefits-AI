-- Add admin role to users (Req 17.6 — admin authorization)
ALTER TABLE "users" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'citizen';

-- Index user role for fast admin lookups
CREATE INDEX "idx_user_role" ON "users"("role");

-- Flagged schemes pending admin review (Req 17.3, 17.5, 17.6)
CREATE TABLE "scheme_flags" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "flag_source" TEXT NOT NULL,
    "source_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),
    "resolution_note" TEXT,
    "flagged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_flags_pkey" PRIMARY KEY ("id")
);

-- Index by flag date (Req 17.3 — sorted by flag date, most recent first)
CREATE INDEX "idx_scheme_flag_date" ON "scheme_flags"("flagged_at");

-- Index by status for "pending" filter on admin dashboard
CREATE INDEX "idx_scheme_flag_status" ON "scheme_flags"("status");

-- Index by scheme id
CREATE INDEX "idx_scheme_flag_scheme_id" ON "scheme_flags"("scheme_id");

-- Cascade delete when the underlying scheme is removed
ALTER TABLE "scheme_flags"
    ADD CONSTRAINT "scheme_flags_scheme_id_fkey"
    FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
