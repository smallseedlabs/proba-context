import type {
  AnalyticsSource,
  AuditHistorySource,
  ConversationSource,
  MemorySource,
  TaskStateSource,
} from '@smallseedlabs/proba-context-core';
import { DownstreamClient, type FetchLike } from '../http/downstreamClient.js';
import { CircuitBreaker } from '../http/circuitBreaker.js';
import type { ServiceTokenSigner } from '../http/serviceToken.js';
import { AnalyticsHttpSource } from './analyticsHttpSource.js';
import { AuditHttpSource } from './auditHttpSource.js';
import { ConversationHttpSource } from './conversationHttpSource.js';
import { MemoryHttpSource } from './memoryHttpSource.js';
import { TaskStateHttpSource } from './taskStateHttpSource.js';

export interface HttpSourceEndpoints {
  memoryBaseUrl?: string;
  auditBaseUrl?: string;
  hubBaseUrl?: string;
}

export interface CreateHttpSourcesOptions {
  endpoints: HttpSourceEndpoints;
  allowedHosts: readonly string[];
  tokenSigner: ServiceTokenSigner;
  fetch?: FetchLike;
  now?: () => Date;
}

export type WiredHttpSource = 'memory' | 'audit' | 'analytics' | 'task' | 'conversation';

export interface HttpSources {
  memory?: MemorySource & { listProfiles?: MemoryHttpSource['listProfiles'] };
  auditHistory?: AuditHistorySource;
  analytics?: AnalyticsSource & { summary?: AnalyticsHttpSource['summary'] };
  task?: TaskStateSource;
  conversation?: ConversationSource;
  memoryClient?: DownstreamClient;
  auditClient?: DownstreamClient;
  hubClient?: DownstreamClient;
  wired: WiredHttpSource[];
}

/**
 * Builds Phase-2 HTTP sources for the endpoints that are configured.
 * Memory and audit share the private-key signer; Hub task/conversation use `aud=proba-hub`.
 */
export function createHttpSources(options: CreateHttpSourcesOptions): HttpSources {
  const wired: WiredHttpSource[] = [];
  const result: HttpSources = { wired };

  if (options.endpoints.memoryBaseUrl) {
    const memoryClient = new DownstreamClient({
      name: 'proba-memory',
      baseUrl: options.endpoints.memoryBaseUrl,
      audience: 'proba-memory',
      allowedHosts: options.allowedHosts,
      tokenSigner: options.tokenSigner,
      circuit: new CircuitBreaker('proba-memory'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    result.memoryClient = memoryClient;
    result.memory = new MemoryHttpSource({ client: memoryClient });
    wired.push('memory');
  }

  if (options.endpoints.auditBaseUrl) {
    const auditClient = new DownstreamClient({
      name: 'proba-audit',
      baseUrl: options.endpoints.auditBaseUrl,
      audience: 'proba-audit',
      allowedHosts: options.allowedHosts,
      tokenSigner: options.tokenSigner,
      circuit: new CircuitBreaker('proba-audit'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    result.auditClient = auditClient;
    result.auditHistory = new AuditHttpSource({ client: auditClient });
    result.analytics = new AnalyticsHttpSource({
      client: auditClient,
      ...(options.now ? { now: options.now } : {}),
    });
    wired.push('audit', 'analytics');
  }

  if (options.endpoints.hubBaseUrl) {
    const hubClient = new DownstreamClient({
      name: 'proba-hub',
      baseUrl: options.endpoints.hubBaseUrl,
      audience: 'proba-hub',
      allowedHosts: options.allowedHosts,
      tokenSigner: options.tokenSigner,
      circuit: new CircuitBreaker('proba-hub'),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    result.hubClient = hubClient;
    result.task = new TaskStateHttpSource({
      client: hubClient,
      ...(options.now ? { now: options.now } : {}),
    });
    result.conversation = new ConversationHttpSource({ client: hubClient });
    wired.push('task', 'conversation');
  }

  return result;
}
