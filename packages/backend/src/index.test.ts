import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './app';

describe('Backend Server', () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it('health endpoint returns ok status', async () => {
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });
});
