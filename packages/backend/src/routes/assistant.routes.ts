/**
 * HTTP route for the Scheme Assistant chatbot (Requirement 6).
 *
 * - `POST /api/assistant/query` — Submit a citizen question, receive an
 *   AI-generated answer with source citations from verified scheme data.
 *
 * The route uses the SchemeAssistant service which performs:
 *   1. Retrieve top-K relevant chunks from Pinecone (semantic search)
 *   2. Hydrate scheme metadata (source URL, last updated date)
 *   3. Generate response via Gemini with conversational context
 *
 * If an `ObservabilityService` is supplied the route also writes a
 * minimal `AssistantQueryLog` row for every successful answer so the
 * downstream feedback endpoint (Req 21.3) has a foreign-key target.
 * Without this hook, citizen ratings 500 with an FK violation because
 * `AssistantResponseFeedback.traceId` references `AssistantQueryLog`.
 * The write is best-effort — a log failure must not break the chat.
 */

import type { FastifyInstance } from 'fastify';
import type { SupportedLanguage } from '@bharat-benefits/shared';
import {
  SchemeAssistant,
  type PineconeIndexLike,
  type SchemeReader,
} from '../services/assistant/scheme-assistant';
import { getSchemeIndex, getSchemeNamespace } from '../lib/vectordb';
import { getGeminiChatClient, createGeminiEmbeddingsClient } from '../lib/gemini';
import prisma from '../lib/prisma';
import type { ObservabilityService } from '../services/ai-observability';

export interface RegisterAssistantRoutesOptions {
  /** Override the assistant instance — useful for tests. */
  assistant?: SchemeAssistant;
  /**
   * Optional observability service. When supplied the route persists an
   * `AssistantQueryLog` row for every answered query so feedback writes
   * have a foreign-key target and the admin observability rollups have
   * data to aggregate.
   */
  observabilityService?: ObservabilityService;
}

let cachedAssistant: SchemeAssistant | null = null;

interface NamespaceablePineconeIndex extends PineconeIndexLike {
  namespace(name: string): PineconeIndexLike;
}

const SUPPORTED_LANGUAGES = new Set<SupportedLanguage>(['en', 'hi', 'bn', 'ta', 'te', 'mr']);

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.has(value as SupportedLanguage);
}

function getDefaultAssistant(): SchemeAssistant {
  if (cachedAssistant) return cachedAssistant;

  const baseIndex = getSchemeIndex() as unknown as NamespaceablePineconeIndex;
  const namespace = getSchemeNamespace();
  const pineconeIndex = namespace ? baseIndex.namespace(namespace) : baseIndex;

  cachedAssistant = new SchemeAssistant({
    pineconeIndex,
    prisma: prisma as unknown as SchemeReader,
    openai: getGeminiChatClient(),
    embeddingsClient: createGeminiEmbeddingsClient(),
  });
  return cachedAssistant;
}

export function registerAssistantRoutes(
  app: FastifyInstance,
  options: RegisterAssistantRoutesOptions = {},
): void {
  const observabilityService = options.observabilityService;

  app.post<{
    Body: {
      query?: unknown;
      sessionId?: unknown;
      language?: unknown;
    };
  }>(
    '/api/assistant/query',
    async (request, reply) => {
      const body = request.body ?? {};
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : `anon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const language = isSupportedLanguage(body.language) ? body.language : undefined;

      if (!query) {
        return reply.code(400).send({
          error: 'BadRequest',
          message: 'query is required',
        });
      }

      const startedAt = Date.now();

      try {
        const assistant = options.assistant ?? getDefaultAssistant();
        const response = await assistant.answerQuery(
          query,
          sessionId,
          language,
        );

        // Best-effort query-log write so feedback endpoints have an FK
        // target. The current SchemeAssistant doesn't expose retrieved
        // chunks to callers, so we record an empty array — the rollup
        // routes degrade gracefully on missing chunks (Req 21.2).
        if (observabilityService) {
          const durationMs = Date.now() - startedAt;
          observabilityService
            .recordAssistantQuery({
              traceId: response.traceId,
              sessionId,
              userId: request.user?.sub ?? null,
              query,
              response: {
                answer: response.answer,
                sources: response.sources,
                language: response.language,
                traceId: response.traceId,
              },
              retrievedChunks: [],
              durationMs,
            })
            .catch((err: unknown) => {
              request.log.warn(
                { err, traceId: response.traceId },
                'failed to persist assistant query log',
              );
            });
        }

        return reply.code(200).send({
          answer: response.answer,
          sources: response.sources,
          sessionId,
          language: response.language,
          traceId: response.traceId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        request.log.error({ err }, 'Assistant query failed');
        return reply.code(500).send({
          error: 'AssistantError',
          message: msg,
        });
      }
    },
  );
}
