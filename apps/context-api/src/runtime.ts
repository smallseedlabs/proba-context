import { dirname, join } from 'node:path';
import {
  ConfigError,
  loadContextConfig,
  loadTemplates,
  type AuditEmitter,
  type IdentityResolver,
  type ContextConfig,
} from '@smallseedlabs/proba-context-core';
import {
  ApproximateTokenizer,
  LocalIdentityResolver,
  LogAuditEmitter,
  SystemClock,
  UnconfiguredIdentityResolver,
  createInProcessSources,
  createRedisStreamAuditEmitter,
  loadConfigPolicy,
} from '@smallseedlabs/proba-context-adapters';
import type { ContextServices } from './app.js';

export interface Runtime {
  services: ContextServices;
  config: ContextConfig;
  /** How callers are identified, for the start-up log. */
  identityMode: 'local_identity' | 'unconfigured';
  /** Where audit events go, for the start-up log. */
  auditSink: 'redis_stream' | 'log';
  close(): Promise<void>;
}

export type Env = Record<string, string | undefined>;

function hostOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '6379'}`;
}

/**
 * Wires the pipeline from the config directory (`context.config.yaml`, `templates/`, `policy.yaml`,
 * `tools.yaml`) and the environment. Throws {@link ConfigError} or `Error` when something is missing,
 * so a bad deployment stops at start-up.
 *
 * - Audit: events go to the Redis stream when `REDIS_URL` is set (its host must be in
 *   `allowedDownstreamHosts`). Without it, a workstation run logs them; production refuses to start.
 * - Identity: a production process has no identity verification in this phase and answers 503 to
 *   context requests; the local identity resolver is only created outside production.
 */
export function createRuntime(env: Env, configPath: string): Runtime {
  const config = loadContextConfig(configPath);
  const configDir = dirname(configPath);
  const clock = new SystemClock();
  const production = env.NODE_ENV === 'production';

  const policy = loadConfigPolicy(configDir, clock);
  const templates = loadTemplates(join(configDir, 'templates'));

  let audit: AuditEmitter;
  let auditSink: Runtime['auditSink'];
  let closeAudit: () => Promise<void> = async () => undefined;
  if (env.REDIS_URL) {
    const host = hostOf(env.REDIS_URL);
    if (!config.allowedDownstreamHosts.includes(host)) {
      throw new ConfigError('REDIS_URL', [`host "${host}" is not in allowedDownstreamHosts`]);
    }
    const maxStreamLength = Number(env.AUDIT_STREAM_MAXLEN ?? 0);
    const emitter = createRedisStreamAuditEmitter({
      url: env.REDIS_URL,
      clock,
      ...(env.AUDIT_STREAM ? { stream: env.AUDIT_STREAM } : {}),
      ...(Number.isInteger(maxStreamLength) && maxStreamLength > 0 ? { maxStreamLength } : {}),
    });
    audit = emitter;
    auditSink = 'redis_stream';
    closeAudit = () => emitter.close();
  } else if (production) {
    throw new Error('REDIS_URL is required when NODE_ENV=production: audit events must reach the audit stream.');
  } else {
    audit = new LogAuditEmitter(undefined, env.NODE_ENV);
    auditSink = 'log';
  }

  const identity: IdentityResolver = production
    ? new UnconfiguredIdentityResolver()
    : new LocalIdentityResolver(() => env.NODE_ENV);

  return {
    config,
    identityMode: production ? 'unconfigured' : 'local_identity',
    auditSink,
    services: {
      identity,
      deps: {
        config,
        templates,
        sources: createInProcessSources({ policy: policy.policy, tools: policy.tools, clock }),
        policyGuard: policy.guard,
        tokenizer: new ApproximateTokenizer(),
        clock,
        audit,
      },
    },
    close: closeAudit,
  };
}
