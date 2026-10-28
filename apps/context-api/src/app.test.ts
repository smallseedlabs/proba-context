import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

describe('GET /health', () => {
  it('reports the service as ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'context-api' });
    await app.close();
  });

  it('serves nothing else yet', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/context' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
