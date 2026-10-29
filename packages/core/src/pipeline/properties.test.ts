import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SOURCE_NAMES } from '../config/index.js';
import { computePacketHash } from '../hash/packetHash.js';
import type { ContextItem, SectionKind } from '../protocol.js';
import { buildContext } from './buildContext.js';
import { REQUIRED_SECTIONS } from './sections.js';
import { IDS, OBSERVED_AT, harness, identity, request, requiredItems } from './__fixtures__/fixtures.js';

const OPTIONAL: SectionKind[] = ['conversation', 'memory', 'audit_history', 'analytics'];

const itemArb = (kind: SectionKind, index: number): fc.Arbitrary<ContextItem> =>
  fc
    .record({
      length: fc.integer({ min: 1, max: 400 }),
      score: fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
      minute: fc.integer({ min: 0, max: 59 }),
    })
    .map(({ length, score, minute }) => ({
      itemId: `${kind}-${index}`,
      sourceRef: { source: kind, id: `${kind}-ref-${index}` },
      trust: 'derived' as const,
      text: 'x'.repeat(length),
      observedAt: `2026-10-28T00:${String(minute).padStart(2, '0')}:00.000Z`,
      ...(score !== undefined ? { score } : {}),
    }));

const optionalItemsArb = fc.record(
  Object.fromEntries(
    OPTIONAL.map((kind) => [kind, fc.integer({ min: 0, max: 12 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => itemArb(kind, i))))])
  ) as Record<SectionKind & string, fc.Arbitrary<ContextItem[]>>
);

function sourceKey(kind: SectionKind): string {
  return kind;
}

describe('property: budgeting', () => {
  it('never drops policy, task or tools, never exceeds the budget, and ignores the order sources answer in', async () => {
    await fc.assert(
      fc.asyncProperty(
        optionalItemsArb,
        fc.integer({ min: 700, max: 4000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (optional, budgetTokens, seed) => {
          const build = async (shuffle: boolean) => {
            const h = harness();
            requiredItems(h.sources);
            for (const kind of OPTIONAL) {
              const items = [...(optional[kind] ?? [])];
              if (shuffle) items.reverse().sort((a, b) => ((a.itemId.length * seed) % 7) - ((b.itemId.length * seed) % 7));
              h.sources.items(sourceKey(kind), items);
            }
            return buildContext(h.deps, request({ stepType: 'plan_goal', budgetTokens }), identity());
          };
          const packet = await build(false);
          const shuffled = await build(true);

          // never over budget
          expect(packet.manifest.totals.tokens).toBeLessThanOrEqual(Math.min(budgetTokens, 12000));
          expect(packet.sections.reduce((n, s) => n + s.tokens, 0)).toBe(packet.manifest.totals.tokens);
          // P0 never dropped
          for (const kind of REQUIRED_SECTIONS) {
            const section = packet.sections.find((s) => s.kind === kind);
            expect(section?.items.length).toBe(1);
            expect(packet.manifest.sources[kind]?.dropped).toBe(0);
          }
          // accounting adds up
          expect(packet.manifest.totals.returned).toBe(packet.manifest.totals.included + packet.manifest.totals.dropped);
          // deterministic, whatever order the source returned items in
          expect(shuffled.packetHash).toBe(packet.packetHash);
          const { packetHash, ...rest } = packet;
          expect(packetHash).toBe(computePacketHash(rest));
        }
      ),
      { numRuns: 60 }
    );
  });

  it('trims lower-priority sections before higher-priority ones', async () => {
    await fc.assert(
      fc.asyncProperty(optionalItemsArb, fc.integer({ min: 700, max: 2500 }), async (optional, budgetTokens) => {
        const h = harness((c) => {
          for (const kind of SOURCE_NAMES) c.sources[kind].tokenShare = 0.14;
        });
        requiredItems(h.sources);
        for (const kind of OPTIONAL) h.sources.items(kind, optional[kind] ?? []);
        const packet = await buildContext(h.deps, request({ stepType: 'plan_goal', budgetTokens }), identity());
        const budgetDropped = new Set(
          OPTIONAL.filter((kind) => (packet.manifest.sources[kind]?.droppedReasons.budget ?? 0) > 0)
        );
        // If a section lost items to the budget, every lower-priority section kept nothing.
        const order: SectionKind[] = ['conversation', 'memory', 'audit_history', 'analytics'];
        for (const kind of budgetDropped) {
          for (const lower of order.slice(order.indexOf(kind) + 1)) {
            expect(packet.manifest.sources[lower]?.included).toBe(0);
          }
        }
      }),
      { numRuns: 60 }
    );
  });
});

describe('property: scope', () => {
  const scopeArb = fc.constantFrom<'own' | 'other' | 'absent'>('own', 'other', 'absent');

  it('never lets an item of another workspace or user into the packet', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom<SectionKind>(...OPTIONAL), scopeArb, scopeArb), { maxLength: 24 }),
        async (specs) => {
          const h = harness();
          requiredItems(h.sources);
          const byKind = new Map<SectionKind, ContextItem[]>();
          let violations = 0;
          specs.forEach(([kind, ws, user], i) => {
            const data: Record<string, unknown> = { n: i };
            if (ws !== 'absent') data.workspaceId = ws === 'own' ? IDS.workspace : 'someone-else';
            if (user !== 'absent') data.userId = user === 'own' ? IDS.user : IDS.otherUser;
            if (ws === 'other' || user === 'other') violations += 1;
            const list = byKind.get(kind) ?? [];
            list.push({
              itemId: `${kind}-${i}`,
              sourceRef: { source: kind, id: `ref-${i}` },
              trust: 'derived',
              data,
              observedAt: OBSERVED_AT,
            });
            byKind.set(kind, list);
          });
          for (const [kind, items] of byKind) h.sources.items(kind, items);
          const packet = await buildContext(h.deps, request({ stepType: 'plan_goal', budgetTokens: 12000 }), identity());
          for (const section of packet.sections) {
            for (const item of section.items) {
              const data = item.data as Record<string, unknown> | undefined;
              if (data && 'workspaceId' in data) expect(data.workspaceId).toBe(IDS.workspace);
              if (data && 'userId' in data) expect(data.userId).toBe(IDS.user);
            }
          }
          const dropped = Object.values(packet.manifest.sources).reduce((n, s) => n + (s.droppedReasons.scope_violation ?? 0), 0);
          expect(dropped).toBe(violations);
          expect(h.audit.actions.includes('context.scope_violation')).toBe(violations > 0);
          // the ids of out-of-scope items are not revealed in the manifest
          for (const id of packet.manifest.droppedItemIds) {
            const spec = specs[Number(id.split('-')[1])];
            expect(spec && (spec[1] === 'other' || spec[2] === 'other')).toBe(false);
          }
        }
      ),
      { numRuns: 80 }
    );
  });
});

describe('property: needs', () => {
  it('never serves a restricted need and never exceeds the round or item caps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'memory_search' | 'analytics_compare' | 'audit_trace' | 'conversation_before'>(
          'memory_search',
          'analytics_compare',
          'audit_trace',
          'conversation_before'
        ),
        fc.integer({ min: 1, max: 20 }),
        async (kind, limit) => {
          const h = harness((c) => {
            c.needs.maxRoundsPerStep = 2;
            c.needs.kinds.memory_search.maxItems = 5;
            c.needs.kinds.conversation_before.maxItems = 5;
          });
          requiredItems(h.sources);
          await buildContext(h.deps, request({ stepId: 'prop-needs' }), identity());

          const need =
            kind === 'memory_search'
              ? { kind, query: 'q', limit }
              : kind === 'conversation_before'
                ? { kind, cursor: 'c1', limit }
                : kind === 'analytics_compare'
                  ? { kind, campaignIds: [IDS.goal], metric: 'spend' as const, window: '7d' as const }
                  : { kind, traceId: IDS.trace };

          const packet = await buildContext(h.deps, request({ stepId: 'prop-needs', needs: [need] }), identity());
          const refused = packet.gaps.filter((g) => g.code === 'need_refused_by_policy' || g.code === 'need_out_of_limits');

          if (kind === 'audit_trace') {
            // propose_budget restricts audit_trace
            expect(refused.length).toBeGreaterThanOrEqual(1);
            expect(h.sources.calls).not.toContain('audit_history.trace');
          } else if ((kind === 'memory_search' || kind === 'conversation_before') && limit > 5) {
            expect(refused.some((g) => g.code === 'need_out_of_limits')).toBe(true);
          } else {
            expect(h.audit.actions).toContain('context.need_requested');
          }
          expect(packet.manifest.totals.returned).toBe(packet.manifest.totals.included + packet.manifest.totals.dropped);
        }
      ),
      { numRuns: 40 }
    );
  });
});

describe('property: redaction', () => {
  const secret = ['ghp', '_', 'q'.repeat(36)].join('');
  it('never lets a secret survive into the packet or the audit events', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), fc.constantFrom<SectionKind>(...OPTIONAL), async (a, b, kind) => {
        const h = harness();
        requiredItems(h.sources);
        h.sources.items(kind, [
          {
            itemId: 'x',
            sourceRef: { source: kind, id: 'x' },
            trust: 'derived',
            text: `${a} ${secret} ${b}`,
            data: { nested: { list: [`${a}${secret}`] } },
            observedAt: OBSERVED_AT,
          },
        ]);
        const packet = await buildContext(h.deps, request({ stepType: 'plan_goal', budgetTokens: 12000 }), identity());
        expect(JSON.stringify(packet)).not.toContain(secret);
        expect(JSON.stringify(h.audit.events)).not.toContain(secret);
      }),
      { numRuns: 80 }
    );
  });
});
