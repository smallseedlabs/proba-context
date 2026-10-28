import { describe, expect, it } from 'vitest';
import { buildContext } from './buildContext.js';
import { IDS, OBSERVED_AT, harness, identity, request, requiredItems } from './__fixtures__/fixtures.js';

/** The raise-the-budget walkthrough in docs/WALKTHROUGH_RAISE_BUDGET.md. */
describe('walkthrough: raise the budget', () => {
  it('builds a propose_budget packet with an analytics gap, a redacted email and the documented audit sequence', async () => {
    const h = harness();
    requiredItems(h.sources);
    h.sources.items('conversation', [
      {
        itemId: 'msg-1',
        sourceRef: { source: 'hub.thread', id: 'msg-1' },
        trust: 'user',
        text: 'Raise the budget to 150 a day. Send the receipt to jane.doe@example.com.',
        observedAt: OBSERVED_AT,
      },
    ]);
    // analytics returns nothing for this goal

    const packet = await buildContext(h.deps, request({ stepId: 'step-propose-budget-1' }), identity());

    expect(packet.gaps).toEqual([
      expect.objectContaining({
        code: 'no_analytics_for_campaign',
        source: 'analytics',
        suggestedQuestion: expect.any(String),
      }),
    ]);

    const text = packet.sections.find((s) => s.kind === 'conversation')?.items[0]?.text;
    expect(text).toBe('Raise the budget to 150 a day. Send the receipt to [REDACTED:email].');

    expect(h.audit.actions).toEqual([
      'context.requested',
      'context.source_fetched', // policy
      'context.source_fetched', // task
      'context.source_fetched', // conversation
      'context.source_fetched', // memory
      'context.source_fetched', // analytics
      'context.source_fetched', // tools
      'context.gap_detected',
      'context.built',
    ]);
    expect(h.audit.events.filter((e) => e.action === 'context.source_fetched').map((e) => (e.details as { source: string }).source)).toEqual([
      'policy',
      'task',
      'conversation',
      'memory',
      'analytics',
      'tools',
    ]);
    expect(h.audit.events.find((e) => e.action === 'context.gap_detected')?.details).toMatchObject({
      gapCode: 'no_analytics_for_campaign',
      source: 'analytics',
    });
    expect(h.audit.events.at(-1)?.details).toMatchObject({
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      counts: { gaps: 1, redactions: 1 },
    });
    expect(JSON.stringify(h.audit.events)).not.toContain('jane.doe');
    expect(JSON.stringify(h.audit.events)).not.toContain(IDS.otherUser);
  });
});
