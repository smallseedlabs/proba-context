import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stepTypeSchema, type ContextRequest, type SourceQuery, type StepType } from '@smallseedlabs/proba-context-core';
import { loadConfigPolicy } from './configPolicy.js';

const configDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'), 'config');
const clock = { now: () => new Date('2026-10-28T00:00:00.000Z') };

function query(stepType: StepType): SourceQuery {
  const request: ContextRequest = {
    traceId: '550e8400-e29b-41d4-a716-446655440000',
    workspaceId: 'seedbed',
    userId: '660e8400-e29b-41d4-a716-446655440001',
    goalId: '770e8400-e29b-41d4-a716-446655440002',
    threadId: '880e8400-e29b-41d4-a716-446655440003',
    stepId: 's1',
    stepType,
  };
  return {
    request,
    identity: { subject: request.userId, workspaceId: 'seedbed', userId: request.userId, goalId: request.goalId, threadId: request.threadId, scopes: [] },
  };
}

describe('config-file policy adapters', () => {
  const { policy, tools, guard } = loadConfigPolicy(configDir, clock);

  it('serves only the policy statements that apply to the step, as system-trusted items', async () => {
    const { items } = await policy.fetchPolicy(query('propose_budget'));
    expect(items.map((i) => i.itemId)).toEqual(['policy.spend-approval']);
    expect(items[0]).toMatchObject({ trust: 'system', sourceRef: { source: 'policy', id: 'spend-approval' }, observedAt: '2026-10-28T00:00:00.000Z' });
    expect((await policy.fetchPolicy(query('interpret_message'))).items).toEqual([]);
  });

  it('serves only the tools that apply to the step', async () => {
    const names = async (step: StepType) => (await tools.fetchTools(query(step))).items.map((i) => (i.data as { name: string }).name);
    expect(await names('propose_budget')).toEqual(['propose_budget']);
    expect(await names('launch_campaign')).toEqual(['launch_campaign']);
    expect(await names('clarify')).toEqual([]);
  });

  it('never serves a tool the policy restricts for the step', async () => {
    for (const step of stepTypeSchema.options) {
      for (const item of (await tools.fetchTools(query(step))).items) {
        expect(guard.isToolAllowed(step, (item.data as { name: string }).name)).toBe(true);
      }
    }
    expect(guard.isToolAllowed('propose_budget', 'launch_campaign')).toBe(false);
    expect(guard.isToolAllowed('launch_campaign', 'launch_campaign')).toBe(true);
  });

  it('refuses the need kinds the policy restricts for a step', () => {
    expect(guard.checkNeed('propose_budget', 'audit_trace')).toEqual({ allowed: false, reason: expect.any(String) });
    expect(guard.checkNeed('explain_decision', 'audit_trace')).toEqual({ allowed: true });
    expect(guard.checkNeed('propose_budget', 'memory_search')).toEqual({ allowed: true });
  });
});
