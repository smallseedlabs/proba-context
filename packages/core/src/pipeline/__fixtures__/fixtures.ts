/**
 * Fixtures for pipeline tests: in-process sources that return what a test hands them, a recording audit
 * emitter and a fixed clock. Not exported from the package and excluded from the build.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContextConfig, loadPolicyFile, loadTemplates, type ContextConfig } from '../../config/index.js';
import type {
  AnalyticsSource,
  AuditEmitter,
  AuditHistorySource,
  Clock,
  ConversationSource,
  MemorySource,
  PolicyGuard,
  PolicySource,
  ResolvedIdentity,
  SourceQuery,
  SourceResult,
  StepRoundRecord,
  StepRoundStore,
  TaskStateSource,
  Tokenizer,
  ToolCatalogSource,
} from '../../ports/index.js';
import type { AuditEventInput, ContextItem, ContextRequest, SectionKind, StepType } from '../../protocol.js';
import type { PipelineDeps, PipelineSources } from '../types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const configDir = join(repoRoot, 'config');

export const IDS = {
  trace: '550e8400-e29b-41d4-a716-446655440000',
  user: '660e8400-e29b-41d4-a716-446655440001',
  goal: '770e8400-e29b-41d4-a716-446655440002',
  thread: '880e8400-e29b-41d4-a716-446655440003',
  otherUser: '660e8400-e29b-41d4-a716-446655440099',
  workspace: 'seedbed',
} as const;

export const OBSERVED_AT = '2026-10-28T00:00:00.000Z';

export function identity(overrides: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    subject: IDS.user,
    workspaceId: IDS.workspace,
    userId: IDS.user,
    goalId: IDS.goal,
    threadId: IDS.thread,
    scopes: ['context:build'],
    ...overrides,
  };
}

export function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    traceId: IDS.trace,
    workspaceId: IDS.workspace,
    userId: IDS.user,
    goalId: IDS.goal,
    threadId: IDS.thread,
    stepId: 'step-1',
    stepType: 'propose_budget',
    ...overrides,
  };
}

let counter = 0;
export function item(source: string, overrides: Partial<ContextItem> & { text?: string } = {}): ContextItem {
  counter += 1;
  return {
    itemId: `${source}-${counter}`,
    sourceRef: { source, id: `${source}-ref-${counter}` },
    trust: 'derived',
    text: `${source} item ${counter}`,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

export class RecordingAuditEmitter implements AuditEmitter {
  readonly events: AuditEventInput[] = [];
  fail = false;

  async emit(event: AuditEventInput): Promise<void> {
    if (this.fail) throw new Error('audit unavailable');
    this.events.push(event);
  }

  get actions(): string[] {
    return this.events.map((e) => e.action);
  }
}

export const fixedClock: Clock = { now: () => new Date(OBSERVED_AT) };

export function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  };
}

/** One character is one token: exact and easy to reason about in budget tests. */
export const charTokenizer: Tokenizer = { count: (text) => text.length };

export type Behaviour = SourceResult | Error | 'hang' | ((query: SourceQuery) => SourceResult | Promise<SourceResult>);

/** In-process sources: each section kind answers what the test set for it, and nothing by default. */
export class FixtureSources {
  readonly behaviour = new Map<string, Behaviour>();
  readonly calls: string[] = [];

  set(key: SectionKind | string, value: Behaviour): this {
    this.behaviour.set(key, value);
    return this;
  }

  items(key: SectionKind | string, items: ContextItem[]): this {
    return this.set(key, { items });
  }

  private async answer(key: string, query: SourceQuery): Promise<SourceResult> {
    this.calls.push(key);
    const b = this.behaviour.get(key) ?? this.behaviour.get(key.split('.')[0] as string) ?? { items: [] };
    if (b === 'hang') {
      return new Promise<SourceResult>((_, reject) => {
        query.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (b instanceof Error) throw b;
    if (typeof b === 'function') return b(query);
    return { items: [...b.items] };
  }

  asSources(): PipelineSources {
    const a = (key: string) => (query: SourceQuery) => this.answer(key, query);
    const policy: PolicySource = { fetchPolicy: a('policy') };
    const task: TaskStateSource = { fetchTaskState: a('task') };
    const conversation: ConversationSource = {
      fetchRecent: (q) => this.answer('conversation', q),
      fetchBefore: (q) => this.answer('conversation.before', q),
    };
    const memory: MemorySource = {
      recall: (q) => this.answer('memory', q),
      search: (q) => this.answer('memory.search', q),
    };
    const auditHistory: AuditHistorySource = {
      fetchRecent: (q) => this.answer('audit_history', q),
      fetchTrace: (q) => this.answer('audit_history.trace', q),
    };
    const analytics: AnalyticsSource = {
      overview: (q) => this.answer('analytics', q),
      compare: (q) => this.answer('analytics.compare', q),
    };
    const tools: ToolCatalogSource = { fetchTools: a('tools') };
    return { policy, task, conversation, memory, auditHistory, analytics, tools };
  }
}

/** Policy guard read from the shipped config/policy.yaml. */
export function fileGuard(): PolicyGuard {
  const policy = loadPolicyFile(join(configDir, 'policy.yaml'));
  return {
    checkNeed: (stepType: StepType, kind: string) => {
      const hit = policy.restrictedNeeds.find((r) => r.kind === kind && r.appliesTo.includes(stepType));
      return hit ? { allowed: false, reason: hit.reason } : { allowed: true };
    },
    isToolAllowed: (stepType: StepType, name: string) =>
      !policy.restrictedTools.some((r) => r.name === name && r.appliesTo.includes(stepType)),
  };
}

export function loadFixtureConfig(): ContextConfig {
  return loadContextConfig(join(configDir, 'context.config.yaml'));
}

/** In-process step-round store for pipeline tests. */
export class FixtureStepRoundStore implements StepRoundStore {
  readonly records = new Map<string, StepRoundRecord>();

  async get(key: string): Promise<StepRoundRecord | undefined> {
    return this.records.get(key);
  }

  async put(record: StepRoundRecord): Promise<void> {
    this.records.set(record.key, record);
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

export interface Harness {
  deps: PipelineDeps;
  sources: FixtureSources;
  audit: RecordingAuditEmitter;
  stepRounds: FixtureStepRoundStore;
}

export function harness(configure?: (config: ContextConfig) => void): Harness {
  const config = loadFixtureConfig();
  configure?.(config);
  const sources = new FixtureSources();
  const audit = new RecordingAuditEmitter();
  const stepRounds = new FixtureStepRoundStore();
  const ids = counterIds();
  return {
    sources,
    audit,
    stepRounds,
    deps: {
      config,
      templates: loadTemplates(join(configDir, 'templates')),
      sources: sources.asSources(),
      policyGuard: fileGuard(),
      tokenizer: charTokenizer,
      clock: fixedClock,
      audit,
      newId: ids,
      stepRoundStore: stepRounds,
    },
  };
}

/** Policy, task and tools items that satisfy a propose_budget build. Fixed ids, so builds are comparable. */
export function requiredItems(sources: FixtureSources): void {
  sources.items('policy', [
    {
      itemId: 'policy.spend-approval',
      sourceRef: { source: 'policy', id: 'spend-approval' },
      trust: 'system',
      text: 'Spend above 100 GBP per day needs explicit user approval.',
      observedAt: OBSERVED_AT,
    },
  ]);
  sources.items('task', [
    {
      itemId: 'task.goal',
      sourceRef: { source: 'hub.task', id: IDS.goal },
      trust: 'system',
      data: { status: 'active', currency: 'GBP' },
      observedAt: OBSERVED_AT,
    },
  ]);
  sources.items('tools', [
    {
      itemId: 'tool.propose_budget',
      sourceRef: { source: 'tools', id: 'propose_budget' },
      trust: 'system',
      text: 'Propose a daily budget.',
      data: { name: 'propose_budget', risk: 'low' },
      observedAt: OBSERVED_AT,
    },
  ]);
}
