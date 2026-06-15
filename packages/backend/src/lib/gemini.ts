/**
 * Google Gemini adapter that implements the same interfaces used by
 * the Scheme Assistant (ChatCompletionsClient) and Embedding Generator
 * (EmbeddingsClient), allowing a drop-in swap from OpenAI to Gemini.
 *
 * Environment variables:
 *   - GEMINI_API_KEY: Google AI Studio API key
 *   - GEMINI_CHAT_MODEL: Chat model (default: gemini-2.0-flash)
 *   - GEMINI_EMBEDDING_MODEL: Embedding model (default: text-embedding-004)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ChatCompletionsClient } from '../services/assistant/scheme-assistant';
import type { EmbeddingsClient } from '../services/crawler/embeddings';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_CHAT_MODEL = 'gemini-2.0-flash';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

/** Target output dimension. Gemini embedding-001 outputs 3072, but we truncate to this to match the Pinecone index. */
const TARGET_EMBEDDING_DIMENSION = 768;

function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      'GEMINI_API_KEY environment variable is required for AI features',
    );
  }
  return key.trim();
}

// ─── Gemini Chat Completions Adapter ─────────────────────────────────────────

/**
 * Wraps Google Gemini to satisfy the `ChatCompletionsClient` interface.
 * Maps OpenAI-style messages (system/user/assistant) to Gemini's format.
 */
export function createGeminiChatClient(): ChatCompletionsClient {
  const genAI = new GoogleGenerativeAI(getGeminiApiKey());
  const modelName = process.env.GEMINI_CHAT_MODEL || DEFAULT_CHAT_MODEL;

  return {
    chat: {
      completions: {
        async create(args) {
          const model = genAI.getGenerativeModel({ model: modelName });

          // Extract system instruction from messages
          const systemMessages = args.messages.filter((m) => m.role === 'system');
          const nonSystemMessages = args.messages.filter((m) => m.role !== 'system');

          // Build Gemini chat history (all messages except the last user message)
          const history = nonSystemMessages.slice(0, -1).map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }));

          // The last message is the current user prompt
          const lastMessage = nonSystemMessages[nonSystemMessages.length - 1];
          const userPrompt = lastMessage?.content || '';

          // System instruction goes as a prefix to the conversation
          const systemInstruction = systemMessages.map((m) => m.content).join('\n\n');

          const chat = model.startChat({
            history,
            ...(systemInstruction
              ? { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } }
              : {}),
            generationConfig: {
              temperature: args.temperature ?? 0.3,
              maxOutputTokens: args.max_tokens ?? 1024,
            },
          });

          const result = await chat.sendMessage(userPrompt);
          const responseText = result.response.text();

          return {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: responseText,
                },
              },
            ],
          };
        },
      },
    },
  };
}

// ─── Gemini Embeddings Adapter ───────────────────────────────────────────────

/**
 * Wraps Google Gemini's embedding API to satisfy the `EmbeddingsClient`
 * interface. Uses `text-embedding-004` which produces 768-dimensional vectors.
 *
 * Note: Gemini's embedding dimension (768) differs from OpenAI's (1536).
 * If your Pinecone index is configured for 1536 dimensions, you'll need
 * to recreate it with 768 dimensions, or pad the embeddings.
 */
export function createGeminiEmbeddingsClient(): EmbeddingsClient {
  const genAI = new GoogleGenerativeAI(getGeminiApiKey());
  const modelName = process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

  return {
    embeddings: {
      async create(args) {
        const model = genAI.getGenerativeModel({ model: modelName });
        const input = Array.isArray(args.input) ? args.input[0] : args.input;

        const result = await model.embedContent(input);
        // Truncate to target dimension (Matryoshka-style — first N dims retain quality)
        const embedding = result.embedding.values.slice(0, TARGET_EMBEDDING_DIMENSION);

        return {
          data: [{ embedding }],
        };
      },
    },
  };
}

// ─── Singleton instances ─────────────────────────────────────────────────────

let chatClient: ChatCompletionsClient | null = null;
let embeddingsClient: EmbeddingsClient | null = null;

export function getGeminiChatClient(): ChatCompletionsClient {
  if (!chatClient) {
    chatClient = createGeminiChatClient();
  }
  return chatClient;
}

export function getGeminiEmbeddingsClient(): EmbeddingsClient {
  if (!embeddingsClient) {
    embeddingsClient = createGeminiEmbeddingsClient();
  }
  return embeddingsClient;
}

export function resetGeminiClients(): void {
  chatClient = null;
  embeddingsClient = null;
}
