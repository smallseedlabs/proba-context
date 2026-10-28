import { describe, expect, it } from 'vitest';
import type { SourceQuery } from '@smallseedlabs/proba-context-core';
import { FixedEmptySource, IdentityTaskSource } from './inProcessSources.js';

const query = {
  identity: { subject: 'u', workspaceId: 'w', userId: 'u', goalId: 'g', threadId: 't', scopes: [] },
  request: {},
} as unknown as SourceQuery;

describe('in-process sources', () => {
  it('FixedEmptySource answers every call with no items', async () => {
    const s = new FixedEmptySource();
    for (const result of await Promise.all([s.fetchRecent(), s.fetchBefore(), s.recall(), s.search(), s.fetchTrace(), s.overview(), s.compare()])) {
      expect(result).toEqual({ items: [] });
    }
  });

  it('IdentityTaskSource describes the goal from the identity only', async () => {
    const { items } = await new IdentityTaskSource({ now: () => new Date('2026-10-28T00:00:00.000Z') }).fetchTaskState(query);
    expect(items).toEqual([
      {
        itemId: 'task.g',
        sourceRef: { source: 'context.identity', id: 'g' },
        trust: 'system',
        data: { goalId: 'g', threadId: 't', workspaceId: 'w', userId: 'u' },
        observedAt: '2026-10-28T00:00:00.000Z',
      },
    ]);
  });
});
