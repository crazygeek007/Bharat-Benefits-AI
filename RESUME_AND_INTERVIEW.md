# Bharat Benefits AI — Resume Brief & Interview Prep

A condensed, recruiter-ready overview of what this project is, what was built, the technical decisions worth talking about, and 30 interview questions you should be ready to answer.

> Keep this file at the repo root so it's easy to point hiring managers at: `https://github.com/crazygeek007/Bharat-Benefits-AI/blob/main/RESUME_AND_INTERVIEW.md`

---

## 1. One-paragraph elevator pitch

Bharat Benefits AI is an AI-powered platform that helps Indian citizens discover and apply for the central and state government welfare schemes they're actually eligible for. It combines a citizen profile, a multi-agent RAG pipeline backed by Google Gemini + Pinecone, a vector + full-text hybrid search layer, and a daily crawler that ingests scheme data from official `gov.in` / `nic.in` portals. The codebase is a TypeScript monorepo (Next.js frontend, Fastify backend, shared types package) deployed across Vercel and Render, with a GitHub Actions runner driving the scheduled crawler to dodge IP-block issues on the gov portals. The whole feature set was built spec-first with formal correctness properties; the test suite carries 1,500+ Vitest assertions including property-based tests written with `fast-check`.

---

## 2. Problem & solution

**Problem.** India publishes thousands of welfare schemes across hundreds of central / state portals, but citizens lose an estimated ₹2L crore/year in benefits they qualify for and never claim. The information is scattered, unsearchable, multilingual, and the official portals are SPAs / 403-protected / regionally inconsistent.

**Solution.** A single-pane interface where a citizen fills in their profile once, and the system:

1. Runs structured eligibility against every scheme.
2. Recommends the highest-value matches first (state-prioritised, ranked, de-conflicted).
3. Explains each match in plain language via an AI assistant with citations to the official source.
4. Tracks deadlines and notifies the user when relevant schemes change, reopen, or expire.
5. Detects compatibility (which schemes can be combined, which exclude each other) so citizens don't lose benefits by stacking wrongly.

---

## 3. Architecture overview

```
┌──────────────┐    ┌────────────────────────────────────────────────────────┐
│   Browser    │ →  │ Next.js 14 (Vercel) — App Router, NextAuth, RSC        │
└──────────────┘    └────────────────────┬───────────────────────────────────┘
                                         │ REST / JSON
                                         ▼
                    ┌────────────────────────────────────────────────────────┐
                    │ Fastify backend (Render)                               │
                    │  ├─ Auth (JWT) + bcrypt + lockout                      │
                    │  ├─ Profile encryption (AES-256-GCM)                   │
                    │  ├─ Routes: profile / schemes / dashboard / assistant  │
                    │  │           notifications / admin / observability     │
                    │  ├─ Eligibility / Recommendation / Compatibility       │
                    │  ├─ Multi-agent pipeline (planner → retrieval → resp)  │
                    │  └─ AI observability (helpfulness monitor + feedback)  │
                    └─────┬──────────────┬──────────────┬───────────┬────────┘
                          │              │              │           │
                          ▼              ▼              ▼           ▼
                   ┌──────────┐   ┌────────────┐   ┌─────────┐ ┌────────┐
                   │ Postgres │   │ Pinecone   │   │ Elastic │ │ Redis  │
                   │ (Prisma) │   │ (vectors)  │   │  search │ │ (cache)│
                   │ +pgvector│   │            │   │ (BM25)  │ │        │
                   └──────────┘   └────────────┘   └─────────┘ └────────┘
                          ▲              ▲              ▲
                          │              │              │
                    ┌─────┴──────────────┴──────────────┴─────────────┐
                    │ Daily crawler (GitHub Actions, 21:30 UTC)       │
                    │  ├─ Sitemap discovery                           │
                    │  ├─ Link-graph discovery (Cheerio)              │
                    │  ├─ URL pattern + HTML signal classifier        │
                    │  ├─ Portal-aware extractors (myscheme, india.gov│
                    │  │   .in, scholarships.gov.in, services, igod)  │
                    │  ├─ Polite HTTP fetcher (robots.txt, 1.5s/host) │
                    │  ├─ Mandatory-field enforcement                 │
                    │  └─ Change detection + admin notification       │
                    └─────────────────────────────────────────────────┘
                                          ▲
                                          │
                                Google Gemini (embeddings + generation)
```

Two deployment surfaces:
- **Vercel** hosts the Next.js frontend.
- **Render** hosts the Fastify backend + Postgres + Redis. A separate Render job runs Prisma migrations on deploy.
- **GitHub Actions** runs the scheduled crawler. Moved off Render because Cloudflare-protected gov portals 403 Render's datacenter IPs but serve GitHub-hosted runners normally.

---

## 4. Tech stack (precise)

**Languages.** TypeScript (strict mode), SQL, a small amount of Bash/PowerShell for tooling.

**Frontend.** Next.js 14 (App Router + RSC), React 18, NextAuth, i18n for 6 Indian languages (English, Hindi, Bengali, Tamil, Telugu, Marathi), WCAG-compliant components, keyboard-navigation primitives, accessibility-compliance tests.

**Backend.** Fastify 4 (with `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`), Prisma 7 ORM, Zod for runtime validation, JWT + bcrypt for auth, AES-256-GCM for at-rest PII encryption, pino for structured JSON logs, node-cron for in-process scheduling.

**Datastores.** Postgres 16 with `pgvector` for embedding columns and `tsvector` full-text search; Elasticsearch 9 for BM25 ranking; Pinecone for production semantic search; Redis (ioredis) for query / response caching.

**AI / ML.** Google Gemini for embeddings and response generation, OpenAI SDK kept as a fallback embedding source, custom multi-agent pipeline (planner → eligibility → retrieval → compatibility → recommendation → response), feedback loop with helpfulness monitor and evaluation-run storage.

**Crawler.** Cheerio for HTML parsing, fast-xml-parser for sitemaps, a hand-rolled polite HTTP fetcher (robots.txt, per-host rate limiting, browser-mimicking headers), in-memory crawl frontier with per-host budget and depth limit, URL-pattern + HTML-signal classifier, portal-aware enrichers for the five major gov portals.

**Testing.** Vitest, fast-check (property-based testing), jsdom for component tests, 1,518 tests across 101 files at last count. Property tests cover eligibility, recommendation invariants, ingestion completeness, trust score monotonicity, source validation, profile encryption, etc.

**DevOps.** GitHub Actions for CI (lint + tests) and scheduled crawler runs; Render Blueprint (`render.yaml`) for backend + migration job deployment; Vercel git-driven deploys for frontend; Prisma migrations applied automatically on each deploy.

---

## 5. Key features built (with technical notes)

Grouped by surface area so you can speak to whichever one comes up.

### 5.1 Citizen-facing
- **Profile + onboarding.** Encrypted demographic + financial profile. AES-256-GCM at-rest encryption on PII fields. Server-side validation via Zod, runtime constraint checks (age 0–150, income bounds, enum values), audit logging on every mutation.
- **Multilingual UI.** Six languages with server-detected and cookie-overridable locale. Translation pipeline preserves named entities (scheme names, ministry names) without translating them.
- **Benefits dashboard.** Eligible / Applied / Saved / Expired groupings. Estimates total monetary benefit value across the catalogue. Has a `missedBenefitsSummary` block highlighting schemes the citizen qualifies for but hasn't saved.
- **Scheme browser + filter + comparison.** Filter by category, ministry, state. Compare up to 3 schemes side-by-side with attribute-level diffs.
- **AI assistant.** Streams Gemini-generated answers with citations linking back to the official scheme source URL. Inline 👍/👎 feedback widget posts to `/api/assistant/feedback`.
- **Voice assistant.** STT integration accepting the same six languages for query input.
- **Notifications.** In-app + email channel, retry-with-backoff delivery, status tracking (pending → sent → delivered → failed).
- **Deadline tracker.** 30-min cron scans upcoming deadlines and queues notifications at the 7-day / 24-hour / 6-hour thresholds.

### 5.2 AI pipeline
- **RAG retrieval.** Hybrid Pinecone (vector) + Elasticsearch (BM25) lookup. Vector retriever returns top-k similar chunks; FTS retriever returns top-k lexical matches; results merged with reciprocal-rank fusion.
- **Multi-agent orchestration.** A planner agent classifies the query (eligibility, recommendation, information, comparison), then routes to the relevant downstream agents. Skipped agents are recorded so the trace explains why an output is missing.
- **Compatibility extraction.** Parses scheme descriptions for "can be combined with X", "cannot be combined with Y", "prerequisite: Z" phrases and stores typed `SchemeRelationship` rows. Surfaces in the dashboard as compatibility warnings.
- **AI observability.** Every assistant query is logged with trace ID, retrieval recall, latency, response length. Citizen 👍/👎 feedback is stored against the trace. A `HelpfulnessMonitor` aggregates feedback over a rolling window and alerts when the helpfulness rate drops.

### 5.3 Crawler / ingestion
- **Scheduled daily crawl.** Runs from GitHub Actions at 21:30 UTC. Pulls from five seed portals (myscheme, india.gov.in, services.india.gov.in, scholarships.gov.in, igod.gov.in).
- **Sitemap discovery.** Recursive XML walker handling both `urlset` and `sitemapindex` shapes, per-host URL cap, depth limit.
- **Link-graph discovery.** Cheerio-based HTML link extractor + in-memory crawl frontier with per-host page budget (500), depth limit (3), and dedup via canonical URL.
- **Polite HTTP fetcher.** 1.5s minimum between requests to the same host, robots.txt parsed and respected, identifying browser-mimicking UA + Accept-Language headers, 30s timeout per request.
- **Page classifier.** Two-stage: URL pattern rules (per-portal + portal-agnostic) get cheap verdicts without fetching; HTML-signal classifier fills in the unknowns by counting scheme keywords and link density. Verdicts are `scheme` / `listing` / `ministry` / `ignore` / `unknown`.
- **Portal-aware extractors.** Each major portal (myscheme, india.gov.in, services.india.gov.in, scholarships.gov.in, igod.gov.in) has selectors tuned to its rendered HTML. The generic heading-driven parser is the safety net for the long tail of ministry sites.
- **Mandatory-field enforcement.** Required: name, description, sourceUrl. Optional: ministry (falls back to "Unknown Ministry"), eligibility / benefits (default to `[]`), application process, documents, deadline. Partial schemes flow into admin review rather than being silently dropped.
- **Per-portal completion stats.** Each crawl logs an aggregated `perPortal` block — `attempted` / `failed` / `successful` per hostname plus the top-3 most common failure reasons (`http-403`, `fetch-failed`, `mandatory-fields-missing`).
- **Change detection.** Diffs each upsert against the previously stored version, persists `SchemeChange` rows, and triggers citizen notifications when material fields drift (benefits, deadlines, eligibility).
- **Trust score.** Per-portal weight × signal score, monotone in evidence. Property-tested so adding evidence never decreases the score.

### 5.4 Admin / operations
- **Admin dashboard.** Scheme flag review (auto-flagged on parse failure / low trust / change detected), analytics, scheme management overrides.
- **Audit log.** Append-only, partitioned monthly, captures every state-changing API call with actor identity and resource info.
- **Observability routes.** `/api/admin/observability/*` surfaces aggregate AI quality stats, slow-query lists, and recent feedback.
- **Health checks.** `/healthz` for liveness, `/readyz` checks DB + Pinecone + Redis + Elasticsearch readiness before reporting ready.

---

## 6. Engineering decisions worth talking about

Pick three of these for the interview, depending on which direction the conversation goes. Each is grounded in actual code, not hand-wave.

### 6.1 Spec-driven development with executable correctness properties
Every feature was built spec-first: `requirements.md` → `design.md` → `tasks.md`. The tasks document includes correctness properties expressed as property-based tests (fast-check), e.g. "for any profile and any monotonic edit, recommendation order is stable" or "trust score is non-decreasing in evidence". This catches bugs that example-based tests would miss — the eligibility engine alone has 8 property tests covering edge cases the unit tests never hit.

### 6.2 Hybrid retrieval (Pinecone vector + Elasticsearch BM25)
Pure vector search retrieves semantically related schemes but misses exact phrase matches (e.g. citizen typing the scheme's literal name); pure BM25 misses paraphrases. The retrieval layer runs both, combines the rankings with reciprocal-rank fusion, and dedupes by scheme ID. Tested with explicit "vector-only would miss this" and "BM25-only would miss this" fixtures.

### 6.3 Property-based testing for the recommendation engine
Recommendation has subtle invariants — adding eligibility to a profile must not remove previously eligible schemes, sort order is deterministic, deadline-soon beats deadline-far when other factors equal, state schemes are prioritised over central ones, etc. Each is encoded as a `fast-check` property over generated profiles + scheme sets, so a wide input space is sampled per run. Catches regressions during refactors.

### 6.4 Cloudflare-IP-block discovery and workaround
Render deployed cleanly but every gov-portal crawl returned 403. Diagnosed via local-vs-Render `curl` comparison — same UA, same request, succeeded locally and failed from Render. Concluded it was IP reputation, not headers or fingerprinting. Moved the daily crawler from Render's in-process scheduler to GitHub-hosted Actions runners (different IP range), keeping the rest of the backend unchanged. Documented the trade-off in `DEPLOY.md`.

### 6.5 Event-loop bug in the rate-limiter
Crawler runs were exiting cleanly with status 0 but no completion logs. Traced via injected `setInterval` heartbeats + `beforeExit` hook. Root cause: the polite-fetcher's per-host sleep was `setTimeout(...).unref()`'d. When the discovery loop awaited the rate-limit delay with no fetch in flight, Node's event loop saw zero pending work, fired `beforeExit`, and exited — leaving the awaiting Promise pending forever and `main()` orphaned. One-line fix (remove `.unref()`) plus an annotated comment explaining why unref'ing rate-limit timers is wrong.

### 6.6 Lazy-binding pattern for route auth
Three different route modules (eligibility, dashboard, profile) were registering `app.authenticate` at registration time, before the `fastify-plugin`-decorated auth was visible. Result: the route had no preHandler and the handler short-circuited with 401. Fixed by capturing the decorator lookup lazily inside the preHandler closure instead of at module import. Added the pattern to all routes that depend on a decorator.

### 6.7 Synchronous pino destination for batch scripts
Pino writes through sonic-boom which buffers asynchronously. Fine for long-lived Fastify, broken for one-shot crawler scripts — buffered final logs got dropped before the process exited. Switched the worker's logger to `pino.destination({ sync: true })` and added an explicit stream drain before `process.exit()` in the runner. Trade-off documented: a few hundred microseconds per log, irrelevant for batch.

### 6.8 Portal-aware extraction without monolithic if/else
The generic HTML parser handles the long tail of ministry sites; per-portal extractors live in a separate `portal-extractors.ts` behind a `PortalExtractor` interface. Each portal implements `matches(url)` and `enrich($, generic, url)`. The router does first-match-wins. Each enricher is pure (no I/O, no logging, never throws) so a bad selector degrades gracefully rather than failing the crawl.

---

## 7. Resume bullet lines (copy-paste ready)

Three versions tuned to different role focuses. Pick the one closest to the job you're applying to and tweak the verbs.

### 7.1 Full-stack engineer
**Bharat Benefits AI** — AI-powered welfare-scheme discovery platform for Indian citizens
- Architected and shipped a TypeScript monorepo (Next.js 14, Fastify, Prisma, shared types) deployed across Vercel + Render with a separate GitHub Actions scheduled crawler.
- Built a multi-agent RAG pipeline on Google Gemini with hybrid Pinecone vector + Elasticsearch BM25 retrieval; the planner agent selectively routes queries through eligibility, retrieval, compatibility, and recommendation agents.
- Implemented eligibility, recommendation, and scheme-compatibility engines with formal correctness properties; 1,500+ Vitest assertions including `fast-check` property-based tests covering ordering invariants, trust-score monotonicity, and ingestion completeness.
- Designed a daily crawler (5 portal seeds, sitemap + link-graph discovery, polite HTTP fetcher honouring robots.txt and 1.5s/host rate limit, portal-aware extractors with generic-parser fallback) running from GitHub Actions to dodge Cloudflare IP blocks on Render.
- Delivered a multilingual frontend in 6 Indian languages with WCAG-compliant components, keyboard navigation, and a citizen-facing AI assistant with inline feedback that feeds back into a helpfulness monitor.

### 7.2 Backend / distributed systems focus
**Bharat Benefits AI** — Backend + data ingestion for an AI welfare-scheme platform
- Wrote a Fastify backend with JWT auth, AES-256-GCM PII encryption at rest, partitioned audit log, rate-limited routes, and helmet-hardened headers; 30+ routes covering profile, schemes, dashboard, assistant, admin, and observability.
- Designed a hybrid retrieval layer combining Pinecone (vector) with Elasticsearch (BM25) via reciprocal-rank fusion, plus a Redis cache layer for hot queries; deployed Postgres 16 with `pgvector` extension and FTS `tsvector` columns.
- Built a multi-agent orchestration pipeline (planner / eligibility / retrieval / compatibility / recommendation / response) with structured tracing — every assistant query is captured with trace ID, retrieval recall, latency, and feedback signals.
- Implemented a production crawler with two-stage URL classification, per-portal HTML extractors, change detection with citizen notifications, and per-host structured logging for failure attribution.
- Diagnosed and fixed an event-loop hang in the rate-limiter (orphaned `setTimeout.unref()` causing `beforeExit` mid-await) using injected heartbeat instrumentation; documented the root cause inline.

### 7.3 AI / ML engineer focus
**Bharat Benefits AI** — Multi-agent RAG over Indian welfare schemes
- Designed and shipped a multi-agent pipeline (planner → eligibility → retrieval → compatibility → recommendation → response) over Google Gemini for embeddings and generation, serving citizen queries about scheme eligibility and benefits.
- Built hybrid retrieval (Pinecone vector + Elasticsearch BM25 + reciprocal-rank fusion) with citation tracking; every response carries source URLs back to the official scheme pages.
- Implemented an AI observability layer: every query logged with trace ID, retrieval recall, latency, and 👍/👎 citizen feedback; a `HelpfulnessMonitor` aggregates feedback over a rolling window and surfaces quality drops.
- Wrote a compatibility extractor that parses scheme descriptions for combinable / incompatible / prerequisite relationships and stores typed `SchemeRelationship` rows used by the recommendation engine.
- Property-tested the recommendation engine for ordering invariants, monotonicity under profile edits, and exclusion correctness using `fast-check`.

---

## 8. Skills inventory (for the bottom of your resume + ATS)

### Languages
TypeScript, JavaScript, SQL, Bash, PowerShell

### Frontend
Next.js 14, React 18, RSC, NextAuth, TypeScript strict mode, i18n, WCAG-compliant a11y, keyboard navigation, vitest + jsdom component tests

### Backend
Fastify 4, Node.js 20, Prisma 7 ORM, Zod runtime validation, JWT auth, bcrypt password hashing, AES-256-GCM, helmet, CORS, rate limiting, node-cron, pino structured logging

### Databases & search
Postgres 16, pgvector, FTS `tsvector`, Elasticsearch 9 (BM25), Pinecone (vector DB), Redis (ioredis), reciprocal-rank fusion

### AI / ML
Google Gemini (embeddings + generation), OpenAI SDK, RAG, multi-agent orchestration, hybrid retrieval, embedding chunking, helpfulness monitoring, evaluation runs

### Web scraping / ingestion
Cheerio, fast-xml-parser, custom crawl frontier, robots.txt parser, polite HTTP fetcher, page classifier (URL + HTML signals), portal-aware extractors

### Testing
Vitest, fast-check (property-based testing), jsdom, supertest-style route tests, ~1,500 assertions, ~100 test files

### DevOps & infra
Render (Blueprint deployment), Vercel, GitHub Actions (CI + scheduled jobs), Prisma migrations, Docker, Postgres + Redis + Elasticsearch ops

### Concepts
RAG, multi-agent pipelines, hybrid search, property-based testing, spec-driven development, WCAG accessibility, i18n, encryption at rest, audit logging, idempotent ingestion, change detection, robots.txt compliance

---

## 9. 30 interview questions with answers

Grouped by topic. Read the answers in your own voice before the interview — don't memorise; just understand the shape of each answer so you can adapt to follow-ups.

### System design (Q1–Q6)

**Q1. Walk me through the architecture.**
Frontend is Next.js 14 on Vercel, talks REST/JSON to a Fastify backend on Render. The backend hits four data stores: Postgres for the canonical catalogue + user data (with pgvector for embeddings and tsvector for FTS), Pinecone for production vector search, Elasticsearch for BM25 ranking, and Redis for query / response caching. AI calls go to Google Gemini for embeddings and generation. A separate GitHub Actions workflow runs the daily crawler so the gov portals see GitHub IPs (which they serve) instead of Render IPs (which they 403). The whole system is a TypeScript monorepo with a shared types package, so the SchemeObject contract is identical end-to-end.

**Q2. Why did you split the crawler off to GitHub Actions instead of running it on Render?**
The crawler hits Cloudflare-protected government portals. Render's datacenter IP range was 403'd on every request; the same `curl` succeeded from my laptop and from GitHub-hosted runners. I diagnosed it as IP reputation, not headers or fingerprinting — same UA, same TLS settings, different outcome based on source IP. Moving the crawler off Render kept the live API on Render (where it needs to be for low-latency citizen traffic) and routed the ingestion through an IP range the portals accept. The trade-off is documented in `DEPLOY.md`.

**Q3. How would you scale this to 10× users?**
The Fastify backend is stateless, so horizontal scaling is mostly a config change in Render. The bottleneck would be Postgres write contention on the audit log and saved-scheme writes; both are already partitioned (audit log by month) or low-volume. Read traffic is cached in Redis for hot queries. AI calls are the expensive part — I'd add an embedding cache (deterministic over query string) and a response cache keyed by `(query, profile-hash)` to short-circuit repeat questions. Long-term, the multi-agent pipeline is naturally parallelisable across agents that don't depend on each other (retrieval can run in parallel with eligibility), and I'd move it to a queue-based fan-out so a slow agent doesn't block the response.

**Q4. How does the user data stay private?**
PII fields on the profile (name, exact income, dependents detail) are AES-256-GCM encrypted at rest. The encryption key is held outside the database. Every state-changing API call writes to a partitioned audit log with the actor's identity. Auth is JWT with a short TTL and account lockout after 5 consecutive failures. We never log raw PII — the structured logger emits the user ID and field names, not values. Sessions time out at 30 minutes of inactivity. The schema constraint is enforced both in Postgres (CHECK constraints on enum values, NOT NULL on required fields) and in Zod at the API boundary.

**Q5. What's your retrieval strategy and why?**
Hybrid Pinecone (vector) + Elasticsearch (BM25), merged via reciprocal-rank fusion, capped at the top-k after dedup. Vector alone misses exact phrase queries — when a citizen types "PMJJBY" we want the literal hit, not a similar-sounding scheme. BM25 alone misses paraphrases — "death insurance for poor families" should still find PMJJBY. RRF is dead simple to implement, doesn't need score-normalisation across the two indices, and we can tune the rank-cutoff per index independently. Tested with explicit fixtures showing both failure modes the hybrid catches.

**Q6. Tell me about the change-detection pipeline.**
Every successful crawl upsert is compared against the previous version of the scheme in Postgres. If material fields (benefits, deadline, eligibility criteria) drift, a `SchemeChange` row is written with the diff, and citizens who have saved that scheme get an in-app + email notification. Version numbers monotonically increase. Minor fields (description wording, last-verified timestamp) don't trigger notifications. The whole thing is idempotent: re-running the crawler against an unchanged source URL produces no change-detection rows, no notifications, no version bump.

---

### AI / ML (Q7–Q12)

**Q7. Walk through a query end-to-end through the multi-agent pipeline.**
A citizen asks "Am I eligible for PM-KISAN?" The planner agent classifies it as an `eligibility` query and decides we need the eligibility agent + retrieval agent + response agent (compatibility and recommendation skipped). Retrieval pulls scheme chunks from Pinecone + Elasticsearch (RRF-merged) and finds PM-KISAN. Eligibility runs the citizen's profile against PM-KISAN's structured eligibility criteria and returns met / unmet / unevaluated. The response agent composes a plain-language answer with the source URL citation. The full trace (which agents ran, latency per agent, retrieval recall) is logged for observability.

**Q8. How do you measure whether the AI is being helpful?**
Two signals. Explicit: the 👍/👎 widget on every assistant response, posted to `/api/assistant/feedback` and stored against the trace ID. Implicit: the `HelpfulnessMonitor` aggregates feedback over a rolling 24-hour window and computes a helpfulness rate; if it drops below a threshold the system flags it for admin review. Each query also stores a self-reported quality score (citation count, response length, retrieval similarity) so we can correlate low quality with explicit thumbs-down.

**Q9. Why Gemini instead of GPT-4?**
Cost and Indian-language coverage were the two drivers. Gemini has good performance on Hindi / Bengali / Tamil etc. without needing a translation hop, and at the time of integration its pricing for the multilingual workload was roughly half OpenAI's. The codebase isn't locked in — the AI client interface is small enough that swapping providers is a config change, and OpenAI SDK is already included as a fallback for embedding generation.

**Q10. How do you avoid hallucinations in the assistant?**
Three layers. (1) Retrieval-augmented: the response agent only has the retrieved chunks as context, and the prompt instructs it to refuse rather than guess if the chunks don't answer the question. (2) Citation enforcement: every claim about a specific scheme must come with the source URL from the retrieved chunks; responses with zero citations are flagged. (3) The mandatory-field gate in the ingestion pipeline guarantees the assistant never sees a scheme without at least a real name, description, and source URL — so even worst-case it cites a real government page.

**Q11. How would you A/B test a new retrieval ranking strategy?**
The `EvaluationRun` table is already designed for this. Define an eval set (queries + expected scheme IDs), run the current and new ranker against the same set, store recall@k and MRR per run. For online A/B, hash the user ID to a bucket, route some percent of traffic to the new ranker, compare helpfulness rate over a fixed window. The observability layer already tracks per-query latency and feedback, so the A/B comparison is mostly a query, not new instrumentation.

**Q12. What happens when a citizen's question is genuinely out of scope?**
The planner classifies it (e.g. as `information` rather than `eligibility`), retrieval still runs and may return zero chunks above the similarity threshold. The response agent has explicit instructions to say "I don't have information about that" and suggest the user try the scheme browser, rather than hallucinate. The trace records `agentOutputs: { retrieval: { success: false, reason: 'no-chunks-above-threshold' } }` so we can later mine these for content gaps.

---

### Backend / API design (Q13–Q17)

**Q13. Why Fastify over Express?**
Three reasons. (1) Schema-first: Fastify validates request and response bodies via JSON schema or Zod adapters, so route handlers receive typed inputs and we get auto-generated docs. (2) Plugin model: auth, CORS, helmet, rate limit, and decorators register cleanly with explicit ordering, which avoided the middleware-order bugs Express is famous for. (3) Performance: ~2x throughput on benchmark routes, which matters when each citizen request fans out to Postgres + Pinecone + Elasticsearch.

**Q14. How is auth wired?**
NextAuth on the frontend issues a JWT, the backend has a `fastify-plugin`-decorated `app.authenticate` preHandler that verifies the token, attaches the user to `request.user`, and rejects with 401 otherwise. Account lockout kicks in after 5 consecutive failed login attempts and lasts 15 minutes — backed by a Redis counter so it survives backend restarts. Sessions expire after 30 minutes of inactivity, refreshed on each authenticated call.

**Q15. Tell me about a bug you fixed that taught you something.**
Three routes (eligibility, dashboard, profile) were resolving `app.authenticate` at registration time, before the `fastify-plugin`-decorated auth had been attached. Result: the route was registered with `preHandler: undefined`, requests hit the handler directly, the handler tried to read `request.user`, and we 401'd with a confusing error. The fix was to capture the decorator lookup lazily inside a closure inside the preHandler. The lesson: in plugin-based frameworks, anything that looks up framework state must be lazy. I now look for this pattern any time a route 401's unexpectedly.

**Q16. How do you handle errors that span multiple downstream services?**
Each downstream call returns a tagged result, not a raw throw. The orchestrator collects the tagged results and decides per-policy whether one failure aborts the run (rare, e.g. database is down) or whether it's recorded as a `FailedSource` and processing continues (common, e.g. one portal 403's). Notifier delivery is best-effort and explicitly wrapped in try-catch — a Slack-webhook outage must never crash a crawl. Every error has a `errorCode` from a small enum (`INVALID_SOURCE`, `MANDATORY_FIELDS_MISSING`, `PARSE_ERROR`, `TIMEOUT`, `UNKNOWN`) so dashboards can group meaningfully.

**Q17. How does the API stay backwards-compatible as you ship changes?**
The shared types package (`@bharat-benefits/shared`) is the contract. Adding a new optional field to `SchemeObject` is backwards-compatible; renaming or removing requires a versioned route. Routes never break wire format silently — we use Zod for both request validation and response shaping, so a type-level change is caught at compile time. For the catalogue itself, partial schemes (missing optional fields) are allowed end-to-end, so adding a new optional field never breaks existing data.

---

### Frontend / UX (Q18–Q20)

**Q18. How is the multilingual UI built?**
i18n message catalogues per supported language (English, Hindi, Bengali, Tamil, Telugu, Marathi), loaded server-side on the App Router and made available to RSC components. Locale is sticky via a cookie, overridable via the URL. Critical: scheme names and ministry names are tagged as non-translatable so the translation pipeline preserves them verbatim — that property is unit-tested with `fast-check` over random scheme objects.

**Q19. What does WCAG compliance actually look like in code?**
Real focus management, real heading hierarchy, real keyboard navigation primitives — not just ARIA decoration. There's a dedicated `useKeyboardNavigation` hook for list-style components, `headingHierarchy.test.ts` asserts no skipped heading levels, and `accessibility-compliance.test.ts` runs structural checks across the page tree. I'm explicit that automated tests don't equal full WCAG — manual testing with assistive tech is required for real compliance.

**Q20. Why React Server Components?**
Most of the dashboard and scheme detail pages render data that doesn't change per session. RSC lets us fetch + render on the server, ship HTML, and hydrate only the interactive widgets (assistant chat, save buttons, feedback widgets). Faster first paint, smaller JS bundle, and the type-safe data flow from Postgres → server component → client uses the shared types package without crossing a fetch boundary.

---

### Database & data modelling (Q21–Q23)

**Q21. Walk through the schema for schemes.**
Three logical tables. `Scheme` holds the canonical record (name, description, ministry, category, source URL, trust score, verified flag, last verified at). `SchemeVersion` is the append-only history (one row per detected change). `SchemeEmbedding` holds chunked text + 768-dim embeddings with a `pgvector` index for similarity search. Compatibility relationships are a separate join table with a typed `SchemeRelationshipType` enum. Required documents / application steps / eligibility criteria are JSONB columns because they're nested and we read them as a block, never query inside them.

**Q22. Why pgvector AND Pinecone?**
pgvector is "good enough" for development and tests — same query layer, no network hop, no API key. Pinecone is the production target for scale and SLA. The retrieval interface abstracts over both; tests run against pgvector, production runs against Pinecone with a deterministic fallback to pgvector if Pinecone is unreachable. Keeping both pathways alive means we can swap the production target without re-running migrations.

**Q23. How do you handle full-text search?**
Postgres `tsvector` columns with a GIN index. The migration `20260618000000_scheme_fts_tsvector` materialises the search vector via a trigger on insert/update. For production we route real query traffic to Elasticsearch (better BM25 tuning, faster on large catalogues) but `tsvector` stays available for dev and as a graceful-degradation fallback.

---

### DevOps & operations (Q24–Q26)

**Q24. Walk through a deploy.**
Push to `main` → GitHub Actions runs CI (lint + 1,500 tests). On green, Vercel auto-deploys the frontend (Next.js build). Render's blueprint detects the push, runs the `bharat-backend-migrate` job (Prisma migrate deploy), then redeploys `bharat-backend`. Migrations are forward-only and validated locally first via `prisma migrate dev` against a scratch DB. Rollback is "deploy the previous SHA" — the migrations are designed to be tolerant of running against either schema during the cutover.

**Q25. How do you know the system is healthy?**
`/healthz` for liveness, `/readyz` for readiness (checks DB, Pinecone, Redis, Elasticsearch). Pino structured logs ship to Render's log drain with `name: 'crawler'` / `name: 'fastify'` filters. The crawler emits a per-portal completion block every run — `attempted` / `failed` / `successful` per hostname with the top-3 failure reasons compacted into stable tags. The admin observability route surfaces aggregate AI quality stats.

**Q26. What broke in production and how did you fix it?**
The new domain rollout introduced three back-to-back issues. (1) CORS — operator forgot `https://` prefix on `FRONTEND_URL`. Diagnosed from browser console, fixed in Render env. (2) Dashboard empty — recommendation fallback wasn't deployed yet, fixed by committing the fallback. (3) Scheme-detail eligibility 401'd — same lazy-binding bug as Q15, applied the same pattern. Each was diagnosed within minutes because the structured logs and per-route trace IDs made the failure mode obvious.

---

### Testing & quality (Q27–Q28)

**Q27. Tell me about property-based testing in this codebase.**
We use `fast-check` for invariants that should hold across all inputs, not just the ones we thought to write tests for. The recommendation engine has a "monotonicity under profile edits" property — adding a profile field that satisfies a criterion must not remove the scheme from the recommended list. The trust-score scorer has a "monotone in evidence" property — adding evidence never decreases the score. The crawler ingestion has a "completeness" property — every URL in the input list ends up either in `newSchemes`, `updatedSchemes`, or `failedSources`, no silent drops. These caught real bugs example-based tests missed.

**Q28. What's the test pyramid look like?**
Bottom: ~80% are unit tests against pure functions and services (the eligibility engine, the trust scorer, the parsers). Middle: integration tests against routes with an in-memory Fastify instance and mocked downstreams. Top: a handful of end-to-end smoke tests that hit `/healthz`, `/api/profile`, `/api/assistant` against a test backend. Total ~1,500 assertions across ~100 files. We don't have UI E2E (Playwright) yet — that's the next test-layer investment.

---

### Behavioural / project (Q29–Q30)

**Q29. What was the hardest part of this project?**
The crawler IP-block discovery and the related event-loop hang. Both showed up as "succeeded silently with no data" — the worst kind of bug because there's no error to grep for. I instrumented my way out of both: for the IP block, a local-vs-Render `curl` comparison isolated source IP as the variable; for the hang, injected heartbeat instrumentation showed `beforeExit` firing mid-await, which pointed at an orphaned Promise, which pointed at the unref'd timer. The lesson: when a system "works" but produces no output, instrument before you guess.

**Q30. If you had three more weeks, what would you ship next?**
Three things, in priority order. (1) A direct data.gov.in JSON ingester to bootstrap the catalogue while the HTML crawler is still maturing — same Prisma pipeline, just a different source. (2) Playwright E2E smoke tests against the deployed frontend so deploys catch UI regressions automatically. (3) Per-citizen personalisation in the assistant: today the retrieval is the same for everyone; with the profile context fed into the planner agent, "Am I eligible?" can be answered without the citizen explicitly naming a scheme. After that I'd revisit myscheme.gov.in's SPA via their internal JSON API to expand catalogue coverage.

---

## 10. Talking-point cheat sheet

Quick anchors for when an interviewer asks open-ended questions. Use these as conversation starters, then dive into whichever the interviewer cares about.

- "I shipped a multi-agent RAG pipeline over Indian government welfare schemes."
- "Hybrid retrieval — Pinecone vector + Elasticsearch BM25, reciprocal-rank fusion."
- "Spec-driven development with executable correctness properties using fast-check."
- "Diagnosed an IP-reputation block by isolating source-IP as the variable, moved crawler to GitHub Actions."
- "Found a Node event-loop hang via `beforeExit` instrumentation — orphaned `setTimeout.unref()` in a rate limiter."
- "Two-stage page classifier — URL pattern first (cheap, no fetch), HTML signals as fallback."
- "PII at rest with AES-256-GCM, JWT auth, partitioned audit log, account lockout."
- "Multilingual UI in 6 Indian languages with WCAG-compliant components."
- "1,500+ Vitest assertions across ~100 files, property tests covering monotonicity / ordering / completeness invariants."

---

## 11. Honest scope statement

Be straight about what's shipped and what's instrumented but unreleased — interviewers appreciate it and it protects you from "show me the live demo" gotchas.

- **Live in production:** frontend, backend, auth, profile, scheme browser, dashboard, eligibility, recommendation, assistant (RAG), notifications, admin observability, AI feedback widget.
- **Implemented and tested, behind an env flag:** daily crawler (running on GitHub Actions, catalogue ingestion is in active iteration), voice assistant (STT pipeline complete, latency-tuning pending), translation pipeline (6 languages wired, full content translation in progress).
- **Open work:** Playwright E2E suite, headless-browser fallback for SPA portals (myscheme.gov.in), full WCAG manual audit, in-app push notifications, multi-tenant admin org separation.

Owning the open work transparently is a strength signal. Most candidates over-claim; saying "this part is done and tested, this part is shipped and live, this part is open" gives you credibility on everything you do claim.

---

_Last updated: June 27, 2026_
