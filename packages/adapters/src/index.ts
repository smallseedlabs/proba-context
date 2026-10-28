/**
 * Adapters: implementations of the ports declared in `@smallseedlabs/proba-context-core`.
 */
export { ApproximateTokenizer } from './tokenizer/approximateTokenizer.js';
export { SystemClock } from './clock/systemClock.js';
export {
  ConfigPolicyGuard,
  ConfigPolicySource,
  ConfigToolCatalogSource,
  loadConfigPolicy,
  type ConfigPolicy,
} from './policy/configPolicy.js';
export {
  FixedEmptySource,
  IdentityTaskSource,
  createInProcessSources,
  type InProcessSourcesOptions,
} from './sources/inProcessSources.js';
export {
  DEFAULT_AUDIT_STREAM,
  RedisStreamAuditEmitter,
  createRedisStreamAuditEmitter,
  type RedisConnectionOptions,
  type RedisStreamAuditEmitterOptions,
  type StreamClient,
} from './audit/redisStreamAuditEmitter.js';
export { LogAuditEmitter, LogAuditEmitterRefusedError, type LineSink } from './audit/logAuditEmitter.js';
export {
  LOCAL_IDENTITY_SCOPES,
  LocalIdentityRefusedError,
  LocalIdentityResolver,
  UnconfiguredIdentityResolver,
  assertLocalIdentityAllowed,
} from './identity/localIdentityResolver.js';
