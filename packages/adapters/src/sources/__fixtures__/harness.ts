import { generateKeyPairSync } from 'node:crypto';
import type { SourceQuery } from '@smallseedlabs/proba-context-core';
import { createServiceTokenSigner, type ServiceTokenSigner } from '../../http/serviceToken.js';
import { DownstreamClient, type FetchLike } from '../../http/downstreamClient.js';
import { CANARY } from './loadContract.js';

export function testSigner(): ServiceTokenSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createServiceTokenSigner({
    material: { kid: 'bridge-key-1', key: privateKey },
    clock: { now: () => new Date('2026-10-28T12:00:00.000Z') },
  });
}

export function actingQuery(overrides: Partial<SourceQuery['identity']> = {}): SourceQuery {
  return {
    identity: {
      subject: CANARY.actingUserId,
      userId: CANARY.actingUserId,
      workspaceId: CANARY.workspaceId,
      goalId: CANARY.goalId,
      threadId: CANARY.threadId,
      scopes: ['context:build'],
      actAsAssertion: 'eyJhbGciOiJFZERTQSJ9.act-as-fixture.sig',
      ...overrides,
    },
    request: {
      traceId: '00000000-0000-4000-8000-000000000000',
      workspaceId: CANARY.workspaceId,
      userId: CANARY.actingUserId,
      goalId: CANARY.goalId,
      threadId: CANARY.threadId,
      stepId: 'step-1',
      stepType: 'propose_budget',
    },
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function clientFor(
  baseUrl: string,
  audience: 'proba-memory' | 'proba-audit' | 'proba-hub',
  fetchImpl: FetchLike,
  allowedHosts = [
    '127.0.0.1:9',
    'proba-memory:3420',
    'proba-audit:3400',
    'proba-hub:3300',
    'memory.test',
    'audit.test',
    'hub.test',
  ]
): DownstreamClient {
  return new DownstreamClient({
    name: audience,
    baseUrl,
    audience,
    allowedHosts,
    tokenSigner: testSigner(),
    fetch: fetchImpl,
    retry: { maxRetries: 0, sleep: async () => undefined },
  });
}

/** Records the last outbound request for assertions on Authorization / X-Act-As / scope params. */
export function recordingFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString());
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}
