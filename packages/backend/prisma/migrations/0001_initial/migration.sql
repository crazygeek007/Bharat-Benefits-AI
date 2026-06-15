-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "auth_provider" TEXT NOT NULL DEFAULT 'email',
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login" TIMESTAMP(3),
    "session_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "age" INTEGER,
    "gender" TEXT,
    "state" TEXT,
    "district" TEXT,
    "income_level" DECIMAL(12,2),
    "occupation" TEXT,
    "education_level" TEXT,
    "caste_category" TEXT,
    "disability_status" BOOLEAN,
    "marital_status" TEXT,
    "dependents" INTEGER,
    "language_preference" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schemes" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ministry" TEXT NOT NULL,
    "state" TEXT,
    "category" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "benefit_type" TEXT,
    "benefit_amount" DECIMAL(14,2),
    "deadline" DATE,
    "application_mode" TEXT,
    "application_url" TEXT,
    "eligibility_criteria" JSONB,
    "application_steps" JSONB,
    "trust_score" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_versions" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "previous_values" JSONB,
    "new_values" JSONB,
    "changed_fields" TEXT NOT NULL,
    "source_url" TEXT,
    "change_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version_number" INTEGER NOT NULL,

    CONSTRAINT "scheme_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_compatibility" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "related_scheme_id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "official_rule" TEXT,
    "source_url" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "scheme_compatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_schemes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'saved',
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "saved_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_documents" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "document_name" TEXT NOT NULL,
    "description" TEXT,
    "format" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "scheme_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scheme_id" UUID,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "details" JSONB,
    "actor_identity" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheme_embeddings" (
    "id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "embedding" vector(1536),
    "chunk_index" INTEGER NOT NULL,

    CONSTRAINT "scheme_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_user_id_key" ON "user_profiles"("user_id");

-- CreateIndex: scheme by category
CREATE INDEX "idx_scheme_category" ON "schemes"("category");

-- CreateIndex: scheme by state
CREATE INDEX "idx_scheme_state" ON "schemes"("state");

-- CreateIndex: scheme by trust_score
CREATE INDEX "idx_scheme_trust_score" ON "schemes"("trust_score");

-- CreateIndex: scheme by verified status
CREATE INDEX "idx_scheme_verified" ON "schemes"("verified");

-- CreateIndex: scheme by deadline
CREATE INDEX "idx_scheme_deadline" ON "schemes"("deadline");

-- CreateIndex: scheme versions by scheme_id and version_number
CREATE INDEX "idx_scheme_version_scheme_id" ON "scheme_versions"("scheme_id", "version_number");

-- CreateIndex: unique scheme compatibility pair
CREATE UNIQUE INDEX "scheme_compatibility_scheme_id_related_scheme_id_key" ON "scheme_compatibility"("scheme_id", "related_scheme_id");

-- CreateIndex: saved schemes by user
CREATE INDEX "idx_saved_scheme_user_id" ON "saved_schemes"("user_id");

-- CreateIndex: unique user-scheme save pair
CREATE UNIQUE INDEX "saved_schemes_user_id_scheme_id_key" ON "saved_schemes"("user_id", "scheme_id");

-- CreateIndex: scheme documents by scheme
CREATE INDEX "idx_scheme_document_scheme_id" ON "scheme_documents"("scheme_id");

-- CreateIndex: notifications by user
CREATE INDEX "idx_notification_user_id" ON "notifications"("user_id");

-- CreateIndex: notifications by status
CREATE INDEX "idx_notification_status" ON "notifications"("status");

-- CreateIndex: audit logs by user
CREATE INDEX "idx_audit_log_user_id" ON "audit_logs"("user_id");

-- CreateIndex: audit logs by resource
CREATE INDEX "idx_audit_log_resource" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex: audit logs by timestamp
CREATE INDEX "idx_audit_log_timestamp" ON "audit_logs"("timestamp");

-- CreateIndex: scheme embeddings by scheme
CREATE INDEX "idx_scheme_embedding_scheme_id" ON "scheme_embeddings"("scheme_id");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_versions" ADD CONSTRAINT "scheme_versions_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_compatibility" ADD CONSTRAINT "scheme_compatibility_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_compatibility" ADD CONSTRAINT "scheme_compatibility_related_scheme_id_fkey" FOREIGN KEY ("related_scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_schemes" ADD CONSTRAINT "saved_schemes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_schemes" ADD CONSTRAINT "saved_schemes_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_documents" ADD CONSTRAINT "scheme_documents_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_embeddings" ADD CONSTRAINT "scheme_embeddings_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
