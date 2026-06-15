/**
 * Scheme Assistant — RAG-based question answering over verified
 * government scheme data.
 *
 * Pipeline (Req 6.1–6.8):
 *   1. Detect the language of the citizen's query (Req 12.3).
 *   2. Retrieve the top 5 most relevant chunks from the vector DB (Req 6.1).
 *   3. Hydrate cited schemes from Postgres for source URLs and
 *      `last verified` dates (Req 6.2).
 *   4. Refuse non-scheme questions and unverified topics gracefully
 *      (Req 6.3, 6.4).
 *   5. Generate the final answer with GPT-4 using the conversational
 *      history for context (Req 6.6) and bounded length (≤500 words,
 *      Req 6.8).
 *   6. Persist the new exchange in the conversation store and return a
 *      structured {@link AssistantResponse} with a unique trace ID for
 *      observability (Req 21.5).
 *
 * All external clients (Pinecone, Prisma, OpenAI, conversation store) are
 * supplied via dependency injection so the service is fully unit-testable
 * without network access.
 */

import { randomUUID } from 'node:crypto';

import type {
  AssistantResponse,
  RetrievedChunk,
  SourceCitation,
  SupportedLanguage,
} from '@bharat-benefits/shared';

import type { EmbeddingsClient } from '../crawler/embeddings';
import { generateEmbedding } from '../crawler/embeddings';
import {
  InMemoryConversationStore,
  type ConversationExchange,
  type ConversationStore,
} from './conversation-store';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Top-K chunks retrieved per query (Req 6.1). */
export const RETRIEVAL_TOP_K = 5;

/** Hard cap on generated answer length in words (Req 6.8). */
export const MAX_ANSWER_WORDS = 500;

/** GPT-4 model used for response generation (design.md). */
export const ANSWER_MODEL = 'gpt-4';

/** Minimum cosine similarity required to treat a chunk as "verified". */
export const MIN_CHUNK_SIMILARITY = 0.2;

/**
 * Confidence threshold for honouring a detected query language (Req 12.3).
 *
 * If `detectLanguage(query).confidence` meets or exceeds this value the
 * assistant responds in the detected language; otherwise it falls back
 * to the citizen's selected platform language (or English if none was
 * supplied).
 */
export const LANGUAGE_DETECTION_CONFIDENCE_THRESHOLD = 0.8;

/** Default fallback language when no platform preference is supplied. */
export const DEFAULT_FALLBACK_LANGUAGE: SupportedLanguage = 'en';

/** Sentinel returned when no verified information is available. */
export const REFUSAL_NO_VERIFIED_INFO =
  "I don't have verified information on that topic. Please check official government sources.";

/** Sentinel returned when the question is not about government schemes. */
export const REFUSAL_OFF_TOPIC =
  'I can only answer questions about Indian government welfare schemes.';

// ─── Minimal external client interfaces ──────────────────────────────────────

/**
 * Subset of the Pinecone `Index.query` API used by the assistant. Tests
 * inject a stub conforming to this shape.
 */
export interface PineconeQueryResponse {
  matches?: Array<{
    id?: string;
    score?: number;
    metadata?: Record<string, unknown> | null;
  }>;
}

export interface PineconeIndexLike {
  query(args: {
    topK: number;
    vector: number[];
    includeMetadata?: boolean;
    includeValues?: boolean;
  }): Promise<PineconeQueryResponse>;
}

/**
 * Subset of the OpenAI Chat Completions API used to generate answers.
 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(args: {
        model: string;
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        temperature?: number;
        max_tokens?: number;
      }): Promise<{
        choices: Array<{
          message?: { role?: string; content?: string | null };
        }>;
      }>;
    };
  };
}

/**
 * Subset of Prisma's scheme model used by the assistant to hydrate
 * source citations (Req 6.2 — official source URL + last updated date).
 */
export interface SchemeRecord {
  id: string;
  name: string;
  sourceUrl: string;
  lastVerifiedAt: Date | string | null;
  updatedAt: Date | string;
}

export interface SchemeReader {
  scheme: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: {
        id: true;
        name: true;
        sourceUrl: true;
        lastVerifiedAt: true;
        updatedAt: true;
      };
    }): Promise<SchemeRecord[]>;
  };
}

// ─── Service options ─────────────────────────────────────────────────────────

export interface SchemeAssistantDeps {
  /** Pinecone index handle, narrowed to a namespace if applicable. */
  pineconeIndex: PineconeIndexLike;
  /** Prisma client (or test fake) for hydrating cited schemes. */
  prisma: SchemeReader;
  /** OpenAI client used for chat completion. */
  openai: ChatCompletionsClient;
  /** Embeddings client used to embed the query (defaults to OpenAI). */
  embeddingsClient: EmbeddingsClient;
  /** Conversation memory (defaults to an in-memory store). */
  conversationStore?: ConversationStore;
}

export interface SchemeAssistantOptions {
  /** Override the chat completion model (defaults to {@link ANSWER_MODEL}). */
  answerModel?: string;
  /** Override the retrieval top-K (defaults to {@link RETRIEVAL_TOP_K}). */
  topK?: number;
}

// ─── Language detection ──────────────────────────────────────────────────────

/**
 * Lightweight heuristic language detector for the 6 supported languages
 * (en, hi, bn, ta, te, mr). Based on Unicode script ranges rather than a
 * model so it runs synchronously and never makes network calls.
 *
 * Returns a `confidence` in [0, 1]. Callers should compare against the
 * 0.8 threshold from Req 12.3 before honouring the detected language.
 */
export function detectLanguage(text: string): {
  language: SupportedLanguage;
  confidence: number;
} {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { language: 'en', confidence: 0 };
  }

  // Strip whitespace and punctuation so they don't dilute the script
  // ratio. Latin letters count separately so English mixed with Indic
  // text is still classified by the dominant script.
  const counts: Record<SupportedLanguage, number> = {
    en: 0,
    hi: 0,
    bn: 0,
    ta: 0,
    te: 0,
    mr: 0,
  };
  let totalLetters = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;

    // Latin (English / Marathi-romanised / mixed)
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      counts.en += 1;
      totalLetters += 1;
      continue;
    }
    // Devanagari covers Hindi and Marathi. We disambiguate after the
    // loop using a Marathi-specific cue ("ळ" or "ऱ").
    if (cp >= 0x0900 && cp <= 0x097f) {
      counts.hi += 1;
      totalLetters += 1;
      continue;
    }
    // Bengali
    if (cp >= 0x0980 && cp <= 0x09ff) {
      counts.bn += 1;
      totalLetters += 1;
      continue;
    }
    // Tamil
    if (cp >= 0x0b80 && cp <= 0x0bff) {
      counts.ta += 1;
      totalLetters += 1;
      continue;
    }
    // Telugu
    if (cp >= 0x0c00 && cp <= 0x0c7f) {
      counts.te += 1;
      totalLetters += 1;
      continue;
    }
  }

  if (totalLetters === 0) {
    return { language: 'en', confidence: 0 };
  }

  // Marathi cue: characters unique to Marathi orthography in the
  // Devanagari block. If present, reclassify Devanagari count as Marathi.
  const hasMarathiCue = /[ळऱ]/.test(text);
  if (hasMarathiCue && counts.hi > 0) {
    counts.mr = counts.hi;
    counts.hi = 0;
  }

  let bestLang: SupportedLanguage = 'en';
  let bestCount = -1;
  for (const lang of ['en', 'hi', 'bn', 'ta', 'te', 'mr'] as SupportedLanguage[]) {
    if (counts[lang] > bestCount) {
      bestCount = counts[lang];
      bestLang = lang;
    }
  }

  const confidence = bestCount / totalLetters;
  return { language: bestLang, confidence };
}

// ─── Scheme topicality classifier ────────────────────────────────────────────

const SCHEME_KEYWORDS = [
  'scheme', 'yojana', 'subsidy', 'pension', 'scholarship', 'benefit',
  'eligibility', 'apply', 'application', 'government', 'sarkar', 'sarkari',
  'welfare', 'pmkvy', 'pmay', 'mgnrega', 'pm-kisan', 'kisan', 'aadhaar',
  'ration', 'ayushman', 'mudra', 'startup india', 'msme',
  'योजना', 'सरकार', 'सब्सिडी', 'पेंशन', 'छात्रवृत्ति',
  'প্রকল্প', 'সরকার',
  'திட்டம்', 'அரசு',
  'పథకం', 'ప్రభుత్వ',
];

/**
 * Returns true if the question appears to be about Indian government
 * schemes. Used to honour Req 6.4 — refuse off-topic questions before
 * calling the LLM.
 *
 * The classifier is intentionally lenient: when retrieval still returns
 * relevant chunks above the similarity threshold, we treat the question
 * as on-topic regardless of this heuristic.
 */
export function isLikelySchemeQuestion(query: string): boolean {
  const q = query.toLowerCase();
  return SCHEME_KEYWORDS.some((kw) => q.includes(kw.toLowerCase()));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clampWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(' ');
}

function toDate(value: Date | string | null | undefined, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class SchemeAssistant {
  private readonly pineconeIndex: PineconeIndexLike;
  private readonly prisma: SchemeReader;
  private readonly openai: ChatCompletionsClient;
  private readonly embeddingsClient: EmbeddingsClient;
  private readonly conversationStore: ConversationStore;
  private readonly answerModel: string;
  private readonly topK: number;

  constructor(deps: SchemeAssistantDeps, options: SchemeAssistantOptions = {}) {
    if (!deps.pineconeIndex) {
      throw new Error('SchemeAssistant: pineconeIndex dependency is required');
    }
    if (!deps.prisma) {
      throw new Error('SchemeAssistant: prisma dependency is required');
    }
    if (!deps.openai) {
      throw new Error('SchemeAssistant: openai dependency is required');
    }
    if (!deps.embeddingsClient) {
      throw new Error('SchemeAssistant: embeddingsClient dependency is required');
    }

    this.pineconeIndex = deps.pineconeIndex;
    this.prisma = deps.prisma;
    this.openai = deps.openai;
    this.embeddingsClient = deps.embeddingsClient;
    this.conversationStore = deps.conversationStore ?? new InMemoryConversationStore();
    this.answerModel = options.answerModel ?? ANSWER_MODEL;
    this.topK = options.topK ?? RETRIEVAL_TOP_K;
  }

  /**
   * Detects the language of arbitrary input text. Exposed on the
   * service surface to satisfy the design's `detectLanguage` contract;
   * delegates to the module-level {@link detectLanguage}.
   */
  detectLanguage(text: string): { language: SupportedLanguage; confidence: number } {
    return detectLanguage(text);
  }

  /**
   * Resolves the language the assistant should respond in (Req 12.3).
   *
   * The contract is:
   *   - Detect the language of the citizen's query.
   *   - If detection confidence meets {@link LANGUAGE_DETECTION_CONFIDENCE_THRESHOLD}
   *     (≥ 0.8), respond in the detected language.
   *   - Otherwise fall back to `platformLanguage` (the citizen's selected
   *     UI language). If no platform language is supplied, default to
   *     {@link DEFAULT_FALLBACK_LANGUAGE} ('en').
   *
   * Mid-conversation switches (Req 12.7) are handled implicitly: each
   * call detects the language of the *current* turn, so a citizen who
   * switches from English to Hindi mid-session will receive Hindi
   * responses from the next turn onward without losing conversation
   * history.
   */
  resolveResponseLanguage(
    query: string,
    platformLanguage?: SupportedLanguage,
  ): {
    language: SupportedLanguage;
    detected: SupportedLanguage;
    confidence: number;
    usedFallback: boolean;
  } {
    const detected = this.detectLanguage(query);
    const fallback = platformLanguage ?? DEFAULT_FALLBACK_LANGUAGE;
    if (detected.confidence >= LANGUAGE_DETECTION_CONFIDENCE_THRESHOLD) {
      return {
        language: detected.language,
        detected: detected.language,
        confidence: detected.confidence,
        usedFallback: false,
      };
    }
    return {
      language: fallback,
      detected: detected.language,
      confidence: detected.confidence,
      usedFallback: true,
    };
  }

  /**
   * Retrieves the top {@link RETRIEVAL_TOP_K} chunks for a query from
   * the vector index. Filters out matches missing required metadata so
   * downstream consumers can rely on `schemeId` and `chunkText` being
   * populated.
   */
  async retrieveContext(query: string): Promise<RetrievedChunk[]> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('retrieveContext: query must be a non-empty string');
    }

    const vector = await generateEmbedding(query, this.embeddingsClient);
    const response = await this.pineconeIndex.query({
      topK: this.topK,
      vector,
      includeMetadata: true,
    });

    const matches = response.matches ?? [];
    const out: RetrievedChunk[] = [];
    for (const match of matches) {
      const meta = (match.metadata ?? {}) as Record<string, unknown>;
      const schemeId = typeof meta.schemeId === 'string' ? meta.schemeId : null;
      const chunkText = typeof meta.chunkText === 'string' ? meta.chunkText : null;
      const chunkIndex = typeof meta.chunkIndex === 'number' ? meta.chunkIndex : 0;
      const similarity = typeof match.score === 'number' ? match.score : 0;
      if (!schemeId || !chunkText) {
        continue;
      }
      out.push({ schemeId, chunkText, chunkIndex, similarity });
    }
    return out;
  }

  /**
   * Answers a citizen query using RAG. Returns a structured response
   * with the answer text, source citations, detected language, and a
   * unique `traceId`. Honours Req 6.3 / 6.4 / 6.8 / 12.3 / 12.7.
   *
   * @param query           Citizen's question (any supported language).
   * @param sessionId       Stable conversation identifier so follow-up
   *                        questions can reuse history (Req 6.6).
   * @param platformLanguage The citizen's selected platform / UI language.
   *                        Used as the fallback response language when
   *                        per-query detection confidence falls below
   *                        {@link LANGUAGE_DETECTION_CONFIDENCE_THRESHOLD}
   *                        (Req 12.3). When the citizen switches
   *                        platform language mid-conversation (Req 12.7),
   *                        callers should pass the new selection on the
   *                        next call — conversation context is preserved
   *                        regardless.
   */
  async answerQuery(
    query: string,
    sessionId: string,
    platformLanguage?: SupportedLanguage,
  ): Promise<AssistantResponse> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new Error('answerQuery: query must be a non-empty string');
    }
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new Error('answerQuery: sessionId must be a non-empty string');
    }

    const traceId = randomUUID();

    // Resolve the response language per Req 12.3:
    //   - Use the detected language when confidence ≥ 80%.
    //   - Otherwise fall back to the citizen's platform language.
    // Re-running detection on every call also satisfies Req 12.7 — a
    // mid-conversation language switch is honoured from the next turn
    // forward while history (stored in any prior language) is preserved.
    const { language: responseLanguage } = this.resolveResponseLanguage(
      query,
      platformLanguage,
    );

    // Retrieve relevant context.
    const chunks = await this.retrieveContext(query);
    const verifiedChunks = chunks.filter((c) => c.similarity >= MIN_CHUNK_SIMILARITY);

    // Off-topic guard: when the question doesn't look like a scheme
    // question AND retrieval found nothing useful, refuse politely
    // without consulting the LLM (Req 6.4).
    if (!isLikelySchemeQuestion(query) && verifiedChunks.length === 0) {
      return this.finalizeResponse({
        answer: REFUSAL_OFF_TOPIC,
        sources: [],
        sessionId,
        query,
        language: responseLanguage,
        traceId,
      });
    }

    // No verified information available (Req 6.3).
    if (verifiedChunks.length === 0) {
      return this.finalizeResponse({
        answer: REFUSAL_NO_VERIFIED_INFO,
        sources: [],
        sessionId,
        query,
        language: responseLanguage,
        traceId,
      });
    }

    // Hydrate cited schemes from Postgres so we can attach official
    // source URLs and last-verified dates (Req 6.2).
    const schemeIds = Array.from(new Set(verifiedChunks.map((c) => c.schemeId)));
    const schemeRecords = await this.prisma.scheme.findMany({
      where: { id: { in: schemeIds } },
      select: {
        id: true,
        name: true,
        sourceUrl: true,
        lastVerifiedAt: true,
        updatedAt: true,
      },
    });
    const recordById = new Map(schemeRecords.map((s) => [s.id, s]));

    // If the retrieval brought back chunks but none of the corresponding
    // schemes still exist in the DB, treat that as "no verified info".
    if (recordById.size === 0) {
      return this.finalizeResponse({
        answer: REFUSAL_NO_VERIFIED_INFO,
        sources: [],
        sessionId,
        query,
        language: responseLanguage,
        traceId,
      });
    }

    const sources = this.buildSources(verifiedChunks, recordById);

    // Pull conversation history and call the LLM.
    const history = await this.conversationStore.getHistory(sessionId);
    const rawAnswer = await this.generateAnswer({
      query,
      chunks: verifiedChunks,
      schemeRecords: recordById,
      history,
      language: responseLanguage,
    });
    const answer = clampWords(rawAnswer, MAX_ANSWER_WORDS);

    return this.finalizeResponse({
      answer,
      sources,
      sessionId,
      query,
      language: responseLanguage,
      traceId,
    });
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private buildSources(
    chunks: RetrievedChunk[],
    recordById: Map<string, SchemeRecord>,
  ): SourceCitation[] {
    const seen = new Set<string>();
    const sources: SourceCitation[] = [];
    for (const c of chunks) {
      if (seen.has(c.schemeId)) continue;
      const rec = recordById.get(c.schemeId);
      if (!rec) continue;
      seen.add(c.schemeId);
      sources.push({
        schemeId: rec.id,
        schemeName: rec.name,
        sourceUrl: rec.sourceUrl,
        lastUpdated: toDate(rec.lastVerifiedAt ?? rec.updatedAt, new Date(0)),
      });
    }
    return sources;
  }

  private async generateAnswer(params: {
    query: string;
    chunks: RetrievedChunk[];
    schemeRecords: Map<string, SchemeRecord>;
    history: ConversationExchange[];
    language: SupportedLanguage;
  }): Promise<string> {
    const { query, chunks, schemeRecords, history, language } = params;

    const contextBlock = chunks
      .map((c, i) => {
        const rec = schemeRecords.get(c.schemeId);
        const name = rec?.name ?? 'Unknown scheme';
        const url = rec?.sourceUrl ?? '';
        return `[${i + 1}] ${name} (${url})\n${c.chunkText}`;
      })
      .join('\n\n');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: [
          'You are Bharat Benefits AI, a helpful assistant for Indian government welfare schemes.',
          'Answer ONLY using the verified scheme context provided below.',
          'If the context does not contain enough information, say so plainly — never invent details.',
          'Cite the scheme by name when you mention it.',
          `Respond in language code "${language}".`,
          `Limit your answer to at most ${MAX_ANSWER_WORDS} words.`,
        ].join(' '),
      },
    ];

    for (const exchange of history) {
      messages.push({ role: 'user', content: exchange.userQuery });
      messages.push({ role: 'assistant', content: exchange.assistantAnswer });
    }

    messages.push({
      role: 'user',
      content: `Context:\n${contextBlock}\n\nQuestion: ${query}`,
    });

    const completion = await this.openai.chat.completions.create({
      model: this.answerModel,
      messages,
      temperature: 0.2,
      max_tokens: 800,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      // The LLM produced nothing usable — degrade to the refusal
      // message rather than returning empty text.
      return REFUSAL_NO_VERIFIED_INFO;
    }
    return content.trim();
  }

  private async finalizeResponse(params: {
    answer: string;
    sources: SourceCitation[];
    sessionId: string;
    query: string;
    language: SupportedLanguage;
    traceId: string;
  }): Promise<AssistantResponse> {
    const { answer, sources, sessionId, query, language, traceId } = params;

    // Persist the exchange so follow-ups can reference it (Req 6.6).
    await this.conversationStore.appendExchange(sessionId, {
      userQuery: query,
      assistantAnswer: answer,
      language,
    });

    return { answer, sources, language, traceId };
  }
}
