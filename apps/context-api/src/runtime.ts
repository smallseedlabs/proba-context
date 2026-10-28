import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  createHttpSources,
  createInProcessSources,
  createRedisStreamAuditEmitter,
  createServiceTokenSigner,
  loadConfigPolicy,
  type WiredHttpSource,
} from '@smallseedlabs/proba-context-adapters';
import type { ContextServices } from './app.js';

export interface Runtime {
  services: ContextServices;
  config: ContextConfig;
  /** How callers are identified, for the start-up log. */
  identityMode: 'local_identity' | 'unconfigured';
  /** Where audit events go, for the start-up log. */
  auditSink: 'redis_stream' | 'log';
  /** Which Phase-2 HTTP sources are wired. */
  httpSources: WiredHttpSource[];
  close(): Promise<void>;
}

export type Env = Record<string, string | undefined>;

function hostOf(url: string, defaultPort: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || defaultPort}`;
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
 * - Phase-2 HTTP sources: memory/audit/analytics when `MEMORY_API_BASE_URL`, `AUDIT_API_BASE_URL`
 *   and `CONTEXT_SERVICE_PRIVATE_KEY_FILE` are set; Hub task/conversation when `HUB_BASE_URL` and
 *   the same private key are set.
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
    const host = hostOf(env.REDIS_URL, '6379');
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

  const memoryBaseUrl = env.MEMORY_API_BASE_URL?.trim();
  const auditBaseUrl = env.AUDIT_API_BASE_URL?.trim();
  const hubBaseUrl = env.HUB_BASE_URL?.trim();
  const privateKeyFile = env.CONTEXT_SERVICE_PRIVATE_KEY_FILE?.trim();

  const wantMemoryAudit = Boolean(memoryBaseUrl && auditBaseUrl);
  const wantHub = Boolean(hubBaseUrl);
  let httpSources: WiredHttpSource[] = [];

  if ((wantMemoryAudit || wantHub) && privateKeyFile) {
    const material = loadPemServicePrivateKey(privateKeyFile, env.CONTEXT_SERVICE_KEY_ID);
    const tokenSigner = createServiceTokenSigner({ material, clock });
    const http = createHttpSources({
      endpoints: {
        ...(wantMemoryAudit && memoryBaseUrl && auditBaseUrl ? { memoryBaseUrl, auditBaseUrl } : {}),
        ...(wantHub && hubBaseUrl ? { hubBaseUrl } : {}),
      },
      allowedHosts: config.allowedDownstreamHosts,
      tokenSigner,
    });
    httpSources = http.wired;

    return {
      config,
      identityMode: production ? 'unconfigured' : 'local_identity',
      auditSink,
      httpSources,
      services: {
        identity,
        deps: {
          config,
          templates,
          sources: createInProcessSources({
            policy: policy.policy,
            tools: policy.tools,
            clock,
            ...(http.memory ? { memory: http.memory } : {}),
            ...(http.auditHistory ? { auditHistory: http.auditHistory } : {}),
            ...(http.analytics ? { analytics: http.analytics } : {}),
            ...(http.task ? { task: http.task } : {}),
            ...(http.conversation ? { conversation: http.conversation } : {}),
          }),
          policyGuard: policy.guard,
          tokenizer: new ApproximateTokenizer(),
          clock,
          audit,
        },
      },
      close: closeAudit,
    };
  }

  if ((wantMemoryAudit || wantHub) && !privateKeyFile) {
    throw new ConfigError('CONTEXT_SERVICE_PRIVATE_KEY_FILE', [
      'required when MEMORY_API_BASE_URL/AUDIT_API_BASE_URL or HUB_BASE_URL is set',
    ]);
  }

  return {
    config,
    identityMode: production ? 'unconfigured' : 'local_identity',
    auditSink,
    httpSources,
    services: {
      identity,
      deps: {
        config,
        templates,
        sources: createInProcessSources({
          policy: policy.policy,
          tools: policy.tools,
          clock,
        }),
        policyGuard: policy.guard,
        tokenizer: new ApproximateTokenizer(),
        clock,
        audit,
      },
    },
    close: closeAudit,
  };
}

/** PEM-only loader for start-up (JWKS private material is supported via `loadServicePrivateKey` in tests). */
function loadPemServicePrivateKey(filePath: string, kidEnv: string | undefined) {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (raw.startsWith('{')) {
    throw new Error(
      'CONTEXT_SERVICE_PRIVATE_KEY_FILE at start-up must be an Ed25519 PEM private key (JWKS private material is supported in tests only).'
    );
  }
  const key = createPrivateKey(raw);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('CONTEXT_SERVICE_PRIVATE_KEY_FILE must be an Ed25519 private key.');
  }
  return { kid: kidEnv?.trim() || 'bridge-key-1', key };
}
