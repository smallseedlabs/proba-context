import { describe, expect, it } from 'vitest';
import { DownstreamClient } from './downstreamClient.js';
import { DownstreamHostRefusedError, SourceAdapterError } from './errors.js';
import { createServiceTokenSigner } from './serviceToken.js';
import { generateKeyPairSync } from 'node:crypto';

function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createServiceTokenSigner({
    material: { kid: 'k', key: privateKey },
    clock: { now: () => new Date('2026-10-28T12:00:00.000Z') },
  });
}

describe('DownstreamClient', () => {
  it('refuses a base URL that is not on the allow-list', () => {
    expect(
      () =>
        new DownstreamClient({
          name: 'x',
          baseUrl: 'http://evil.example',
          audience: 'proba-memory',
          allowedHosts: ['memory.test'],
          tokenSigner: signer(),
        })
    ).toThrow(DownstreamHostRefusedError);
  });

  it('retries then surfaces source_error on persistent 503', async () => {
    let attempts = 0;
    const client = new DownstreamClient({
      name: 'proba-memory',
      baseUrl: 'http://memory.test',
      audience: 'proba-memory',
      allowedHosts: ['memory.test'],
      tokenSigner: signer(),
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => undefined, random: () => 0 },
      fetch: async () => {
        attempts += 1;
        return new Response('{}', { status: 503 });
      },
    });
    await expect(
      client.request({ method: 'GET', path: '/v1/profiles', actAsAssertion: 'token', query: { actorId: 'a', workspaceId: 'w' } })
    ).rejects.toBeInstanceOf(SourceAdapterError);
    expect(attempts).toBe(3);
  });

  it('caps oversized responses', async () => {
    const client = new DownstreamClient({
      name: 'proba-memory',
      baseUrl: 'http://memory.test',
      audience: 'proba-memory',
      allowedHosts: ['memory.test'],
      tokenSigner: signer(),
      maxResponseBytes: 16,
      retry: { maxRetries: 0 },
      fetch: async () => new Response('{"x":"' + 'y'.repeat(100) + '"}', { status: 200 }),
    });
    await expect(
      client.request({ method: 'GET', path: '/v1/profiles', actAsAssertion: 'token' })
    ).rejects.toMatchObject({ gapCode: 'source_error' });
  });
});
