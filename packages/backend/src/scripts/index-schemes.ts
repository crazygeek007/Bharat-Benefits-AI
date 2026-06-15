/**
 * Indexes all verified schemes into Pinecone for semantic search.
 *
 * Uses Gemini embeddings (768-dim, truncated from 3072) directly
 * with the Pinecone SDK, bypassing the full scheme-indexer service
 * to avoid the Prisma schemeEmbedding table dependency.
 *
 * Run with: npx tsx src/scripts/index-schemes.ts
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import { getPineconeClient } from '../lib/vectordb';
import { createGeminiEmbeddingsClient } from '../lib/gemini';
import { chunkText } from '../services/crawler/embeddings';
import { buildSchemeText, type IndexableScheme } from '../services/crawler/scheme-indexer';

async function main() {
  console.log('Loading verified schemes from database...\n');

  const schemes = await prisma.scheme.findMany({
    where: { verified: true },
  });

  console.log(`Found ${schemes.length} verified schemes to index.\n`);

  if (schemes.length === 0) {
    console.log('No schemes to index. Run seed-schemes.ts first.');
    return;
  }

  // Connect to Pinecone
  const pinecone = getPineconeClient();
  const indexName = process.env.PINECONE_INDEX_NAME || 'bharat-benefits-schemes';
  const index = pinecone.index(indexName);

  // Gemini embeddings client
  const embeddingsClient = createGeminiEmbeddingsClient();

  let indexed = 0;
  let failed = 0;

  for (const scheme of schemes) {
    try {
      process.stdout.write(`  Indexing: ${scheme.name.slice(0, 55)}...`);

      // Build text from scheme
      const schemeData: IndexableScheme = {
        name: scheme.name,
        description: scheme.description,
        ministry: scheme.ministry,
        state: scheme.state,
        category: scheme.category,
        sourceUrl: scheme.sourceUrl,
        eligibilityCriteria: scheme.eligibilityCriteria as any,
        benefits: [],
        applicationSteps: scheme.applicationSteps as any,
      };

      const text = buildSchemeText(schemeData);
      const chunks = chunkText(text);

      if (chunks.length === 0) {
        console.log(' ⊘ (no text to index)');
        continue;
      }

      // Generate embeddings and upsert to Pinecone
      const records: Array<{
        id: string;
        values: number[];
        metadata: Record<string, unknown>;
      }> = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const result = await embeddingsClient.embeddings.create({
          model: 'gemini-embedding-001',
          input: chunk,
        });
        const embedding = result.data[0].embedding;

        records.push({
          id: `${scheme.id}-${i}`,
          values: embedding,
          metadata: {
            schemeId: scheme.id,
            chunkIndex: i,
            chunkText: chunk.slice(0, 500), // Pinecone metadata limit
            schemeName: scheme.name,
            category: scheme.category,
          },
        });
      }

      // Upsert to Pinecone (v7 SDK expects { records: [...] })
      console.log(` [${records.length} records, dim=${records[0]?.values?.length}]`);
      await index.upsert({ records });
      console.log(`   ✓ done`);
      indexed++;

      // Rate limit — 1.5s between schemes for Gemini free tier
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log(` ✗ ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`\nDone. Indexed ${indexed}, failed ${failed}.`);
}

main()
  .catch((err) => {
    console.error('Index failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
