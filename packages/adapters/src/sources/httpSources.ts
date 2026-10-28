import type {
  AnalyticsSource,
  AuditHistorySource,
  MemorySource,
} from '@smallseedlabs/proba-context-core';
import { DownstreamClient, type FetchLike } from '../http/downstreamClient.js';
import { CircuitBreaker } from '../http/circuitBreaker.js';
import type { ServiceTokenSigner } from '../http/serviceToken.js';
import { AnalyticsHttpSource } from './analyticsHttpSource.js';
import { AuditHttpSource } from './auditHttpSource.js';
import { MemoryHttpSource } from './memoryHttpSource.js';

export interface HttpSourceEndpoints {
  memoryBaseUrl: string;
  auditBaseUrl: string;
}

export interface CreateHttpSourcesOptions {
  endpoints: HttpSourceEndpoints;
  allowedHosts: readonly string[];
  tokenSigner: ServiceTokenSigner;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface HttpSources {
  memory: MemorySource & { listProfiles?: MemoryHttpSource['listProfiles'] };
  auditHistory: AuditHistorySource;
  analytics: AnalyticsSource & { summary?: AnalyticsHttpSource['summary'] };
  memoryClient: DownstreamClient;
  auditClient: DownstreamClient;
}

/** Builds the three Phase-2 HTTP sources that talk to memory-api and audit-api. Hub sources are not included. */
export function createHttpSources(options: CreateHttpSourcesOptions): HttpSources {
  const memoryClient = new DownstreamClient({
    name: 'proba-memory',
    baseUrl: options.endpoints.memoryBaseUrl,
    audience: 'proba-memory',
    allowedHosts: options.allowedHosts,
    tokenSigner: options.tokenSigner,
    circuit: new CircuitBreaker('proba-memory'),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const auditClient = new DownstreamClient({
    name: 'proba-audit',
    baseUrl: options.endpoints.auditBaseUrl,
    audience: 'proba-audit',
    allowedHosts: options.allowedHosts,
    tokenSigner: options.tokenSigner,
    circuit: new CircuitBreaker('proba-audit'),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const memory = new MemoryHttpSource({ client: memoryClient });
  const auditHistory = new AuditHttpSource({ client: auditClient });
  const analytics = new AnalyticsHttpSource({
    client: auditClient,
    ...(options.now ? { now: options.now } : {}),
  });

  return { memory, auditHistory, analytics, memoryClient, auditClient };
}
