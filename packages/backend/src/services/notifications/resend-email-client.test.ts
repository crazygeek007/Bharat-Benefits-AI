import { describe, expect, it, vi } from 'vitest';
import { ResendEmailClient, createResendEmailClientFromEnv } from './resend-email-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('ResendEmailClient', () => {
  it('rejects construction without an API key', () => {
    expect(() => new ResendEmailClient({ apiKey: '', from: 'a@b.in' })).toThrow(/apiKey/);
  });

  it('rejects construction without a from address', () => {
    expect(() => new ResendEmailClient({ apiKey: 'k', from: '' })).toThrow(/from/);
  });

  it('posts to the Resend endpoint with bearer auth and returns the message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 're_123' }));
    const client = new ResendEmailClient({
      apiKey: 'secret',
      from: 'Bharat <noreply@bharat.in>',
      replyTo: 'help@bharat.in',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.send({
      to: 'citizen@example.com',
      subject: 'Deadline approaching',
      body: 'Apply by tomorrow.',
    });

    expect(result).toEqual({ messageId: 're_123', success: true, error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Bharat <noreply@bharat.in>',
      to: 'citizen@example.com',
      subject: 'Deadline approaching',
      text: 'Apply by tomorrow.',
      reply_to: 'help@bharat.in',
    });
  });

  it('reports a failed outcome on non-2xx responses', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }));
    const client = new ResendEmailClient({
      apiKey: 'k',
      from: 'a@b.in',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.send({ to: 'x@y.in', subject: 's', body: 'b' });
    expect(result.success).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toMatch(/429/);
  });

  it('reports the thrown error message when fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const client = new ResendEmailClient({
      apiKey: 'k',
      from: 'a@b.in',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.send({ to: 'x@y.in', subject: 's', body: 'b' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('socket hang up');
  });

  it('factory returns null when env vars are missing', () => {
    const prevKey = process.env.RESEND_API_KEY;
    const prevFrom = process.env.RESEND_FROM;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    try {
      expect(createResendEmailClientFromEnv()).toBeNull();
    } finally {
      if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
      if (prevFrom !== undefined) process.env.RESEND_FROM = prevFrom;
    }
  });

  it('factory builds a client when both env vars are present', () => {
    const prevKey = process.env.RESEND_API_KEY;
    const prevFrom = process.env.RESEND_FROM;
    process.env.RESEND_API_KEY = 're_test';
    process.env.RESEND_FROM = 'noreply@bharat.in';
    try {
      const client = createResendEmailClientFromEnv();
      expect(client).toBeInstanceOf(ResendEmailClient);
    } finally {
      if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
      else delete process.env.RESEND_API_KEY;
      if (prevFrom !== undefined) process.env.RESEND_FROM = prevFrom;
      else delete process.env.RESEND_FROM;
    }
  });
});
