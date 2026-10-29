import { describe, expect, it } from 'vitest';
import { validateContextPacket } from '../protocol.js';
import { buildContext } from './buildContext.js';
import { IDS, harness, identity, item, request, requiredItems } from './__fixtures__/fixtures.js';

describe('hybrid needs loop', () => {
  it('serves an allowed memory_search need and audits context.need_requested', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('memory.search', [item('proba-memory', { text: 'Prefers weekly reports.' })]);
    const packet = await buildContext(
      h.deps,
      request({ stepType: 'launch_campaign', needs: [{ kind: 'memory_search', query: 'reports', limit: 5 }] }),
      identity()
    );
    expect(validateContextPacket(packet).success).toBe(true);
    expect(packet.sections.map((s) => s.kind)).toContain('memory');
    expect(h.sources.calls).toContain('memory.search');
    expect(h.audit.actions).toContain('context.need_requested');
    expect(h.audit.events.find((e) => e.action === 'context.need_requested')?.details).toMatchObject({
      needKind: 'memory_search',
      source: 'memory',
    });
  });

  it('refuses needs that policy forbids with a suggested question', async () => {
    const h = harness();
    requiredItems(h.sources);
    const packet = await buildContext(
      h.deps,
      request({ needs: [{ kind: 'audit_trace', traceId: IDS.trace }] }),
      identity()
    );
    expect(packet.gaps).toContainEqual(
      expect.objectContaining({
        code: 'need_refused_by_policy',
        source: 'audit_history',
        suggestedQuestion: expect.any(String),
      })
    );
    expect(h.sources.calls).not.toContain('audit_history.trace');
    expect(h.audit.actions).toContain('context.need_refused');
  });

  it('refuses an analytics window outside the configured allow-list', async () => {
    const h = harness();
    requiredItems(h.sources);
    const packet = await buildContext(
      h.deps,
      request({
        needs: [{ kind: 'analytics_compare', campaignIds: [IDS.goal], metric: 'spend', window: '90d' }],
      }),
      identity()
    );
    expect(packet.gaps).toContainEqual(
      expect.objectContaining({
        code: 'need_out_of_limits',
        source: 'analytics',
        reason: expect.stringContaining('90d'),
      })
    );
    expect(h.sources.calls).not.toContain('analytics.compare');
    expect(h.audit.actions).toContain('context.need_refused');
  });

  it('refuses a need whose limit exceeds the kind hard cap', async () => {
    const h = harness((c) => {
      c.needs.kinds.memory_search.maxItems = 3;
    });
    requiredItems(h.sources);
    const packet = await buildContext(
      h.deps,
      request({ needs: [{ kind: 'memory_search', query: 'x', limit: 10 }] }),
      identity()
    );
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'need_out_of_limits', source: 'memory' }));
    expect(h.sources.calls).not.toContain('memory.search');
  });

  it('enforces maxRoundsPerStep and extends the prior packet', async () => {
    const h = harness((c) => {
      c.needs.maxRoundsPerStep = 2;
    });
    requiredItems(h.sources);

    const base = await buildContext(h.deps, request({ stepId: 'step-rounds' }), identity());
    expect(base.sections.map((s) => s.kind)).toEqual(['policy', 'task', 'tools']);
    expect(h.stepRounds.records.size).toBe(1);

    h.sources.items('memory.search', [
      item('proba-memory', { itemId: 'mem-round-1', text: 'first need result', sourceRef: { source: 'proba-memory', id: 'm1' } }),
    ]);
    const round1 = await buildContext(
      h.deps,
      request({ stepId: 'step-rounds', needs: [{ kind: 'memory_search', query: 'a', limit: 5 }] }),
      identity()
    );
    expect(round1.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId)).toContain('mem-round-1');
    // Prior P0 sections are kept (extension).
    expect(round1.sections.map((s) => s.kind)).toEqual(expect.arrayContaining(['policy', 'task', 'tools', 'memory']));
    expect(h.sources.calls.filter((c) => c === 'policy')).toHaveLength(1); // only the template build

    h.sources.items('memory.search', [
      item('proba-memory', { itemId: 'mem-round-2', text: 'second need result', sourceRef: { source: 'proba-memory', id: 'm2' } }),
    ]);
    const round2 = await buildContext(
      h.deps,
      request({ stepId: 'step-rounds', needs: [{ kind: 'memory_search', query: 'b', limit: 5 }] }),
      identity()
    );
    const memoryIds = round2.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId) ?? [];
    expect(memoryIds).toEqual(expect.arrayContaining(['mem-round-1', 'mem-round-2']));

    const refused = await buildContext(
      h.deps,
      request({ stepId: 'step-rounds', needs: [{ kind: 'memory_search', query: 'c', limit: 5 }] }),
      identity()
    );
    expect(refused.gaps).toContainEqual(
      expect.objectContaining({ code: 'need_out_of_limits', reason: expect.stringContaining('needs rounds') })
    );
    expect(h.audit.actions.filter((a) => a === 'context.need_refused').length).toBeGreaterThanOrEqual(1);
    // Still returns the prior extended packet content.
    expect(refused.sections.find((s) => s.kind === 'memory')?.items.map((i) => i.itemId)).toEqual(
      expect.arrayContaining(['mem-round-1', 'mem-round-2'])
    );
  });

  it('refuses a budgetTokens above the extra token share on a needs round', async () => {
    const h = harness((c) => {
      c.budget.defaultTokens = 1000;
      c.budget.maxTokens = 5000;
      c.needs.extraTokenShare = 0.3;
    });
    requiredItems(h.sources);
    await buildContext(h.deps, request({ stepId: 'step-budget', budgetTokens: 1000 }), identity());
    const packet = await buildContext(
      h.deps,
      request({
        stepId: 'step-budget',
        budgetTokens: 2000,
        needs: [{ kind: 'memory_search', query: 'x', limit: 5 }],
      }),
      identity()
    );
    // base 1000 * 1.3 = 1300; requesting 2000 is refused
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'need_out_of_limits', reason: expect.stringContaining('1300') }));
  });

  it('refuses an audit_trace need that returns only another user\'s items', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('audit_history.trace', [
      item('proba-audit', {
        itemId: 'foreign-span',
        data: { workspaceId: IDS.workspace, userId: IDS.otherUser, action: 'goal.updated' },
      }),
    ]);
    const packet = await buildContext(
      h.deps,
      request({
        stepType: 'explain_decision',
        needs: [{ kind: 'audit_trace', traceId: IDS.trace }],
      }),
      identity()
    );
    expect(packet.gaps).toContainEqual(
      expect.objectContaining({ code: 'need_refused_by_policy', source: 'audit_history', reason: expect.stringContaining('scope') })
    );
    expect(packet.sections.find((s) => s.kind === 'audit_history')?.items ?? []).toEqual([]);
    expect(h.audit.actions).toContain('context.need_refused');
    expect(JSON.stringify(packet)).not.toContain(IDS.otherUser);
  });

  it('is deterministic when extending a prior packet with the same need', async () => {
    const run = async () => {
      const h = harness();
      requiredItems(h.sources);
      await buildContext(h.deps, request({ stepId: 'step-det' }), identity());
      h.sources.items('memory.search', [
        item('proba-memory', {
          itemId: 'mem-det',
          sourceRef: { source: 'proba-memory', id: 'det' },
          text: 'stable',
          score: 1,
        }),
      ]);
      return buildContext(
        h.deps,
        request({ stepId: 'step-det', needs: [{ kind: 'memory_search', query: 'stable', limit: 5 }] }),
        identity()
      );
    };
    const a = await run();
    const b = await run();
    expect(a.packetHash).toBe(b.packetHash);
  });
});
