/**
 * Seeds the database with real Indian government welfare schemes
 * including documents, application steps, and compatibility relationships.
 *
 * Run with: npx tsx src/scripts/seed-schemes.ts
 *
 * Idempotent: safe to re-run; updates existing schemes by sourceUrl.
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import { ALL_SCHEMES, RELATIONSHIPS } from './seed-data';

const SCHEMES = ALL_SCHEMES;

async function seed() {
  console.log(`Seeding ${SCHEMES.length} schemes with documents and application steps...\n`);

  const slugToId = new Map<string, string>();
  let created = 0;
  let updated = 0;

  for (const scheme of SCHEMES) {
    // Some schemes share the same source URL (sub-schemes of the same portal).
    // Use slug as a fragment to make sourceUrl unique per scheme.
    const uniqueSourceUrl = scheme.sourceUrl.includes('#')
      ? scheme.sourceUrl
      : `${scheme.sourceUrl}#${scheme.slug}`;

    const existing = await prisma.scheme.findFirst({
      where: { sourceUrl: uniqueSourceUrl },
    });

    let id: string;

    if (existing) {
      // Update existing
      const result = await prisma.scheme.update({
        where: { id: existing.id },
        data: {
          name: scheme.name,
          description: scheme.description,
          ministry: scheme.ministry,
          state: scheme.state,
          category: scheme.category,
          benefitType: scheme.benefitType,
          benefitAmount: scheme.benefitAmount,
          deadline: scheme.deadline,
          applicationMode: scheme.applicationMode,
          applicationUrl: scheme.applicationUrl,
          eligibilityCriteria: scheme.eligibilityCriteria as any,
          applicationSteps: scheme.applicationSteps as any,
          trustScore: scheme.trustScore,
          verified: scheme.trustScore >= 60,
          lastVerifiedAt: new Date(),
        },
      });
      id = result.id;
      updated++;
      process.stdout.write(`  ↻ Updated: ${scheme.name.slice(0, 60)}\n`);
    } else {
      const result = await prisma.scheme.create({
        data: {
          name: scheme.name,
          description: scheme.description,
          ministry: scheme.ministry,
          state: scheme.state,
          category: scheme.category,
          sourceUrl: uniqueSourceUrl,
          benefitType: scheme.benefitType,
          benefitAmount: scheme.benefitAmount,
          deadline: scheme.deadline,
          applicationMode: scheme.applicationMode,
          applicationUrl: scheme.applicationUrl,
          eligibilityCriteria: scheme.eligibilityCriteria as any,
          applicationSteps: scheme.applicationSteps as any,
          trustScore: scheme.trustScore,
          verified: scheme.trustScore >= 60,
          lastVerifiedAt: new Date(),
        },
      });
      id = result.id;
      created++;
      process.stdout.write(`  ✓ Created: ${scheme.name.slice(0, 60)}\n`);
    }

    slugToId.set(scheme.slug, id);

    // Replace documents (simple full-replace strategy)
    await prisma.schemeDocument.deleteMany({ where: { schemeId: id } });
    if (scheme.documents.length > 0) {
      await prisma.schemeDocument.createMany({
        data: scheme.documents.map((d) => ({
          schemeId: id,
          documentName: d.documentName,
          description: d.description,
          format: d.format,
          required: d.required,
        })),
      });
    }
  }

  console.log(`\nSchemes: ${created} created, ${updated} updated.`);

  // ─── Compatibility relationships ───────────────────────────────────────
  console.log(`\nSeeding ${RELATIONSHIPS.length} compatibility relationships...\n`);
  let relCreated = 0;
  let relSkipped = 0;

  for (const rel of RELATIONSHIPS) {
    const schemeId = slugToId.get(rel.schemeSlug);
    const relatedId = slugToId.get(rel.relatedSchemeSlug);
    if (!schemeId || !relatedId) {
      console.log(`  ⊘ Skipped: ${rel.schemeSlug} ↔ ${rel.relatedSchemeSlug} (scheme not found)`);
      relSkipped++;
      continue;
    }

    try {
      await prisma.schemeCompatibility.upsert({
        where: {
          uq_scheme_compatibility: {
            schemeId,
            relatedSchemeId: relatedId,
          },
        },
        create: {
          schemeId,
          relatedSchemeId: relatedId,
          relationshipType: rel.relationshipType,
          officialRule: rel.officialRule,
          verified: true,
        },
        update: {
          relationshipType: rel.relationshipType,
          officialRule: rel.officialRule,
          verified: true,
        },
      });
      relCreated++;
      process.stdout.write(`  ✓ ${rel.schemeSlug} → ${rel.relatedSchemeSlug} (${rel.relationshipType})\n`);
    } catch (err) {
      console.log(`  ✗ Failed ${rel.schemeSlug} → ${rel.relatedSchemeSlug}: ${err instanceof Error ? err.message : String(err)}`);
      relSkipped++;
    }
  }

  console.log(`\nRelationships: ${relCreated} upserted, ${relSkipped} skipped.`);
  console.log(`\n✓ Seed complete.`);
}

seed()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
