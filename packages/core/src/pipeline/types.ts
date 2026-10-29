import type {
  AnalyticsSource,
  AuditEmitter,
  AuditHistorySource,
  Clock,
  ConversationSource,
  MemorySource,
  PolicyGuard,
  PolicySource,
  StepRoundStore,
  TaskStateSource,
  ToolCatalogSource,
  Tokenizer,
} from '../ports/index.js';
import type { ContextConfig, Template } from '../config/index.js';
import type { StepType } from '../protocol.js';

/** One source per section kind. */
export interface PipelineSources {
  policy: PolicySource;
  task: TaskStateSource;
  conversation: ConversationSource;
  memory: MemorySource;
  auditHistory: AuditHistorySource;
  analytics: AnalyticsSource;
  tools: ToolCatalogSource;
}

export interface PipelineDeps {
  config: ContextConfig;
  /** One template per step type (see `loadTemplates`). */
  templates: ReadonlyMap<StepType, Template>;
  sources: PipelineSources;
  policyGuard: PolicyGuard;
  tokenizer: Tokenizer;
  clock: Clock;
  audit: AuditEmitter;
  /** Id generator for packet and audit event ids. Defaults to random UUIDs. */
  newId?: () => string;
  /** Value of the `service` field of audit events. Defaults to `proba-context`. */
  serviceName?: string;
  /**
   * Stores the latest packet sections per step so a needs round can extend it and so
   * `needs.maxRoundsPerStep` can be enforced. Required for the hybrid needs loop.
   */
  stepRoundStore?: StepRoundStore;
}
