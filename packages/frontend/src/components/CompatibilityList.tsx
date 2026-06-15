/**
 * Renders the scheme's compatibility relationships grouped by type so the
 * citizen sees which schemes can be combined, which cannot, and which must
 * be completed first (Req 7.2).
 *
 * Each relationship shows the related scheme name, the official rule that
 * justifies the relationship, and a link to the source URL when one is on
 * file. An empty relationship list collapses the entire section so the
 * detail page does not show a useless "no relationships" header.
 */

import type {
  SchemeRelationship,
  SchemeRelationshipType,
} from '@bharat-benefits/shared';

export interface CompatibilityListProps {
  relationships: SchemeRelationship[];
}

interface Group {
  type: SchemeRelationshipType;
  heading: string;
  description: string;
  color: string;
}

const GROUPS: Group[] = [
  {
    type: 'can_combine_with',
    heading: 'Compatible schemes',
    description: 'You can claim this scheme alongside the following schemes.',
    color: '#1a7f37',
  },
  {
    type: 'cannot_combine_with',
    heading: 'Incompatible schemes',
    description:
      'You cannot claim this scheme together with the schemes below.',
    color: '#cf222e',
  },
  {
    type: 'prerequisite_schemes',
    heading: 'Prerequisite schemes',
    description: 'Complete the following schemes before applying.',
    color: '#0b5394',
  },
];

export function CompatibilityList({ relationships }: CompatibilityListProps) {
  if (!relationships || relationships.length === 0) {
    return null;
  }

  const byType = new Map<SchemeRelationshipType, SchemeRelationship[]>();
  for (const rel of relationships) {
    const list = byType.get(rel.type) ?? [];
    list.push(rel);
    byType.set(rel.type, list);
  }

  return (
    <section
      aria-labelledby="compatibility-heading"
      style={{
        border: '1px solid #d0d7de',
        borderRadius: 8,
        padding: 16,
        background: '#fff',
        marginBottom: 16,
      }}
    >
      <h2
        id="compatibility-heading"
        style={{ marginTop: 0, fontSize: 18, marginBottom: 12 }}
      >
        Compatibility with other schemes
      </h2>

      {GROUPS.map((group) => {
        const items = byType.get(group.type);
        if (!items || items.length === 0) return null;
        return (
          <div key={group.type} style={{ marginBottom: 16 }}>
            <h3
              style={{
                fontSize: 14,
                margin: '0 0 4px',
                color: group.color,
              }}
            >
              {group.heading}
            </h3>
            <p style={{ margin: '0 0 8px', color: '#57606a', fontSize: 13 }}>
              {group.description}
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {items.map((rel) => (
                <li
                  key={`${group.type}-${rel.relatedSchemeId}`}
                  style={{ marginBottom: 6 }}
                >
                  <strong>{rel.relatedSchemeName || rel.relatedSchemeId}</strong>
                  {rel.officialRule && (
                    <>
                      {' '}
                      <span style={{ color: '#57606a' }}>
                        — {rel.officialRule}
                      </span>
                    </>
                  )}
                  {rel.sourceUrl && (
                    <>
                      {' '}
                      <a
                        href={rel.sourceUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ fontSize: 13, color: '#0b5394' }}
                      >
                        (official rule)
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
