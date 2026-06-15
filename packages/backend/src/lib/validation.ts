/**
 * Tiny zod-based validation helper for Fastify routes.
 *
 * Why not `fastify-type-provider-zod` directly:
 *   - The provider would force every route declaration to thread generic
 *     parameters through the route options, a large invasive change.
 *   - We want a minimal helper that produces a uniform 400 envelope when
 *     a request fails validation, regardless of which route it hits.
 *
 * Pattern at the call site:
 *
 *   const parsed = parseOrReply(BodySchema, request.body, reply);
 *   if (!parsed) return reply; // helper already sent 400 + envelope
 *   const data = parsed.data;
 */

import type { FastifyReply } from 'fastify';
import type { ZodIssue, ZodTypeAny, infer as zInfer } from 'zod';

/** Discriminated success result returned by {@link parseOrReply}. */
export interface ParseSuccess<T> {
  ok: true;
  data: T;
}

/**
 * Validates `value` against `schema` and either returns the parsed data
 * or sends a uniform 400 envelope on the supplied reply.
 *
 * Returns `null` after sending the response so handlers can pattern with:
 *
 *   const parsed = parseOrReply(Schema, input, reply);
 *   if (!parsed) return reply;
 *
 * The envelope shape is intentionally stable so frontend clients can
 * discriminate on `error: 'ValidationError'` and render field-level
 * messages from `issues`.
 */
export function parseOrReply<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
): ParseSuccess<zInfer<S>> | null {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, data: result.data as zInfer<S> };
  }
  const issues = serializeIssues(result.error.issues);
  // Surface the first issue's path + message in the top-level `message`
  // so callers (and tests) can grep for the field name without parsing
  // the full `issues` array. The structured `issues` array is still
  // attached for clients that want the full picture.
  const first = issues[0];
  const summary = first
    ? first.path.length > 0
      ? `${first.path.join('.')}: ${first.message}`
      : first.message
    : 'Request payload failed validation';
  reply.code(400).send({
    error: 'ValidationError',
    message: summary,
    issues,
  });
  return null;
}

/**
 * Maps zod's verbose issue array to a compact wire shape. Drops the
 * internal `unionErrors` because they explode to many lines for every
 * branch of a discriminated union and aren't useful to API consumers.
 */
function serializeIssues(issues: readonly ZodIssue[]): Array<{
  path: Array<string | number>;
  code: string;
  message: string;
}> {
  return issues.map((i) => ({
    path: i.path,
    code: i.code,
    message: i.message,
  }));
}
