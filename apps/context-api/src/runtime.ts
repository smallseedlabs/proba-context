import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ConfigError,
  ContextMetrics,
  loadContextConfig,
  loadTemplates,
  type AdminAuthorizer,
  type AuditEmitter,
  type ContextCache,
  type IdentityResolver,
  type ContextConfig,
  type JtiStore,
  type PacketStore,
  type RateLimiter,
  type StepRoundStore,
} from '@smallseedlabs/proba-context-core';
import {
  ActAsAssertionVerifier,
  ActAsIdentityResolver,
  ApproximateTokenizer,
  DownstreamClient,
  FirebaseAdminAuthorizer,
  FirebasePassthroughResolver,
  FirebaseTokenVerifier,
  HubAuthorizeClient,
  LocalIdentityResolver,
  LogAuditEmitter,
  MemoryContextCache,
  MemoryJtiStore,
  MemoryPacketStore,
  MemoryRateLimiter,
  MemoryStepRoundStore,
  RedisContextCache,
  RedisJtiStore,
  RedisPacketStore,
  RedisRateLimiter,
  RedisStepRoundStore,
  SystemClock,
  UnconfiguredIdentityResolver,
  createHttpSources,
  createInProcessSources,
  createRedisStreamAuditEmitter,
  createServiceTokenSigner,
  isLocalIdentityEnabled,
  loadConfigPolicy,
  loadPublicKeySet,
  parseEmailList,
  type WiredHttpSource,
} from '@smallseedlabs/proba-context-adapters';
import type { ContextServices } from './app.js';

export type IdentityModeName =
  | 'local_identity'
  | 'act_as_assertion'
  | 'firebase_passthrough'
  | 'unconfigured';

export interface Runtime {
  services: ContextServices;
  config: ContextConfig;
  identityMode: IdentityModeName;
  auditSink: 'redis_stream' | 'log';
  httpSources: WiredHttpSource[];
  /** Absolute path used to load (and SIGHUP-reload) the config. */
  configPath: string;
  /** Reload config + templates + policy after SIGHUP; keeps cache, metrics and stores. */
  reloadConfig(): void;
  close(): Promise<void>;
}

export type Env = Record<string, string | undefined>;

function hostOf(url: string, defaultPort: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || defaultPort}`;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Wires the pipeline from the config directory and the environment.
 *
 * - Audit: Redis stream when `REDIS_URL` is set; production requires it.
 * - Identity: `act_as_assertion` (default) verifies Hub assertions + Hub authorize; `firebase_passthrough`
 *   verifies Firebase ID tokens when configured; local identity only when `NODE_ENV!=production` and
 *   `identity.allowLocal` / `CONTEXT_ALLOW_LOCAL_IDENTITY`.
 * - Rate limits / jti / packet manifests: Redis in production (memory refused); memory outside production.
 * - Context cache: `cacheStore.backend` memory (LRU) or redis; per-source enable under `sources.*.cache`.
 */
export function createRuntime(env: Env, configPath: string): Runtime {
  let config = loadContextConfig(configPath);
  const configDir = dirname(configPath);
  const clock = new SystemClock();
  const production = env.NODE_ENV === 'production';
  const closers: Array<() => Promise<void>> = [];
  const metrics = new ContextMetrics();
  metrics.setConfigVersion(config.version);

  let policy = loadConfigPolicy(configDir, clock);
  let templates = loadTemplates(join(configDir, 'templates'));

  let audit: AuditEmitter;
  let auditSink: Runtime['auditSink'];
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
    closers.push(() => emitter.close());
  } else if (production) {
    throw new Error('REDIS_URL is required when NODE_ENV=production: audit events must reach the audit stream.');
  } else {
    audit = new LogAuditEmitter(undefined, env.NODE_ENV);
    auditSink = 'log';
  }

  const rateLimitMax = Number(env.CONTEXT_RATE_LIMIT_MAX ?? 60);
  const rateLimitWindowMs = Number(env.CONTEXT_RATE_LIMIT_WINDOW_MS ?? 60_000);
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
    throw new ConfigError('CONTEXT_RATE_LIMIT_MAX', ['must be a positive integer']);
  }
  if (!Number.isInteger(rateLimitWindowMs) || rateLimitWindowMs < 1000) {
    throw new ConfigError('CONTEXT_RATE_LIMIT_WINDOW_MS', ['must be an integer >= 1000']);
  }

  let rateLimiter: RateLimiter;
  let jtiStore: JtiStore;
  let packetStore: PacketStore;
  let stepRoundStore: StepRoundStore;
  if (env.REDIS_URL) {
    rateLimiter = new RedisRateLimiter({ url: env.REDIS_URL, keyPrefix: 'proba:context:rl:' });
    jtiStore = new RedisJtiStore({ url: env.REDIS_URL, keyPrefix: 'proba:context:jti:' });
    packetStore = new RedisPacketStore({ url: env.REDIS_URL, keyPrefix: 'proba:context:packet:' });
    stepRoundStore = new RedisStepRoundStore({ url: env.REDIS_URL, keyPrefix: 'proba:context:step-round:' });
    closers.push(async () => {
      await rateLimiter.close?.();
      await jtiStore.close?.();
      await packetStore.close?.();
      await stepRoundStore.close?.();
    });
  } else if (production) {
    throw new Error('REDIS_URL is required when NODE_ENV=production for rate limits, jti store and packet manifests.');
  } else {
    rateLimiter = new MemoryRateLimiter(clock, env.NODE_ENV);
    jtiStore = new MemoryJtiStore(clock, env.NODE_ENV);
    packetStore = new MemoryPacketStore(env.NODE_ENV);
    stepRoundStore = new MemoryStepRoundStore(env.NODE_ENV);
  }

  const memoryBaseUrl = env.MEMORY_API_BASE_URL?.trim();
  const auditBaseUrl = env.AUDIT_API_BASE_URL?.trim();
  const hubBaseUrl = env.HUB_BASE_URL?.trim();
  const privateKeyFile = env.CONTEXT_SERVICE_PRIVATE_KEY_FILE?.trim();
  const assertionKeyFile = env.HUB_ASSERTION_PUBLIC_KEY_FILE?.trim();

  const wantMemoryAudit = Boolean(memoryBaseUrl && auditBaseUrl);
  const wantHub = Boolean(hubBaseUrl);
  const wantActAs = Boolean(assertionKeyFile && hubBaseUrl);

  if ((wantMemoryAudit || wantHub || wantActAs) && !privateKeyFile) {
    throw new ConfigError('CONTEXT_SERVICE_PRIVATE_KEY_FILE', [
      'required when MEMORY_API_BASE_URL/AUDIT_API_BASE_URL, HUB_BASE_URL or HUB_ASSERTION_PUBLIC_KEY_FILE is set',
    ]);
  }

  let httpSources: WiredHttpSource[] = [];
  let hubClient: DownstreamClient | undefined;
  let tokenSigner: ReturnType<typeof createServiceTokenSigner> | undefined;

  if (privateKeyFile) {
    tokenSigner = createServiceTokenSigner({
      material: loadPemServicePrivateKey(privateKeyFile, env.CONTEXT_SERVICE_KEY_ID),
      clock,
    });
  }

  const http =
    tokenSigner && (wantMemoryAudit || wantHub)
      ? createHttpSources({
          endpoints: {
            ...(wantMemoryAudit && memoryBaseUrl && auditBaseUrl ? { memoryBaseUrl, auditBaseUrl } : {}),
            ...(wantHub && hubBaseUrl ? { hubBaseUrl } : {}),
          },
          allowedHosts: config.allowedDownstreamHosts,
          tokenSigner,
        })
      : undefined;

  if (http) {
    httpSources = http.wired;
    hubClient = http.hubClient;
  }

  const allowLocal = isLocalIdentityEnabled(
    env.NODE_ENV,
    config.identity.allowLocal || truthy(env.CONTEXT_ALLOW_LOCAL_IDENTITY)
  );

  let identity: IdentityResolver;
  let identityMode: IdentityModeName;
  let admin: AdminAuthorizer | undefined;
  const firebaseProjectId = env.FIREBASE_PROJECT_ID?.trim();

  if (config.identity.mode === 'firebase_passthrough') {
    if (!firebaseProjectId) {
      if (production) {
        throw new ConfigError('FIREBASE_PROJECT_ID', [
          'required when identity.mode is firebase_passthrough and NODE_ENV=production',
        ]);
      }
      identity = allowLocal ? new LocalIdentityResolver(() => env.NODE_ENV) : new UnconfiguredIdentityResolver();
      identityMode = allowLocal ? 'local_identity' : 'unconfigured';
    } else {
      const verifier = new FirebaseTokenVerifier({ projectId: firebaseProjectId, clock });
      identity = new FirebasePassthroughResolver({ verifier, enabled: true });
      identityMode = 'firebase_passthrough';
      admin = buildAdminAuthorizer(verifier, env);
    }
  } else if (wantActAs && tokenSigner && hubBaseUrl && assertionKeyFile) {
    const keys = loadPublicKeySet(assertionKeyFile, {
      envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE',
      nodeEnv: env.NODE_ENV,
    });
    if (!hubClient) {
      hubClient = new DownstreamClient({
        name: 'proba-hub',
        baseUrl: hubBaseUrl,
        audience: 'proba-hub',
        allowedHosts: config.allowedDownstreamHosts,
        tokenSigner,
      });
    }
    identity = new ActAsIdentityResolver({
      verifier: new ActAsAssertionVerifier({ keys: keys.keys, clock }),
      jtiStore,
      authorize: new HubAuthorizeClient({
        client: hubClient,
        cache: {
          enabled: config.identity.authorizeCache.enabled,
          ttlSeconds: config.identity.authorizeCache.ttlSeconds,
          clock,
        },
      }),
    });
    identityMode = 'act_as_assertion';
    if (firebaseProjectId) {
      admin = buildAdminAuthorizer(new FirebaseTokenVerifier({ projectId: firebaseProjectId, clock }), env);
    }
  } else if (production) {
    throw new ConfigError('HUB_ASSERTION_PUBLIC_KEY_FILE', [
      'required with HUB_BASE_URL and CONTEXT_SERVICE_PRIVATE_KEY_FILE when NODE_ENV=production and identity.mode is act_as_assertion',
    ]);
  } else if (allowLocal) {
    identity = new LocalIdentityResolver(() => env.NODE_ENV);
    identityMode = 'local_identity';
  } else {
    identity = new UnconfiguredIdentityResolver();
    identityMode = 'unconfigured';
  }

  const corsOrigins = (env.CONTEXT_API_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let sources = createInProcessSources({
    policy: policy.policy,
    tools: policy.tools,
    clock,
    ...(http?.memory ? { memory: http.memory } : {}),
    ...(http?.auditHistory ? { auditHistory: http.auditHistory } : {}),
    ...(http?.analytics ? { analytics: http.analytics } : {}),
    ...(http?.task ? { task: http.task } : {}),
    ...(http?.conversation ? { conversation: http.conversation } : {}),
  });

  const anySourceCacheEnabled = () =>
    Object.values(config.sources).some((s) => s.cache.enabled && s.cache.ttlSeconds > 0);

  let cache: ContextCache;
  if (config.cacheStore.backend === 'redis') {
    if (!env.REDIS_URL) {
      throw new ConfigError('REDIS_URL', ['required when cacheStore.backend is redis']);
    }
    const host = hostOf(env.REDIS_URL, '6379');
    if (!config.allowedDownstreamHosts.includes(host)) {
      throw new ConfigError('REDIS_URL', [`host "${host}" is not in allowedDownstreamHosts`]);
    }
    cache = new RedisContextCache({ url: env.REDIS_URL, nodeEnv: env.NODE_ENV });
    closers.push(() => cache.close?.() ?? Promise.resolve());
  } else {
    const memoryAllowed =
      config.cacheStore.allowMemoryInProduction || !anySourceCacheEnabled();
    if (production && anySourceCacheEnabled() && !config.cacheStore.allowMemoryInProduction) {
      throw new ConfigError('cacheStore.allowMemoryInProduction', [
        'must be true to use the in-process context cache when NODE_ENV=production (each replica keeps its own copy); prefer cacheStore.backend: redis',
      ]);
    }
    cache = new MemoryContextCache({
      clock,
      // Adapter may exist while every source cache is off; refuse only when production would actually use it.
      allowInProduction: memoryAllowed,
      nodeEnv: env.NODE_ENV,
      maxEntries: Math.max(
        1000,
        ...Object.values(config.sources).map((s) => s.cache.maxEntries)
      ),
    });
    closers.push(() => cache.close?.() ?? Promise.resolve());
  }

  const tokenizer = new ApproximateTokenizer();

  const services: ContextServices = {
    identity,
    deps: {
      config,
      templates,
      sources,
      policyGuard: policy.guard,
      tokenizer,
      clock,
      audit,
      stepRoundStore,
      cache,
      metrics,
    },
    rateLimiter,
    rateLimit: { max: rateLimitMax, windowMs: rateLimitWindowMs },
    packetStore,
    cache,
    metrics,
    ...(admin ? { admin } : {}),
    corsOrigins,
    scopeViolationCount: { value: 0 },
  };

  return {
    config,
    identityMode,
    auditSink,
    httpSources,
    configPath,
    services,
    reloadConfig: () => {
      const next = loadContextConfig(configPath);
      if (next.cacheStore.backend !== config.cacheStore.backend) {
        throw new ConfigError('cacheStore.backend', [
          'cannot change cacheStore.backend on SIGHUP; restart the process',
        ]);
      }
      if (
        production &&
        next.cacheStore.backend === 'memory' &&
        Object.values(next.sources).some((s) => s.cache.enabled) &&
        !next.cacheStore.allowMemoryInProduction
      ) {
        throw new ConfigError('cacheStore.allowMemoryInProduction', [
          'must be true to enable the in-process context cache in production',
        ]);
      }
      policy = loadConfigPolicy(configDir, clock);
      templates = loadTemplates(join(configDir, 'templates'));
      sources = createInProcessSources({
        policy: policy.policy,
        tools: policy.tools,
        clock,
        ...(http?.memory ? { memory: http.memory } : {}),
        ...(http?.auditHistory ? { auditHistory: http.auditHistory } : {}),
        ...(http?.analytics ? { analytics: http.analytics } : {}),
        ...(http?.task ? { task: http.task } : {}),
        ...(http?.conversation ? { conversation: http.conversation } : {}),
      });
      config = next;
      metrics.setConfigVersion(config.version);
      services.deps.config = config;
      services.deps.templates = templates;
      services.deps.sources = sources;
      services.deps.policyGuard = policy.guard;
    },
    close: async () => {
      for (const close of closers) await close();
    },
  };
}

function buildAdminAuthorizer(verifier: FirebaseTokenVerifier, env: Env): AdminAuthorizer {
  return new FirebaseAdminAuthorizer({
    verifier,
    policy: {
      allowedEmails: parseEmailList(env.CONTEXT_API_ALLOWED_EMAILS),
      allowedEmailDomains: parseEmailList(env.CONTEXT_API_ALLOWED_EMAIL_DOMAINS),
      adminEmails: parseEmailList(env.CONTEXT_API_ADMIN_EMAILS),
    },
  });
}

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
