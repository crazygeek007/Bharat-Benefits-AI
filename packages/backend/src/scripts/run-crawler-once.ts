/**
 * One-shot daily crawl driver.
 *
 * Designed for the GitHub Actions schedule (`.github/workflows/crawler.yml`)
 * that runs the same crawl pipeline as the in-process Render scheduler
 * but from GitHub-hosted runners. Render's datacenter IP gets 403'd by
 * Cloudflare-protected gov portals; GitHub's runners use a different IP
 * range that the same portals serve normally — see the production logs
 * from June 25 and the local-vs-Render curl experiment for the
 * diagnosis.
 *
 * Reuses the existing crawler infrastructure verbatim:
 *   - `runDailyCrawl()` from `workers/daily-crawl.worker` —
 *     same code path, same env-flag gates, same logs.
 *   - `buildProductionCrawlerAdapters()` for Prisma / Pinecone wiring.
 *   - `ChangeDetectorService` + `createChangeDetectorAdapter` for
 *     scheme-change detection and citizen notifications.
 *
 * Connects to the production Postgres + Pinecone via env vars supplied
 * by the GitHub Actions workflow (DATABASE_URL, PINECONE_*, GEMINI_*).
 * Exits with a non-zero code on failure so the workflow reports red.
 *
 * Run locally for testing:
 *   DATABASE_URL=... PINECONE_API_KEY=... GEMINI_API_KEY=... \
 *     npx tsx src/scripts/run-crawler-once.ts
 */

import 'dotenv/config';

import prisma from '../lib/prisma';
import { runDailyCrawl } from '../workers/daily-crawl.worker';
import { ChangeDetectorService } from '../services/change-detector/change-detector';
import { createChangeDetectorAdapter } from '../services/crawler/crawler-pipeline-integration';
import { buildProductionCrawlerAdapters } from '../services/crawler/prisma-adapters';
import { createSchemeIndexer } from '../services/crawler/scheme-indexer';

async function main(): Promise<void> {
  // The change detector handles scheme-version history and citizen
  // notifications when fields like benefits / deadlines drift between
  // crawls. We construct it without a NotificationService for now —
  // the in-app notifications path remains the responsibility of the
  // Render-hosted backend; the crawler just records change history.
  const changeDetectorService = new ChangeDetectorService({
    prisma: prisma as unknown as ConstructorParameters<
      typeof ChangeDetectorService
    >[0]['prisma'],
  });

  const schemeIndexer = createSchemeIndexer();
  const adapters = buildProductionCrawlerAdapters({
    prisma: prisma as unknown as Parameters<
      typeof buildProductionCrawlerAdapters
    >[0]['prisma'],
    schemeIndexer,
  });

  const changeDetector = createChangeDetectorAdapter({ changeDetectorService });

  console.log('[crawler] starting one-shot daily crawl');
  const result = await runDailyCrawl({
    persistence: adapters.persistence,
    vectorIndexer: adapters.vectorIndexer,
    searchIndexer: adapters.searchIndexer,
    compatibilityStore: adapters.compatibilityStore,
    changeDetector,
  });

  console.log(
    `[crawler] complete: ` +
      `${result.newSchemes} new, ` +
      `${result.updatedSchemes} updated, ` +
      `${result.failedSources.length} failed sources, ` +
      `${result.duration}ms.`,
  );
  if (result.failedSources.length > 0) {
    // Surface the top 10 failures so the workflow log shows actionable
    // detail — full list lives in the structured pino output above.
    console.log('[crawler] sample failed sources:');
    for (const failed of result.failedSources.slice(0, 10)) {
      console.log(`  - ${failed.url}: ${failed.reason}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('[crawler] one-shot crawl failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Close the Prisma pool before exit so the underlying TCP sockets
    // are released cleanly. Without this, Postgres logs idle-in-tx
    // warnings.
    await prisma.$disconnect();
    // Pino's stdout sink is configured synchronously in the worker,
    // but the runtime can still buffer the final line in Node's
    // stream layer. Drain stdout/stderr before exiting so the
    // GitHub Actions log captures the completion summary that
    // followed the last sitemap-discovery log.
    await drainStream(process.stdout);
    await drainStream(process.stderr);
    process.exit(process.exitCode ?? 0);
  });

function drainStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.writableLength === 0) {
      resolve();
      return;
    }
    stream.write('', () => resolve());
  });
}
