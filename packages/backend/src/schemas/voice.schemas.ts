/**
 * Zod schemas for the voice assistant route.
 *
 * The legacy hand-rolled parsing in `voice.routes.ts` performed similar
 * checks; this schema centralises them so they're enforced as a single
 * unit and any future fields can be added by changing one file.
 */

import { z } from 'zod';

/** Maximum accepted base64 audio body length (~5 MB binary). */
export const MAX_AUDIO_BASE64_BYTES = 7 * 1024 * 1024;

const SupportedLanguage = z.enum(['en', 'hi', 'bn', 'ta', 'te', 'mr']);

export const VoiceQueryBodySchema = z.object({
  audio: z
    .string({ required_error: 'audio is required (base64-encoded)' })
    .min(1, 'audio is required (base64-encoded)')
    .max(
      MAX_AUDIO_BASE64_BYTES,
      `audio payload exceeds the ${(MAX_AUDIO_BASE64_BYTES / (1024 * 1024)).toFixed(0)}MB base64 limit`,
    ),
  language: SupportedLanguage,
  sessionId: z
    .string({ required_error: 'sessionId is required' })
    .trim()
    .min(1, 'sessionId is required')
    .max(256),
  /**
   * 1-indexed retry counter. Accepts numbers and numeric strings so the
   * frontend's MediaRecorder client can post either shape; defaults to 1
   * when omitted.
   */
  attempt: z
    .union([z.number().int().min(1), z.string().regex(/^\d+$/, 'attempt must be a positive integer')])
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .default(1),
});

export type VoiceQueryBody = z.infer<typeof VoiceQueryBodySchema>;
