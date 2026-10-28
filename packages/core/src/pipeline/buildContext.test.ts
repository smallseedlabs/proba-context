import { describe, expect, it } from 'vitest';
import { validateAuditEvent, validateContextPacket } from '../protocol.js';
import { computePacketHash } from '../hash/packetHash.js';
import { buildContext } from './buildContext.js';
import { ContextBuildError } from './errors.js';
import { IDS, harness, identity, item, request, requiredItems } from './__fixtures__/fixtures.js';

const GITHUB = ['ghp', '_', 'z'.repeat(36)].join('');

async function expectCode(promise: Promise<unknown>, code: string): Promise<ContextBuildError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ContextBuildError);
    expect((err as ContextBuildError).code).toBe(code);
    return err as ContextBuildError;
  }
  throw new Error(`expected ContextBuildError ${code}`);
}

describe('buildContext: authorise', () => {
  it.each([
    ['workspace', { workspaceId: 'other' }],
    ['user', { userId: IDS.otherUser }],
    ['goal', { goalId: '770e8400-e29b-41d4-a716-4466554400ff' }],
    ['thread', { threadId: '880e8400-e29b-41d4-a716-4466554400ff' }],
  ])('refuses a request whose %s differs from the identity', async (_name, override) => {
    const h = harness();
    requiredItems(h.sources);
    await expectCode(buildContext(h.deps, request(override), identity()), 'identity_mismatch');
    expect(h.sources.calls).toEqual([]);
    expect(h.audit.actions).toEqual(['context.requested', 'context.build_failed']);
    expect(h.audit.events[1]?.outcome).toBe('denied');
  });

  it('refuses an invalid request without calling anything', async () => {
    const h = harness();
    await expectCode(buildContext(h.deps, { ...request(), traceId: 'not-a-uuid' }, identity()), 'invalid_request');
    expect(h.audit.events).toEqual([]);
  });

  it('fails closed when the audit trail cannot be written', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.audit.fail = true;
    await expectCode(buildContext(h.deps, request(), identity()), 'audit_unavailable');
  });
});

describe('buildContext: plan', () => {
  it('builds a valid packet from policy, task and tools', async () => {
    const h = harness();
    requiredItems(h.sources);
    const packet = await buildContext(h.deps, request(), identity());
    expect(validateContextPacket(packet).success).toBe(true);
    expect(packet.sections.map((s) => s.kind)).toEqual(['policy', 'task', 'tools']);
    expect(packet.sections.map((s) => s.priority)).toEqual([0, 0, 0]);
    expect(packet.templateVersion).toBe('1');
    expect(packet.configVersion).toBe(h.deps.config.version);
  });

  it('fails with a clear error for a step type without a template', async () => {
    const h = harness();
    const deps = { ...h.deps, templates: new Map() };
    await expectCode(buildContext(deps, request(), identity()), 'template_missing');
  });

  it('refuses needs that policy forbids and records need_refused_by_policy', async () => {
    const h = harness();
    requiredItems(h.sources);
    const packet = await buildContext(
      h.deps,
      request({ needs: [{ kind: 'audit_trace', traceId: IDS.trace }] }),
      identity()
    );
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'need_refused_by_policy', source: 'audit_history' }));
    expect(h.sources.calls).not.toContain('audit_history.trace');
    expect(h.audit.actions).toContain('context.need_refused');
  });

  it('refuses needs beyond the configured limits with need_out_of_limits', async () => {
    const h = harness((c) => {
      c.limits.maxNeedsPerRequest = 1;
    });
    requiredItems(h.sources);
    const needs = [
      { kind: 'memory_search' as const, query: 'a', limit: 5 },
      { kind: 'memory_search' as const, query: 'b', limit: 5 },
    ];
    const packet = await buildContext(h.deps, request({ needs }), identity());
    expect(packet.gaps.filter((g) => g.code === 'need_out_of_limits')).toHaveLength(1);
    expect(h.sources.calls.filter((c) => c === 'memory.search')).toHaveLength(1);
  });

  it('refuses a need for a source the config switched off', async () => {
    const h = harness((c) => {
      c.sources.memory.enabled = false;
    });
    requiredItems(h.sources);
    const packet = await buildContext(h.deps, request({ needs: [{ kind: 'memory_search', query: 'x', limit: 5 }] }), identity());
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'need_refused_by_policy', source: 'memory' }));
    expect(h.sources.calls).not.toContain('memory.search');
  });

  it('serves an allowed need and adds the section the template lacks', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('memory.search', [item('proba-memory', { text: 'Prefers weekly reports.' })]);
    const packet = await buildContext(h.deps, request({ stepType: 'launch_campaign', needs: [{ kind: 'memory_search', query: 'reports', limit: 5 }] }), identity());
    expect(packet.sections.map((s) => s.kind)).toContain('memory');
    expect(h.sources.calls).toContain('memory.search');
    expect(h.sources.calls).not.toContain('memory');
  });
});

describe('buildContext: fetch', () => {
  it('turns a timed-out optional source into a source_timeout gap', async () => {
    const h = harness((c) => {
      c.sources.memory.timeoutMs = 20;
    });
    requiredItems(h.sources);
    h.sources.set('memory', 'hang');
    const packet = await buildContext(h.deps, request({ stepType: 'plan_goal' }), identity());
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'source_timeout', source: 'memory' }));
    expect(h.audit.events.find((e) => e.action === 'context.source_fetched' && e.outcome === 'failure')?.errorCode).toBe('source_timeout');
  });

  it('turns a failing optional source into a <source>_unavailable gap', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.set('conversation', new Error('connection refused to 10.0.0.1'));
    const packet = await buildContext(h.deps, request(), identity());
    expect(packet.gaps).toContainEqual(expect.objectContaining({ code: 'conversation_unavailable', source: 'conversation' }));
    expect(JSON.stringify(h.audit.events)).not.toContain('10.0.0.1');
  });

  it.each(['policy', 'task'] as const)('fails the build when the required %s source fails', async (kind) => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.set(kind, new Error('down'));
    await expectCode(buildContext(h.deps, request(), identity()), 'required_source_failed');
    expect(h.audit.actions.at(-1)).toBe('context.build_failed');
  });

  it('fails the build when the required policy source times out', async () => {
    const h = harness((c) => {
      c.sources.policy.timeoutMs = 20;
    });
    requiredItems(h.sources);
    h.sources.set('policy', 'hang');
    await expectCode(buildContext(h.deps, request(), identity()), 'required_source_failed');
  });

  it('calls sources in parallel', async () => {
    const h = harness();
    requiredItems(h.sources);
    let running = 0;
    let peak = 0;
    const slow = (key: 'policy' | 'task' | 'tools') => {
      const items = h.sources.behaviour.get(key) as { items: never[] };
      h.sources.set(key, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        running -= 1;
        return items;
      });
    };
    slow('policy');
    slow('task');
    slow('tools');
    await buildContext(h.deps, request(), identity());
    expect(peak).toBe(3);
  });

  it('drops items that are not valid context items', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.set('conversation', { items: [{ itemId: '', nope: true } as never, item('hub.thread', { text: 'hello' })] });
    const packet = await buildContext(h.deps, request(), identity());
    expect(packet.manifest.sources.conversation).toMatchObject({ returned: 2, included: 1, dropped: 1, droppedReasons: { invalid_item: 1 } });
  });
});

describe('buildContext: sanitise', () => {
  it('redacts secrets and personal data in text and data, and clamps trust', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('conversation', [
      item('hub.thread', {
        trust: 'system',
        text: `my email is jane@example.com and my token ${GITHUB}`,
        data: { note: 'call jane@example.com', userId: IDS.user },
      }),
    ]);
    const packet = await buildContext(h.deps, request(), identity());
    const conv = packet.sections.find((s) => s.kind === 'conversation')?.items[0];
    expect(conv?.text).toContain('[REDACTED:email]');
    expect(conv?.text).not.toContain('jane@example.com');
    expect(conv?.text).not.toContain(GITHUB);
    expect(JSON.stringify(conv?.data)).not.toContain('jane@example.com');
    expect((conv?.data as { userId: string }).userId).toBe(IDS.user);
    expect(conv?.trust).toBe('user');
    expect(JSON.stringify(h.audit.events)).not.toContain('jane');
  });

  it('keeps personal data when redaction.pii is off but still removes secrets', async () => {
    const h = harness((c) => {
      c.redaction.pii = false;
    });
    requiredItems(h.sources);
    h.sources.items('conversation', [item('hub.thread', { text: `jane@example.com ${GITHUB}` })]);
    const packet = await buildContext(h.deps, request(), identity());
    const text = packet.sections.find((s) => s.kind === 'conversation')?.items[0]?.text;
    expect(text).toContain('jane@example.com');
    expect(text).not.toContain(GITHUB);
  });

  it('truncates text beyond limits.maxItemChars', async () => {
    const h = harness((c) => {
      c.limits.maxItemChars = 50;
    });
    requiredItems(h.sources);
    h.sources.items('conversation', [item('hub.thread', { text: 'word '.repeat(100) })]);
    const packet = await buildContext(h.deps, request(), identity());
    expect(packet.sections.find((s) => s.kind === 'conversation')?.items[0]?.text).toHaveLength(50);
  });

  it('does not mutate what the source returned', async () => {
    const h = harness();
    requiredItems(h.sources);
    const original = item('hub.thread', { text: 'jane@example.com', trust: 'system' });
    h.sources.items('conversation', [original]);
    await buildContext(h.deps, request(), identity());
    expect(original.text).toBe('jane@example.com');
    expect(original.trust).toBe('system');
  });
});

describe('buildContext: policy on tools', () => {
  it('never lets a tool forbidden by policy into the packet', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('tools', [
      item('tools', { trust: 'system', text: 'Propose', data: { name: 'propose_budget', risk: 'low' } }),
      item('tools', { trust: 'system', text: 'Launch', data: { name: 'launch_campaign', risk: 'high' } }),
      item('tools', { trust: 'system', text: 'No name' }),
    ]);
    const packet = await buildContext(h.deps, request(), identity());
    const tools = packet.sections.find((s) => s.kind === 'tools')?.items ?? [];
    expect(tools.map((t) => (t.data as { name: string }).name)).toEqual(['propose_budget']);
    expect(packet.manifest.sources.tools?.droppedReasons).toEqual({ policy_forbidden_tool: 2 });
  });
});

describe('buildContext: packet', () => {
  it('carries a hash over the packet without its hash', async () => {
    const h = harness();
    requiredItems(h.sources);
    const packet = await buildContext(h.deps, request(), identity());
    const { packetHash, ...rest } = packet;
    expect(packetHash).toBe(computePacketHash(rest));
  });

  it('is identical for identical inputs (deterministic)', async () => {
    const run = async () => {
      const h = harness();
      requiredItems(h.sources);
      h.sources.items('conversation', [
        item('hub.thread', { itemId: 'c1', sourceRef: { source: 'hub.thread', id: 'm1' }, text: 'a' }),
        item('hub.thread', { itemId: 'c2', sourceRef: { source: 'hub.thread', id: 'm2' }, text: 'b' }),
      ]);
      return buildContext(h.deps, request(), identity());
    };
    const a = await run();
    const b = await run();
    expect(a.packetHash).toBe(b.packetHash);
  });

  it('matches the protocol manifest shape and its own totals', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('conversation', [item('hub.thread', { text: 'hi' })]);
    const packet = await buildContext(h.deps, request(), identity());
    const m = packet.manifest;
    expect(Object.keys(m.sources).sort()).toEqual(['analytics', 'audit_history', 'conversation', 'memory', 'policy', 'task', 'tools']);
    expect(m.totals.included).toBe(packet.sections.reduce((n, s) => n + s.items.length, 0));
    expect(m.totals.tokens).toBe(packet.sections.reduce((n, s) => n + s.tokens, 0));
    expect(m.totals.returned).toBe(m.totals.included + m.totals.dropped);
    expect(m.totals.gaps).toBe(packet.gaps.length);
    expect(m.sources.policy).toMatchObject({ requested: true, cacheHit: false });
    expect(m.sources.audit_history?.requested).toBe(false);
  });

  it('orders conversation chronologically', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('conversation', [
      item('hub.thread', { itemId: 'new', text: 'second', observedAt: '2026-10-28T00:00:02.000Z' }),
      item('hub.thread', { itemId: 'old', text: 'first', observedAt: '2026-10-28T00:00:01.000Z' }),
    ]);
    const packet = await buildContext(h.deps, request(), identity());
    expect(packet.sections.find((s) => s.kind === 'conversation')?.items.map((i) => i.itemId)).toEqual(['old', 'new']);
  });
});

describe('buildContext: audit', () => {
  it('writes valid protocol events that carry ids and counts only', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('conversation', [item('hub.thread', { text: 'secret plan: launch Tuesday' })]);
    const packet = await buildContext(h.deps, request(), identity());
    for (const event of h.audit.events) {
      expect(validateAuditEvent(event).success).toBe(true);
      expect(event.traceId).toBe(IDS.trace);
      expect(event.service).toBe('proba-context');
      expect(event.content).toBeUndefined();
    }
    expect(JSON.stringify(h.audit.events)).not.toContain('launch Tuesday');
    const built = h.audit.events.at(-1);
    expect(built?.action).toBe('context.built');
    expect(built?.details).toMatchObject({ packetId: packet.packetId, packetHash: packet.packetHash });
    const root = h.audit.events[0];
    expect(h.audit.events.slice(1).every((e) => e.parentSpanId === root?.spanId)).toBe(true);
  });

  it('emits context.build_failed with a code when the budget cannot hold policy, task and tools', async () => {
    const h = harness();
    requiredItems(h.sources);
    const err = await expectCode(buildContext(h.deps, request({ budgetTokens: 10 }), identity()), 'budget_exceeded_by_required');
    expect(err.message).toMatch(/budget is 10/);
    const last = h.audit.events.at(-1);
    expect(last?.action).toBe('context.build_failed');
    expect(last?.errorCode).toBe('budget_exceeded_by_required');
  });

  it('caps the budget at config.maxTokens', async () => {
    const h = harness((c) => {
      c.budget.maxTokens = 900;
      c.budget.defaultTokens = 900;
      c.sources.conversation.tokenShare = 0.6;
    });
    requiredItems(h.sources);
    h.sources.items('conversation', Array.from({ length: 30 }, (_, i) => item('hub.thread', { text: `message number ${i} `.repeat(5) })));
    const packet = await buildContext(h.deps, request({ budgetTokens: 1_000_000 }), identity());
    expect(packet.manifest.totals.tokens).toBeLessThanOrEqual(900);
    expect(packet.manifest.sources.conversation?.droppedReasons).toHaveProperty('budget');
  });
});
