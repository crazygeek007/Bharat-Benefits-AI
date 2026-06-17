# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the Bharat Benefits AI backend (Fastify API
# + in-process daily scheduler). Builds the shared package first because
# both backend and frontend depend on its compiled .d.ts output.
#
# Build context MUST be the repo root, not packages/backend, because we
# need to copy the shared package alongside.
#   docker build -f packages/backend/Dockerfile -t bharat-backend .

# ─── 1. Builder ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install build tooling needed by some native deps (bcryptjs is pure JS
# but ioredis / pg pull in optional native modules on some platforms).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy the workspace manifests first so the install layer caches when
# only application code changes.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/

# IGNORE_SCRIPTS=1 so postinstall (prisma generate) doesn't run before
# the prisma schema is copied. We run generate explicitly below.
RUN npm ci --ignore-scripts

# Copy sources and build shared first, then backend.
COPY packages/shared packages/shared
COPY packages/backend packages/backend

RUN npm run build --workspace=packages/shared
RUN cd packages/backend && npx prisma generate
RUN cd packages/backend && npx tsc

# ─── 2. Runtime ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL is needed by the Prisma engine at runtime. ca-certificates is
# required for outbound HTTPS to Pinecone / Resend / Elastic Cloud.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 app \
  && useradd  --uid 10001 --gid app --shell /sbin/nologin --create-home app

# Reuse the install layer from the builder rather than re-running
# `npm ci` — copying node_modules is faster and ensures the same lockfile
# resolution. We strip dev deps with `npm prune` to keep the image small.
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/backend/package.json packages/backend/
COPY --from=builder /app/packages/frontend/package.json packages/frontend/
COPY --from=builder /app/node_modules node_modules

# Copy built artifacts (shared dist + backend dist + generated Prisma client + migrations).
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/backend/dist packages/backend/dist
COPY --from=builder /app/packages/backend/src/generated packages/backend/src/generated
COPY --from=builder /app/packages/backend/prisma packages/backend/prisma

# Re-run install with --omit=dev so devDependencies (tsx, prisma, etc.)
# are pruned. The Prisma CLI for migrate deploy is intentionally kept by
# adding it as a runtime tool via npx (see CMD below) — for that path
# you'd add `prisma` to dependencies, not devDependencies. To keep the
# image lean we rely on `prisma migrate deploy` being run from CI / a
# release job, not at container start.
RUN npm prune --omit=dev --workspaces && npm cache clean --force

USER app
EXPOSE 4000

# dumb-init reaps zombies + forwards SIGTERM correctly so graceful
# shutdown in index.ts actually receives the signal.
ENTRYPOINT ["dumb-init", "--"]

# The server binds to 0.0.0.0:$PORT (defaulted in index.ts). Render /
# Fly / Railway all set PORT for us; locally `docker run -p 4000:4000`
# works without overrides.
CMD ["node", "packages/backend/dist/index.js"]
