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

export interface RegisterAssistantRoutesOptions {
  /** Override the assistant instance — useful for tests. */
  assistant?: SchemeAssistant;
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

      try {
        const assistant = options.assistant ?? getDefaultAssistant();
        const response = await assistant.answerQuery(
          query,
          sessionId,
          language,
        );

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
