# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

npm workspaces monorepo with three packages:

- `packages/shared` — Types, password policy, Indian state list. Consumed by both other packages via `@bharat-benefits/shared`. Built as a real TypeScript project (`dist/*.d.ts`); the consumers reference it via project references, so its build artifacts must exist before backend/frontend can typecheck on a clean clone.
- `packages/backend` — Fastify API + background workers (Node 18+). Prisma client output lives at `packages/backend/src/generated/prisma` (custom output dir; do not import `@prisma/client` directly — use `lib/prisma.ts`).
- `packages/frontend` — Next.js 14 App Router, NextAuth for sessions.

Requirements/design/tasks specs live in `.kiro/specs/bharat-benefits-ai/`. Code is heavily annotated with `Req X.Y` markers that trace back to `requirements.md` (25 requirements, 30 property tests). When changing behavior, search for the matching `Req X.Y` comment first — those mark contract surfaces and most changes need the requirement re-read.

## Common commands

From repo root (npm workspaces — these fan out to each package):

```bash
npm install                                    # also runs `prisma generate` via backend postinstall
npm run build                                  # builds every workspace
npm run dev:backend                            # tsx watch on packages/backend
npm run dev:frontend                           # next dev on packages/frontend
npm test                                       # full vitest suite (every package)
npm run lint
npm run format
```

Single test / focused runs:

```bash
npx vitest run packages/backend/src/services/eligibility           # one directory
npx vitest run packages/backend/src/services/eligibility/eligibility-engine.test.ts
npx vitest -t "calculates partial eligibility"                     # filter by test name
npx vitest watch packages/backend/src/services/recommendation
```

Backend-only DB ops (run from `packages/backend/`):

```bash
npm run db:generate                            # regen Prisma client
npm run db:migrate:dev                         # create + apply migration in dev
npm run db:migrate:deploy                      # apply pending migrations (prod)
npm run db:studio
```

Typechecking — CI runs each package separately. Mirror that locally when typing-up a change:

```bash
npm run build --workspace=packages/shared      # MUST be first — produces the .d.ts that backend/frontend reference
npx tsc -p packages/backend --noEmit
npx tsc -p packages/frontend --noEmit
npx tsc -p packages/shared --noEmit
```

`JWT_SECRET` must be at least 32 bytes for auth tests to load. The CI workflow sets one; for local `npm test` runs, export your own (any 32+ byte string works).

## Architecture

### Multi-agent pipeline (the core AI flow)

Citizen queries go through `services/multi-agent/multi-agent-pipeline.ts`:

```
Planner → Eligibility → Retrieval → Compatibility → Recommendation → Response
```

- Per-agent budget 5 s, total wall-clock 10 s (constants exported from the pipeline file). If an agent throws or times out, the orchestrator **bypasses it and continues with whatever upstream output exists** — this is Req 25.9 and is intentional, not a bug. Don't add early-return error handling.
- A single `traceId` (UUID) threads through every agent and is the join key in `assistant_query_logs`. Adding new agents/spans must propagate it.
- Agents are dependency-injected, so the orchestrator can be unit-tested with in-memory fakes. The real LLM-backed agents live in sibling service directories.

The Scheme Assistant (`services/assistant/scheme-assistant.ts`) is a simpler RAG path used by the chat UI; the multi-agent pipeline is what processes structured citizen queries.

### Data flow

- **Crawler** (`services/crawler/`): orchestrator runs daily, parsers (HTML/PDF/JSON/XML) extract `SchemeObject`, source-validator rejects anything not on `gov.in`/`nic.in`/configured ministry portals, trust-score gates visibility (< 60 ⇒ hidden). New schemes flow to Postgres → vector DB (Pinecone, 768-dim Gemini embeddings, mirrored in pgvector) → change detector. Keyword search is served by Postgres FTS (`schemes.search_doc` generated tsvector + GIN index) — Elasticsearch is OPTIONAL and only engages when `ELASTICSEARCH_NODE` is set.
- **Eligibility & Recommendation** are recalculated when a profile changes (wired in `services/integration/profile-update-integration.ts`). The 30 s / 60 s recalc budgets are real SLOs traced to Req 3.3, 5.5.
- **Daily scheduler** (`workers/daily-scheduler.ts`) runs in-process by default — verification at 02:00 IST, deadline scan every 30 min. Set `DISABLE_SCHEDULER=true` when running multiple backend replicas so only one host owns the cron.

### Auth — two JWTs, on purpose

NextAuth issues an **encrypted** JWE for its session cookie; the backend issues a **signed** JWS for `Authorization: Bearer …`. They are not interchangeable. We bundle the backend-issued JWS inside the NextAuth session (`backendToken` field on the session) so server components can call protected APIs. See the long comment block at the top of `packages/frontend/src/lib/auth.ts` before touching this — every change here has bitten someone.

Profile data is AES-256 encrypted at rest using `PROFILE_ENCRYPTION_KEY` (separate from `JWT_SECRET`). The `audit.middleware.ts` records every profile read/write to the partitioned `audit_logs` table (365-day retention; partitioning migration `20260615001000`).

### Health probes

Three endpoints, deliberately different:

- `GET /health` — legacy liveness, retained so existing LB configs don't break.
- `GET /healthz` — canonical liveness, never touches dependencies.
- `GET /readyz` — readiness; runs DB + Redis + Pinecone + Elasticsearch checks each bounded at 2 s, returns 503 if any fail. The load balancer should pull the pod when this trips.

### Property tests

`*.property.test.ts` files are fast-check based and validate universal invariants for one of the 30 named correctness properties from the design doc (e.g., "Property 8: Recommendation Ranking Order"). They are the *contract* — when changing a service, check whether its property test still holds before touching the example tests.

## Environment variables

Required for the backend to start without falling over:

```
DATABASE_URL                     # Postgres (must have pgvector + uuid-ossp extensions)
JWT_SECRET                       # ≥ 32 bytes
PROFILE_ENCRYPTION_KEY           # AES-256 key
REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
GEMINI_API_KEY                   # primary LLM (chat + embeddings)
GEMINI_CHAT_MODEL, GEMINI_EMBEDDING_MODEL
PINECONE_API_KEY, PINECONE_INDEX_NAME, PINECONE_NAMESPACE
ELASTICSEARCH_NODE, ELASTICSEARCH_USERNAME, ELASTICSEARCH_PASSWORD
AZURE_SPEECH_KEY, AZURE_SPEECH_REGION   # voice assistant; service is inert without these
NEXTAUTH_SECRET                  # frontend
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   # optional — Google social login is skipped if unset
FRONTEND_URL                     # CORS origin for backend (defaults http://localhost:3000)
BACKEND_URL                      # used by NextAuth credentials provider (defaults http://localhost:4000)
DISABLE_SCHEDULER=true           # set on all-but-one replica when scaling horizontally
```

In production `NODE_ENV=production` flips on HSTS + a TLS pre-handler that 403s plain-HTTP requests (health probes exempted).

## Conventions that aren't obvious from the code

- **Service-test colocation**: every service has its `*.test.ts` (examples) and often `*.property.test.ts` (invariants) in the same directory. New services should follow the same layout.
- **Routes are thin**: `routes/*.routes.ts` validate input via Zod schemas in `schemas/*.schemas.ts` and call into `services/`. Business logic does not live in routes.
- **The crawler test directory contains two integration test files**: `crawler-pipeline-integration.test.ts` and `orchestrator.test.ts`. They are slower than unit tests but still run under `npm test` — there is no separate integration suite.
- **Vitest path aliases** (`@shared`, `@backend`, `@frontend`) are configured in the root `vitest.config.ts`, not in any tsconfig. Don't import via these aliases in production code — they're test-only.
- **Prisma extensions** (pgvector, uuid-ossp) are declared in `schema.prisma`. A fresh dev database must have them available before `db:migrate:deploy` will succeed.

## CI

`.github/workflows/ci.yml` gates merges on lint, typecheck (per package), tests, and Prisma schema-vs-migrations drift. The "Build shared package" step before any typecheck is load-bearing — without it the consumers fail with TS6305 on a clean runner.
