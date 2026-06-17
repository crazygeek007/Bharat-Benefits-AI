/**
 * Resend email transport — implements the {@link EmailClient} contract
 * over Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Resend was chosen for production email delivery because its API is a
 * single POST with a JSON body and a Bearer token — no SDK, no signing
 * dance, and the Bearer scheme matches every other API client in the
 * backend (no extra deps). We deliberately avoid `import 'resend'` so
 * the package stays lean and the transport remains a thin shell over
 * `fetch`.
 *
 * Configuration (env vars read at construction time):
 *   - `RESEND_API_KEY`   — required. Bearer token issued by Resend.
 *   - `RESEND_FROM`      — required. Verified sender (e.g. "Bharat Benefits <noreply@yourdomain.in>").
 *   - `RESEND_REPLY_TO`  — optional. Single Reply-To address.
 *
 * The factory throws when `RESEND_API_KEY` or `RESEND_FROM` is missing so
 * misconfiguration is caught at boot rather than silently dropping
 * production mail. Callers that explicitly want a no-op (local dev, CI)
 * should use `createLoggingEmailClient` from notification-service.
 */

import type { EmailClient, EmailSendOutcome, EmailSendRequest } from './notification-service';

export interface ResendEmailClientOptions {
  apiKey: string;
  from: string;
  replyTo?: string;
  /** Override the REST endpoint (used by tests). */
  endpoint?: string;
  /** Override fetch (used by tests / for proxying). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend-backed EmailClient. Single-shot only — the retry policy lives in
 * NotificationService.deliverWithRetry, so this transport must not
 * retry on its own (double retry storms double the email volume).
 */
export class ResendEmailClient implements EmailClient {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly replyTo?: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendEmailClientOptions) {
    if (!opts.apiKey) throw new Error('ResendEmailClient requires apiKey');
    if (!opts.from) throw new Error('ResendEmailClient requires from');
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.replyTo = opts.replyTo;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(req: EmailSendRequest): Promise<EmailSendOutcome> {
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: req.to,
          subject: req.subject,
          // Resend accepts either `html` or `text`. The Notification
          // pipeline currently only produces plaintext (deadline
          // reminders, lockout alerts). Switch to `html` here when the
          // pipeline starts emitting templated HTML.
          text: req.body,
          ...(this.replyTo ? { reply_to: this.replyTo } : {}),
        }),
      });

      if (!res.ok) {
        const errorBody = await safeReadBody(res);
        return {
          messageId: null,
          success: false,
          error: `Resend HTTP ${res.status}: ${errorBody}`,
        };
      }

      const data = (await res.json().catch(() => null)) as { id?: string } | null;
      return {
        messageId: data?.id ?? null,
        success: true,
        error: null,
      };
    } catch (err) {
      return {
        messageId: null,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Factory that reads Resend config from process.env. Returns null when
 * `RESEND_API_KEY` or `RESEND_FROM` is unset so callers can fall back to
 * the logging stub without crashing — useful in dev/CI where the
 * provider isn't configured.
 */
export function createResendEmailClientFromEnv(): ResendEmailClient | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) return null;
  return new ResendEmailClient({
    apiKey,
    from,
    replyTo: process.env.RESEND_REPLY_TO,
  });
}
