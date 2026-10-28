import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contextPacketSchema, contextRequestSchema, validateContextPacket, validateContextRequest } from './protocol.js';

// The protocol package publishes its context examples under docs/context.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const protocolRoot = join(repoRoot, 'node_modules/@smallseedlabs/proba-protocol');
const example = (name: string): unknown => JSON.parse(readFileSync(join(protocolRoot, 'docs/context', name), 'utf8'));

describe('protocol context contract', () => {
  it('validates the published ContextRequest example', () => {
    expect(contextRequestSchema.safeParse(example('context-request.example.json')).success).toBe(true);
    expect(validateContextRequest(example('context-request.example.json')).success).toBe(true);
  });

  it('validates the published ContextPacket example', () => {
    expect(contextPacketSchema.safeParse(example('context-packet.example.json')).success).toBe(true);
    expect(validateContextPacket(example('context-packet.example.json')).success).toBe(true);
  });

  it('rejects a request without a trace id', () => {
    const { traceId: _traceId, ...rest } = example('context-request.example.json') as Record<string, unknown>;
    expect(validateContextRequest(rest).success).toBe(false);
  });

  it('rejects a packet whose hash is not SHA-256 hex', () => {
    const packet = { ...(example('context-packet.example.json') as Record<string, unknown>), packetHash: 'not-a-hash' };
    expect(validateContextPacket(packet).success).toBe(false);
  });
});
