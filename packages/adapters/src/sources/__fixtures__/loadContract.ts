import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../');

export type ContractFixture = {
  description?: string;
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  };
  response: {
    status: number;
    body: unknown;
  };
};

export function loadUpstreamContract(service: 'memory' | 'audit', name: string): ContractFixture {
  const path = join(repoRoot, 'docs/contracts/upstream', service, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as ContractFixture;
}

/** Canary ids that must never appear in adapter output. */
export const CANARY = {
  otherUserId: 'other-user-00000000-0000-4000-8000-000000000099',
  otherWorkspaceId: 'other-workspace',
  actingUserId: '660e8400-e29b-41d4-a716-446655440001',
  workspaceId: 'seedbed',
  goalId: '770e8400-e29b-41d4-a716-446655440002',
  threadId: '880e8400-e29b-41d4-a716-446655440003',
} as const;
