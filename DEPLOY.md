# Deployment runbook — Bharat Benefits AI

This is the step-by-step playbook for taking the platform from a clean clone to a public URL on Vercel (frontend) + Render (backend). Follow it top-to-bottom the first time; subsequent deploys are `git push` only.

> **Scope note.** This runbook gets you to a *working public deployment with seed schemes*. Going from "deployed" to "real-scheme launch" (Req 1) requires running the crawler against verified gov.in / nic.in sources and admin-approving every scheme that lands — that's content-ops work, not a deploy step. See the **Phase 4: Real scheme catalog** section at the end.

---

## Phase 0 — Accounts you need (sign up for these first)

| Service | What it provides | Free tier? |
|---|---|---|
| [Vercel](https://vercel.com) | Next.js hosting | Hobby is free for non-commercial; Pro $20/mo |
| [Render](https://render.com) | Fastify backend + cron | Starter ~$7/mo per service |
| **Postgres host** (you have one) | DB with `pgvector` + `uuid-ossp` extensions | Supabase/Neon free tiers work |
| [Upstash](https://upstash.com) | Serverless Redis | 10k commands/day free |
| [Pinecone](https://pinecone.io) (you have one) | Vector DB, 768-dim index for Gemini | Starter free up to 100k vectors |
| [Elastic Cloud](https://cloud.elastic.co) | Managed Elasticsearch | 14-day free trial, then ~$16/mo minimum |
| [Resend](https://resend.com) | Transactional email | 3k emails/mo free, requires verified domain |
| **Google AI Studio** (you have a key) | Gemini API | Free tier with rate limits |
| Domain registrar | Public domain | Whatever you prefer (Namecheap, Google Domains, etc.) |

You will paste API keys + connection strings into Render and Vercel dashboards — never commit them.

---

## Phase 1 — Provision services (do these in any order)

### 1.1 Postgres
1. In your Postgres host (Supabase / Neon / RDS), create a database called `bharat_benefits`.
2. Enable extensions:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```
3. Copy the connection string. It must end with `?sslmode=require` for managed hosts. Save as `DATABASE_URL`.

### 1.2 Redis (Upstash)
1. Create a new Redis database in the closest region to Singapore (Render backend region).
2. From the database page, copy:
   - Endpoint → `REDIS_HOST`
   - Port → `REDIS_PORT`
   - Password → `REDIS_PASSWORD`
3. Use the **TLS** endpoint, not the plain one.

### 1.3 Pinecone
1. Create an index named `bharat-schemes` with **dimension 768** (Gemini `text-embedding-004`) and metric `cosine`. The dimension must match `GEMINI_EMBEDDING_MODEL` — getting this wrong causes silent retrieval misses.
2. Generate an API key. Save as `PINECONE_API_KEY`.
3. Pick a namespace (`production` is fine). Save as `PINECONE_NAMESPACE`.

### 1.4 Elastic Cloud
1. Start a deployment, smallest tier, region close to Singapore.
2. From the deployment overview copy:
   - Endpoint → `ELASTICSEARCH_NODE`
   - The auto-generated `elastic` username + password → `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD`
3. (Optional, recommended) Create a scoped API key with `manage_index` on `schemes-*` and use that via `ELASTICSEARCH_API_KEY` instead of basic auth.

### 1.5 Resend
1. Verify the domain you'll send from (DNS records required — TXT + DKIM + DMARC). This can take an hour for propagation. Do it now so it's ready when you launch.
2. Create an API key with `Sending access`. Save as `RESEND_API_KEY`.
3. Set `RESEND_FROM` to e.g. `Bharat Benefits <noreply@yourdomain.in>` — must use the verified domain.

### 1.6 Domain
1. Buy your domain.
2. You'll point it at Vercel later (Phase 3). No action needed now beyond owning it.

---

## Phase 2 — Deploy the backend (Render)

### 2.1 Generate secrets
Run locally — these are the only secrets that don't come from a third party:

```bash
# JWT_SECRET (≥ 32 bytes)
openssl rand -base64 48

# PROFILE_ENCRYPTION_KEY (AES-256, 32 bytes)
openssl rand -base64 32

# NEXTAUTH_SECRET (≥ 32 bytes; SAME value goes to both backend and frontend)
openssl rand -base64 48
```

Save these three values in a password manager — you'll paste them into Render and Vercel.

### 2.2 Push the repo to GitHub
If you haven't already:

```bash
gh repo create Bharat-Benefits-AI --private --source . --push
```

### 2.3 Connect Render to the repo
1. Sign in to Render → **New** → **Blueprint**.
2. Connect your GitHub account, pick the `Bharat-Benefits-AI` repo.
3. Render finds `render.yaml` in the root and shows two services: `bharat-backend` (web) and `bharat-backend-migrate` (job).
4. **Edit `render.yaml` first** — replace the `repo: https://github.com/REPLACE_ME/...` lines with your actual repo URL, commit, push.

### 2.4 Set environment variables in Render
For **both** services in the Render dashboard, set every `sync: false` env var from `render.yaml`:

| Variable | Source |
|---|---|
| `DATABASE_URL` | Phase 1.1 |
| `JWT_SECRET` | Phase 2.1 |
| `PROFILE_ENCRYPTION_KEY` | Phase 2.1 |
| `NEXTAUTH_SECRET` | Phase 2.1 |
| `GEMINI_API_KEY` | your existing Gemini key |
| `PINECONE_API_KEY` | Phase 1.3 |
| `PINECONE_INDEX_NAME` | `bharat-schemes` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Phase 1.2 |
| `ELASTICSEARCH_NODE` / `ELASTICSEARCH_USERNAME` / `ELASTICSEARCH_PASSWORD` | Phase 1.4 |
| `RESEND_API_KEY` / `RESEND_FROM` | Phase 1.5 |
| `FRONTEND_URL` | leave blank for now; update after Vercel deploy |

### 2.5 First deploy
Render runs `bharat-backend-migrate` first (applies pending Prisma migrations), then `bharat-backend` boots. Watch the logs:

- Migrate job exits 0 → DB is ready.
- Backend logs `Server running at http://0.0.0.0:4000` and `Daily scheduler started` → API is live.

Verify:
```bash
curl https://<your-render-url>.onrender.com/healthz
# {"status":"ok","timestamp":"..."}
curl https://<your-render-url>.onrender.com/readyz
# {"ready":true,"checks":{...}}    ← all four checks must report healthy
```

If `/readyz` reports a failed check, fix that service before continuing — the load balancer will refuse traffic in production.

### 2.6 Seed initial schemes
SSH into the Render shell (Web Shell tab) and run:

```bash
cd packages/backend
npx tsx src/scripts/seed-schemes.ts
npx tsx src/scripts/seed-data.ts
npx tsx src/scripts/seed-data-batch2.ts
npx tsx src/scripts/seed-data-batch3.ts
npx tsx src/scripts/seed-data-batch4.ts
# Index everything into Pinecone + Elasticsearch
npx tsx src/scripts/index-schemes.ts
```

This populates a curated set of schemes so the site has content on day one. The crawler will extend this over time.

### 2.7 Create an admin user
The Admin Dashboard (Req 17) gates by `role = 'admin'` on the users table. Promote yourself after registering through the UI:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@yourdomain.in';
```

---

## Phase 3 — Deploy the frontend (Vercel)

### 3.1 Import the project
1. Vercel dashboard → **Add New** → **Project** → pick the GitHub repo.
2. **Root directory**: `packages/frontend`.
3. **Framework preset**: Next.js (auto-detected).
4. **Build command**: leave default (`next build`).
5. **Install command**: `npm install --prefix ../..` so npm picks up the workspace shared package.

   If Vercel struggles with the workspace, switch the **Install command** to:
   ```
   cd ../.. && npm ci && npm run build --workspace=packages/shared
   ```
   This builds the shared package before Next compiles.

### 3.2 Environment variables (Vercel dashboard → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `NEXTAUTH_SECRET` | Same value as the backend (Phase 2.1) |
| `NEXTAUTH_URL` | `https://<your-vercel-domain>.vercel.app` (or your custom domain) |
| `BACKEND_URL` | `https://<your-render-url>.onrender.com` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional — set if/when you wire Google login |

Apply each to **Production + Preview + Development** as appropriate.

### 3.3 First deploy
Push to `main` (or click **Deploy** in Vercel) — Vercel builds and ships. After it's live:

1. Go back to Render → backend service → Environment → set `FRONTEND_URL` to the Vercel URL → **Save and Deploy** (so CORS lets the frontend in).
2. Verify end-to-end:
   ```
   curl https://<vercel-url>/api/auth/csrf
   ```
   Should return a CSRF token. Open the UI, register a user, complete the profile, search for schemes — full flow should work.

### 3.4 Custom domain
1. Vercel → Settings → Domains → add your domain.
2. Update your registrar's DNS per Vercel's instructions (usually `A` record to `76.76.21.21` and a `CNAME` for `www`).
3. Vercel provisions a TLS cert automatically; takes a few minutes.
4. Update `NEXTAUTH_URL` (Vercel) and `FRONTEND_URL` (Render) to the new domain.

---

## Phase 4 — Going from "deployed" to "launched with real schemes"

You said you want a full launch with real scheme data. The platform code is built for it (Req 1, 7, 14, 22), but the actual catalog has to be populated and **admin-verified** before citizens see anything. Plan for this as a multi-week content-ops workstream, not a single deploy step.

1. **Curate source URLs.** Pick the gov.in / nic.in pages you want to ingest from. The crawler validates the domain (Req 1.1, 1.2) and refuses anything else. Set `CRAWLER_SOURCE_URLS` in Render.
2. **Run a crawl pass.** SSH into the Render shell:
   ```bash
   cd packages/backend
   npx tsx src/scripts/clean-old-schemes.ts        # optional reset
   # Then trigger the orchestrator via the admin dashboard, OR run the worker directly.
   ```
3. **Admin-review every flagged scheme** in the Admin Dashboard → Flags page. Trust scores below 60 are hidden by design (Req 1.7). The crawler also flags any scheme it can't fully parse (Req 7.6, 22.6).
4. **Compatibility relationships** — the crawler tries to extract these, but for high-value schemes you'll want to enter them manually via the admin scheme-management UI.
5. **Lighthouse + Performance.** Run Lighthouse on the live URL; target ≥ 80 mobile (Req 19.3). The frontend is configured for it; bottlenecks at this point are usually deployment-region latency or image weight.
6. **Compliance review** — a platform claiming to surface "official government schemes" should have legal sign-off on the data-handling, the "verified" badge, and the user data deletion flow (Req 3.6, 16.7) before public launch.

---

## Phase 5 — Day-2 ops

### Scheduler
The daily crawl + deadline scan run inside the `bharat-backend` process by default. **Do not scale to >1 replica** without first setting `DISABLE_SCHEDULER=true` on all but one host — otherwise the crons fire N times per period.

### Migrations
New migrations ship automatically: `bharat-backend-migrate` runs before the web service rolls. If a migration fails, the deploy is rolled back and the old version keeps serving.

### Observability
- AI tracing: every assistant query has a `traceId` in `assistant_query_logs`. Look it up to see retrieved chunks, latency, helpful/unhelpful rating (Req 21).
- Audit log: `audit_logs` is partitioned by month (`20260615001000_partition_audit_logs`). 365-day retention is enforced by Postgres partition rotation; add a monthly drop job before you accumulate 12 months.
- `/admin/observability/*` routes expose RAG precision/recall + weekly eval results.

### Rotating secrets
- `JWT_SECRET` / `NEXTAUTH_SECRET` — rotate together. Existing sessions are invalidated.
- `PROFILE_ENCRYPTION_KEY` — **do not rotate** without a re-encrypt migration; existing profile data is encrypted with the current key.

### Cost guardrails
- Pinecone bills per vector + per query. The `clean-old-schemes` script removes orphaned vectors; run it after big crawl prunes.
- Gemini bills per token. The assistant caps responses at 500 words (Req 6.8) and retains 5-exchange context (Req 6.6), keeping per-request cost bounded.
- Resend free tier is 3k/mo. Above that, ~$0.001 per email.

---

## Troubleshooting

**`/readyz` returns 503 with `pinecone: error`**
The index dimension probably doesn't match `GEMINI_EMBEDDING_MODEL`. `text-embedding-004` → 768. Recreate the index with the correct dimension; this is not safely reconfigurable in place.

**Frontend gets `CORS error` calling backend**
`FRONTEND_URL` on the backend doesn't match the Vercel domain exactly (including https://). Update in Render and redeploy.

**`Daily scheduler started` logged twice across replicas**
You scaled beyond 1 replica without setting `DISABLE_SCHEDULER=true`. Fix the env var on the extra replicas immediately or your crons will double-fire.

**Prisma migrate fails: "extension vector does not exist"**
The DB was created without `pgvector`. Connect via psql, run `CREATE EXTENSION vector;`, re-run the migrate job.

**Resend: "Domain not verified"**
DNS records (DKIM, SPF, DMARC) haven't propagated yet. Wait an hour, re-check verification in the Resend dashboard.
