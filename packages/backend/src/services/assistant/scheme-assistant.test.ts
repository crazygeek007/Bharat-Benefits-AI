/**
 * Unit tests for the {@link SchemeAssistant} RAG service.
 *
 * These tests use in-memory fakes for every external dependency
 * (Pinecone index, Prisma scheme reader, OpenAI chat client, embeddings
 * client) so the suite is hermetic and runs in milliseconds.
 *
 * Scenarios covered:
 *   - Successful retrieval + generation produces an AssistantResponse
 *     with sources, language, and a unique trace ID (Req 6.1, 6.2, 6.5).
 *   - Off-topic questions are refused without calling the LLM (Req 6.4).
 *   - Empty / low-similarity retrieval triggers the "no verified info"
 *     refusal (Req 6.3).
 *   - Responses are clamped to 500 words (Req 6.8).
 *   - Conversation history is appended after each exchange (Req 6.6).
 *   - retrieveContext returns ≤ topK chunks and filters malformed
 *     matches (Req 6.1).
 *   - detectLanguage classifies the 6 supported languages from script
 *     cues with reasonable confidence (Req 12.3).
 *   - Mid-conversation language switches preserve history and respond
 *     in the new language going forward (Req 12.7).
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 12.3, 12.7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  ANSWER_MODEL,
  MAX_ANSWER_WORDS,
  REFUSAL_NO_VERIFIED_INFO,
  REFUSAL_OFF_TOPIC,
  RETRIEVAL_TOP_K,
  SchemeAssistant,
  detectLanguage,
  isLikelySchemeQuestion,
  type ChatCompletionsClient,
  type PineconeIndexLike,
  type SchemeReader,
  type SchemeRecord,
} from './scheme-assistant';
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingsClient,
} from '../crawler/embeddings';
import { InMemoryConversationStore } from './conversation-store';

// ─── Mock factories ──────────────────────────────────────────────────────────

function makeEmbeddingsClient(): EmbeddingsClient & {
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async (_args: { model: string; input: string | string[] }) => ({
    data: [{ embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01) }],
  }));
  return { embeddings: { create } } as unknown as EmbeddingsClient & {
    create: ReturnType<typeof vi.fn>;
  };
}

interface PineconeMatch {
  id?: string;
  score?: number;
  metadata?: Record<string, unknown> | null;
}

function makePineconeIndex(matches: PineconeMatch[]): PineconeIndexLike & {
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({ matches }));
  return { query } as unknown as PineconeIndexLike & {
    query: ReturnType<typeof vi.fn>;
  };
}

function makeSchemeReader(records: SchemeRecord[]): SchemeReader & {
  scheme: { findMany: ReturnType<typeof vi.fn> };
} {
  const findMany = vi.fn(
    async (args: { where: { id: { in: string[] } } }) => {
      const ids = new Set(args.where.id.in);
      return records.filter((r) => ids.has(r.id));
    },
  );
  return { scheme: { findMany } } as unknown as SchemeReader & {
    scheme: { findMany: ReturnType<typeof vi.fn> };
  };
}

function makeOpenAI(content: string): ChatCompletionsClient & {
  chat: { completions: { create: ReturnType<typeof vi.fn> } };
} {
  const create = vi.fn(async () => ({
    choices: [{ message: { role: 'assistant', content } }],
  }));
  return {
    chat: { completions: { create } },
  } as unknown as ChatCompletionsClient & {
    chat: { completions: { create: ReturnType<typeof vi.fn> } };
  };
}

// ─── Default fixtures ────────────────────────────────────────────────────────

const PM_KISAN: SchemeRecord = {
  id: 'scheme-1',
  name: 'PM Kisan Samman Nidhi',
  sourceUrl: 'https://pmkisan.gov.in',
  lastVerifiedAt: new Date('2025-01-15T00:00:00Z'),
  updatedAt: new Date('2025-01-15T00:00:00Z'),
};

const AYUSHMAN: SchemeRecord = {
  id: 'scheme-2',
  name: 'Ayushman Bharat',
  sourceUrl: 'https://abdm.gov.in',
  lastVerifiedAt: null,
  updatedAt: new Date('2025-02-01T00:00:00Z'),
};

function highScoreMatch(
  schemeId: string,
  chunkText: string,
  chunkIndex = 0,
): PineconeMatch {
  return {
    id: `${schemeId}-${chunkIndex}`,
    score: 0.85,
    metadata: { schemeId, chunkText, chunkIndex },
  };
}

// ─── detectLanguage ──────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('returns en with confidence 0 for empty input', () => {
    expect(detectLanguage('')).toEqual({ language: 'en', confidence: 0 });
    expect(detectLanguage('   ')).toEqual({ language: 'en', confidence: 0 });
  });

  it('classifies plain English as en with high confidence', () => {
    const r = detectLanguage('What schemes are available for farmers?');
    expect(r.language).toBe('en');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies Hindi (Devanagari) as hi', () => {
    const r = detectLanguage('प्रधानमंत्री किसान योजना क्या है?');
    expect(r.language).toBe('hi');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies Marathi via the ळ cue even though it shares Devanagari', () => {
    const r = detectLanguage('शाळेत जाण्यासाठी कोणती योजना आहे?');
    expect(r.language).toBe('mr');
  });

  it('classifies Bengali, Tamil, and Telugu by script range', () => {
    expect(detectLanguage('সরকারি প্রকল্প কী?').language).toBe('bn');
    expect(detectLanguage('அரசு திட்டம் என்றால் என்ன?').language).toBe('ta');
    expect(detectLanguage('ప్రభుత్వ పథకం అంటే ఏమిటి?').language).toBe('te');
  });
});

// ─── isLikelySchemeQuestion ──────────────────────────────────────────────────

describe('isLikelySchemeQuestion', () => {
  it('matches scheme-related English keywords', () => {
    expect(isLikelySchemeQuestion('Tell me about PM Kisan scheme')).toBe(true);
    expect(isLikelySchemeQuestion('Am I eligible for any subsidy?')).toBe(true);
    expect(isLikelySchemeQuestion('How to apply for a government scheme')).toBe(
      true,
    );
  });

  it('matches Hindi/Indic keywords', () => {
    expect(isLikelySchemeQuestion('प्रधानमंत्री योजना')).toBe(true);
  });

  it('returns false for clearly off-topic English', () => {
    expect(isLikelySchemeQuestion('What is the weather today?')).toBe(false);
    expect(isLikelySchemeQuestion('Who won the cricket match?')).toBe(false);
  });
});

// ─── SchemeAssistant.retrieveContext ─────────────────────────────────────────

describe('SchemeAssistant.retrieveContext', () => {
  it('returns up to topK chunks, filtering malformed matches', async () => {
    const matches: PineconeMatch[] = [
      highScoreMatch('scheme-1', 'PM Kisan provides INR 6,000 yearly.'),
      highScoreMatch('scheme-2', 'Ayushman Bharat covers health up to 5 lakh.', 0),
      // Malformed: missing schemeId
      { id: 'm3', score: 0.5, metadata: { chunkText: 'orphan' } },
      // Malformed: missing chunkText
      { id: 'm4', score: 0.4, metadata: { schemeId: 'scheme-3' } },
    ];
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([PM_KISAN, AYUSHMAN]),
      openai: makeOpenAI('ignored'),
      embeddingsClient: makeEmbeddingsClient(),
    });

    const chunks = await assistant.retrieveContext('farmer subsidy');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.schemeId).toBe('scheme-1');
    expect(chunks[1]!.schemeId).toBe('scheme-2');
  });

  it('passes topK and includeMetadata=true to the index', async () => {
    const index = makePineconeIndex([]);
    const assistant = new SchemeAssistant({
      pineconeIndex: index,
      prisma: makeSchemeReader([]),
      openai: makeOpenAI('ignored'),
      embeddingsClient: makeEmbeddingsClient(),
    });

    await assistant.retrieveContext('any');
    expect(index.query).toHaveBeenCalledTimes(1);
    const args = index.query.mock.calls[0]![0];
    expect(args.topK).toBe(RETRIEVAL_TOP_K);
    expect(args.includeMetadata).toBe(true);
    expect(Array.isArray(args.vector)).toBe(true);
  });

  it('rejects empty queries', async () => {
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([]),
      prisma: makeSchemeReader([]),
      openai: makeOpenAI('ignored'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    await expect(assistant.retrieveContext('')).rejects.toThrow();
    await expect(assistant.retrieveContext('   ')).rejects.toThrow();
  });
});

// ─── SchemeAssistant.answerQuery — happy path ────────────────────────────────

describe('SchemeAssistant.answerQuery — happy path', () => {
  let assistant: SchemeAssistant;
  let openai: ReturnType<typeof makeOpenAI>;
  let prisma: ReturnType<typeof makeSchemeReader>;
  let conversationStore: InMemoryConversationStore;

  beforeEach(() => {
    const matches = [
      highScoreMatch('scheme-1', 'PM Kisan provides INR 6,000 yearly to farmers.'),
      highScoreMatch('scheme-2', 'Ayushman Bharat covers up to INR 5 lakh.', 0),
    ];
    openai = makeOpenAI('PM Kisan offers INR 6,000 per year to eligible farmers.');
    prisma = makeSchemeReader([PM_KISAN, AYUSHMAN]);
    conversationStore = new InMemoryConversationStore();
    assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma,
      openai,
      embeddingsClient: makeEmbeddingsClient(),
      conversationStore,
    });
  });

  it('returns an AssistantResponse with answer, sources, language, traceId', async () => {
    const response = await assistant.answerQuery(
      'Tell me about the PM Kisan scheme',
      'session-1',
      'en',
    );

    expect(response.answer).toContain('PM Kisan');
    expect(response.language).toBe('en');
    expect(response.traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(response.sources).toHaveLength(2);
    const ids = response.sources.map((s) => s.schemeId).sort();
    expect(ids).toEqual(['scheme-1', 'scheme-2']);
  });

  it('attaches official source URL and lastUpdated to each citation', async () => {
    const response = await assistant.answerQuery(
      'PM Kisan scheme details',
      'session-1',
    );
    const pmk = response.sources.find((s) => s.schemeId === 'scheme-1');
    const ab = response.sources.find((s) => s.schemeId === 'scheme-2');

    expect(pmk).toBeDefined();
    expect(pmk!.sourceUrl).toBe('https://pmkisan.gov.in');
    expect(pmk!.lastUpdated).toBeInstanceOf(Date);
    expect(pmk!.lastUpdated.toISOString()).toBe(
      new Date('2025-01-15T00:00:00Z').toISOString(),
    );

    // Falls back to updatedAt when lastVerifiedAt is null.
    expect(ab!.lastUpdated.toISOString()).toBe(
      new Date('2025-02-01T00:00:00Z').toISOString(),
    );
  });

  it('calls OpenAI with the configured model and includes the context block', async () => {
    await assistant.answerQuery('Explain PM Kisan', 'session-1');
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
    const args = openai.chat.completions.create.mock.calls[0]![0];
    expect(args.model).toBe(ANSWER_MODEL);
    const userMessage = args.messages.at(-1)!;
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toContain('PM Kisan provides INR 6,000');
    expect(userMessage.content).toContain('Question: Explain PM Kisan');
  });

  it('appends each exchange to the conversation store', async () => {
    await assistant.answerQuery('Q1', 'session-1');
    await assistant.answerQuery('Q2', 'session-1');
    const history = await conversationStore.getHistory('session-1');
    expect(history).toHaveLength(2);
    expect(history[0]!.userQuery).toBe('Q1');
    expect(history[1]!.userQuery).toBe('Q2');
  });

  it('forwards prior exchanges to the LLM as conversation context (Req 6.6)', async () => {
    await assistant.answerQuery('First question', 'session-1');
    await assistant.answerQuery('Follow-up about same scheme', 'session-1');

    const secondCallArgs = openai.chat.completions.create.mock.calls[1]![0];
    const roles = secondCallArgs.messages.map((m: any) => m.role);
    // system, prev user, prev assistant, current user
    expect(roles[0]).toBe('system');
    expect(roles).toContain('assistant');
    const userMessages = secondCallArgs.messages.filter(
      (m: any) => m.role === 'user',
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('produces unique trace IDs across calls', async () => {
    const a = await assistant.answerQuery('Q1', 'session-1');
    const b = await assistant.answerQuery('Q2', 'session-1');
    expect(a.traceId).not.toBe(b.traceId);
  });

  it('deduplicates citations when multiple chunks come from the same scheme', async () => {
    const matches = [
      highScoreMatch('scheme-1', 'Chunk A about PM Kisan.', 0),
      highScoreMatch('scheme-1', 'Chunk B about PM Kisan.', 1),
      highScoreMatch('scheme-1', 'Chunk C about PM Kisan.', 2),
    ];
    const dedupAssistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('Answer'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    const r = await dedupAssistant.answerQuery('PM Kisan', 'sess', 'en');
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]!.schemeId).toBe('scheme-1');
  });
});

// ─── SchemeAssistant.answerQuery — refusal paths ─────────────────────────────

describe('SchemeAssistant.answerQuery — refusal paths', () => {
  it('refuses off-topic questions without calling the LLM (Req 6.4)', async () => {
    const openai = makeOpenAI('should not be called');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([]),
      prisma: makeSchemeReader([]),
      openai,
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r = await assistant.answerQuery(
      'What is the weather today?',
      'session-1',
      'en',
    );
    expect(r.answer).toBe(REFUSAL_OFF_TOPIC);
    expect(r.sources).toEqual([]);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('refuses when retrieval finds nothing verified (Req 6.3)', async () => {
    const openai = makeOpenAI('should not be called');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([]), // no matches
      prisma: makeSchemeReader([PM_KISAN]),
      openai,
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r = await assistant.answerQuery(
      'What scheme covers crop insurance?',
      'session-1',
      'en',
    );
    expect(r.answer).toBe(REFUSAL_NO_VERIFIED_INFO);
    expect(r.sources).toEqual([]);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('refuses when all retrieved chunks fall below the similarity threshold', async () => {
    const lowScoreMatches: PineconeMatch[] = [
      {
        id: 's1-0',
        score: 0.05,
        metadata: { schemeId: 'scheme-1', chunkText: 'low signal', chunkIndex: 0 },
      },
    ];
    const openai = makeOpenAI('should not be called');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(lowScoreMatches),
      prisma: makeSchemeReader([PM_KISAN]),
      openai,
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r = await assistant.answerQuery(
      'Some scheme question with weak retrieval',
      'session-1',
      'en',
    );
    expect(r.answer).toBe(REFUSAL_NO_VERIFIED_INFO);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });

  it('refuses when retrieved schemes no longer exist in Postgres', async () => {
    const matches = [highScoreMatch('scheme-deleted', 'orphaned chunk')];
    const openai = makeOpenAI('should not be called');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([]), // no matching scheme rows
      openai,
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r = await assistant.answerQuery(
      'Tell me about scheme details',
      'session-1',
      'en',
    );
    expect(r.answer).toBe(REFUSAL_NO_VERIFIED_INFO);
    expect(openai.chat.completions.create).not.toHaveBeenCalled();
  });
});

// ─── SchemeAssistant.answerQuery — invariants ────────────────────────────────

describe('SchemeAssistant.answerQuery — invariants', () => {
  it('clamps the answer to MAX_ANSWER_WORDS (Req 6.8)', async () => {
    const longText = Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([
        highScoreMatch('scheme-1', 'Some scheme content'),
      ]),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI(longText),
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r = await assistant.answerQuery('Tell me about scheme', 'sess', 'en');
    const wordCount = r.answer.split(/\s+/).filter((w) => w.length > 0).length;
    expect(wordCount).toBeLessThanOrEqual(MAX_ANSWER_WORDS);
  });

  it('falls back to the refusal string when the LLM returns empty content', async () => {
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([
        highScoreMatch('scheme-1', 'PM Kisan content'),
      ]),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI(''),
      embeddingsClient: makeEmbeddingsClient(),
    });
    const r = await assistant.answerQuery('Tell me about PM Kisan', 'sess', 'en');
    expect(r.answer).toBe(REFUSAL_NO_VERIFIED_INFO);
  });

  it('responds in the detected language when confidence ≥ 0.8 even if platform language differs (Req 12.3)', async () => {
    // Citizen has selected Hindi as platform language but types the
    // question in pure English. Per Req 12.3 the detected language
    // (English, high confidence) wins; platform language is only the
    // fallback.
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([
        highScoreMatch('scheme-1', 'PM Kisan content'),
      ]),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('answer'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    const r = await assistant.answerQuery(
      'Tell me about PM Kisan eligibility',
      'sess',
      'hi',
    );
    expect(r.language).toBe('en');
  });

  it('falls back to platform language when detection confidence is below 0.8 (Req 12.3)', async () => {
    // Mixed Latin + Devanagari with a scheme keyword. Roughly half the
    // letters fall in each script so neither side reaches the 0.8
    // confidence threshold; the platform language fallback should win.
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([
        highScoreMatch('scheme-1', 'PM Kisan content'),
      ]),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('उत्तर'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    const r = await assistant.answerQuery(
      'scheme योजना', // 6 Latin + 5 Devanagari → confidence ≈ 0.55
      'sess',
      'hi',
    );
    expect(r.language).toBe('hi');
  });

  it('falls back to English when no platform language is supplied and confidence is low (Req 12.3)', async () => {
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([
        highScoreMatch('scheme-1', 'PM Kisan content'),
      ]),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('answer'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    const r = await assistant.answerQuery('scheme योजना', 'sess');
    expect(r.language).toBe('en');
  });

  it('rejects empty query or sessionId', async () => {
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex([]),
      prisma: makeSchemeReader([]),
      openai: makeOpenAI('x'),
      embeddingsClient: makeEmbeddingsClient(),
    });
    await expect(assistant.answerQuery('', 's', 'en')).rejects.toThrow();
    await expect(assistant.answerQuery('q', '', 'en')).rejects.toThrow();
  });
});

// ─── Mid-conversation language switching (Req 12.7) ──────────────────────────

describe('SchemeAssistant.answerQuery — mid-conversation language switches (Req 12.7)', () => {
  it('preserves prior conversation context when the citizen switches language', async () => {
    const matches = [
      highScoreMatch('scheme-1', 'PM Kisan provides INR 6,000 yearly to farmers.'),
    ];
    const conversationStore = new InMemoryConversationStore();
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('Answer about PM Kisan.'),
      embeddingsClient: makeEmbeddingsClient(),
      conversationStore,
    });

    // Turn 1: English
    await assistant.answerQuery(
      'Tell me about PM Kisan eligibility',
      'session-switch',
      'en',
    );
    // Turn 2: Citizen switches to Hindi (both platform language and
    // typed query language flip).
    await assistant.answerQuery(
      'किसान योजना के बारे में और बताइए',
      'session-switch',
      'hi',
    );

    const history = await conversationStore.getHistory('session-switch');
    // History from BOTH turns is preserved across the language switch.
    expect(history).toHaveLength(2);
    expect(history[0]!.language).toBe('en');
    expect(history[0]!.userQuery).toBe('Tell me about PM Kisan eligibility');
    expect(history[1]!.language).toBe('hi');
    expect(history[1]!.userQuery).toBe('किसान योजना के बारे में और बताइए');
  });

  it('responds in the new language from the next interaction onward (Req 12.7)', async () => {
    const matches = [
      highScoreMatch('scheme-1', 'PM Kisan provides INR 6,000 yearly to farmers.'),
    ];
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([PM_KISAN]),
      openai: makeOpenAI('Answer.'),
      embeddingsClient: makeEmbeddingsClient(),
    });

    const r1 = await assistant.answerQuery(
      'What is the PM Kisan scheme?',
      'session-flip',
      'en',
    );
    expect(r1.language).toBe('en');

    // Citizen switches to Hindi: types Hindi text and toggles platform
    // language. The next response language flips to Hindi.
    const r2 = await assistant.answerQuery(
      'मुझे योजना के बारे में बताइए',
      'session-flip',
      'hi',
    );
    expect(r2.language).toBe('hi');

    // Citizen switches to Bengali: detection alone (high confidence)
    // is enough — even without updating platform language the response
    // follows the typed language.
    const r3 = await assistant.answerQuery(
      'সরকারি প্রকল্প সম্পর্কে বলুন',
      'session-flip',
      'hi', // platform language still Hindi
    );
    expect(r3.language).toBe('bn');
  });

  it('forwards the full multi-language history to the LLM after a switch', async () => {
    const matches = [
      highScoreMatch('scheme-1', 'PM Kisan provides INR 6,000 yearly to farmers.'),
    ];
    const openai = makeOpenAI('Reply.');
    const assistant = new SchemeAssistant({
      pineconeIndex: makePineconeIndex(matches),
      prisma: makeSchemeReader([PM_KISAN]),
      openai,
      embeddingsClient: makeEmbeddingsClient(),
    });

    await assistant.answerQuery('First English question', 'sess-multi', 'en');
    await assistant.answerQuery('दूसरा हिंदी प्रश्न', 'sess-multi', 'hi');

    // The second LLM call should include the prior English exchange in
    // its message list (conversation context preserved across switch).
    const secondCallArgs = openai.chat.completions.create.mock.calls[1]![0];
    const userContents = secondCallArgs.messages
      .filter((m: { role: string }) => m.role === 'user')
      .map((m: { content: string }) => m.content);
    expect(userContents.some((c: string) => c.includes('First English question'))).toBe(
      true,
    );
    expect(
      userContents.some((c: string) => c.includes('दूसरा हिंदी प्रश्न')),
    ).toBe(true);

    // System prompt for the second turn instructs the LLM to respond
    // in Hindi (the new language).
    const systemMessage = secondCallArgs.messages[0]!.content;
    expect(systemMessage).toContain('"hi"');
  });
});

// ─── resolveResponseLanguage (Req 12.3) ──────────────────────────────────────

describe('SchemeAssistant.resolveResponseLanguage (Req 12.3)', () => {
  function makeAssistant(): SchemeAssistant {
    return new SchemeAssistant({
      pineconeIndex: makePineconeIndex([]),
      prisma: makeSchemeReader([]),
      openai: makeOpenAI('x'),
      embeddingsClient: makeEmbeddingsClient(),
    });
  }

  it('returns the detected language when confidence ≥ 0.8', () => {
    const assistant = makeAssistant();
    const r = assistant.resolveResponseLanguage(
      'Tell me about farmer welfare schemes today',
      'hi',
    );
    expect(r.language).toBe('en');
    expect(r.detected).toBe('en');
    expect(r.usedFallback).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('returns the platform language when confidence < 0.8', () => {
    const assistant = makeAssistant();
    const r = assistant.resolveResponseLanguage('scheme योजना', 'hi');
    expect(r.language).toBe('hi');
    expect(r.usedFallback).toBe(true);
    expect(r.confidence).toBeLessThan(0.8);
  });

  it('defaults to English when no platform language is supplied and confidence is low', () => {
    const assistant = makeAssistant();
    const r = assistant.resolveResponseLanguage('scheme योजना');
    expect(r.language).toBe('en');
    expect(r.usedFallback).toBe(true);
  });

  it('returns the platform language for empty input (zero-confidence)', () => {
    const assistant = makeAssistant();
    const r = assistant.resolveResponseLanguage('', 'ta');
    expect(r.language).toBe('ta');
    expect(r.usedFallback).toBe(true);
    expect(r.confidence).toBe(0);
  });

  it('honours each of the 6 supported languages when typed in pure script', () => {
    const assistant = makeAssistant();
    const cases: Array<{ query: string; expected: 'en' | 'hi' | 'bn' | 'ta' | 'te' | 'mr' }> = [
      { query: 'farmer welfare schemes available', expected: 'en' },
      { query: 'किसान कल्याण योजनाएं उपलब्ध हैं', expected: 'hi' },
      { query: 'কৃষক কল্যাণ প্রকল্প উপলব্ধ', expected: 'bn' },
      { query: 'விவசாயி நலத் திட்டம் உள்ளது', expected: 'ta' },
      { query: 'రైతు సంక్షేమ పథకం అందుబాటులో ఉంది', expected: 'te' },
      { query: 'शेतकरी कल्याण योजना उपलब्ध आहे ळ', expected: 'mr' },
    ];
    for (const { query, expected } of cases) {
      const r = assistant.resolveResponseLanguage(query, 'en');
      expect(r.language).toBe(expected);
      expect(r.usedFallback).toBe(false);
    }
  });
});
