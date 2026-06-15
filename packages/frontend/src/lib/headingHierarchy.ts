/**
 * Heading hierarchy validation utility (Requirement 20.5).
 *
 * WCAG 2.1 AA requires a meaningful heading hierarchy where heading
 * levels are sequential and no levels are skipped (e.g. h1 → h3 with
 * no h2 is a failure).
 *
 * This module provides:
 *   - A pure function `validateHeadingHierarchy` that checks an array
 *     of heading levels for sequential ordering.
 *   - A type-safe `HeadingLevel` type constraining the valid values.
 *
 * These are useful for:
 *   - Unit tests that verify page components produce valid hierarchies.
 *   - Development-time lint assertions.
 *   - Automated accessibility audits on rendered pages.
 */

/** Valid HTML heading levels (h1–h6). */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Result of heading hierarchy validation. */
export interface HeadingValidationResult {
  /** Whether the heading hierarchy is valid. */
  valid: boolean;
  /** List of issues found (empty when valid). */
  issues: HeadingIssue[];
}

/** A single heading hierarchy issue. */
export interface HeadingIssue {
  /** The index in the input array where the issue occurs. */
  index: number;
  /** The problematic heading level. */
  level: HeadingLevel;
  /** The previous heading level (for context). */
  previousLevel: HeadingLevel | null;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Validates that an array of heading levels follows WCAG heading
 * hierarchy rules:
 *
 * 1. The first heading should be h1 (page title).
 * 2. Each subsequent heading must not skip more than one level down
 *    from its predecessor (h2 → h4 is invalid; h2 → h3 is valid).
 * 3. Going back up in level (h3 → h2) is always valid — it signals
 *    the end of a subsection.
 * 4. Multiple h1 elements are flagged as a warning (though not
 *    technically a WCAG failure, it's best practice to have one h1).
 *
 * @param levels Array of heading levels in document order.
 * @returns Validation result with issues array.
 */
export function validateHeadingHierarchy(levels: HeadingLevel[]): HeadingValidationResult {
  const issues: HeadingIssue[] = [];

  if (levels.length === 0) {
    return { valid: true, issues: [] };
  }

  // Check that the first heading is h1
  if (levels[0] !== 1) {
    issues.push({
      index: 0,
      level: levels[0],
      previousLevel: null,
      message: `First heading should be h1, found h${levels[0]}`,
    });
  }

  // Track h1 count — more than one is a best practice issue
  let h1Count = 0;

  for (let i = 0; i < levels.length; i++) {
    const current = levels[i];

    if (current === 1) h1Count++;

    if (i === 0) continue;

    const previous = levels[i - 1];

    // A heading that goes deeper must not skip levels
    // (e.g., h2 → h4 skips h3)
    if (current > previous && current - previous > 1) {
      issues.push({
        index: i,
        level: current,
        previousLevel: previous,
        message: `Heading level skipped: h${previous} → h${current} (expected h${previous + 1} or same/higher level)`,
      });
    }
  }

  // Warn about multiple h1 elements
  if (h1Count > 1) {
    const secondH1Index = levels.indexOf(1, levels.indexOf(1) + 1);
    issues.push({
      index: secondH1Index,
      level: 1,
      previousLevel: levels[secondH1Index - 1],
      message: `Multiple h1 elements found (${h1Count} total). Best practice is a single h1 per page.`,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Returns the recommended next heading level given the current context.
 * Useful for components that need to render headings at the correct
 * level within a page hierarchy.
 *
 * @param parentLevel The heading level of the parent section.
 * @returns The next valid child heading level (parentLevel + 1, capped at 6).
 */
export function getChildHeadingLevel(parentLevel: HeadingLevel): HeadingLevel {
  return Math.min(parentLevel + 1, 6) as HeadingLevel;
}
