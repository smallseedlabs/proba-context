import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  ContextBuildError,
  IdentityRejectedError,
  buildAuditEvent,
  buildContext,
  contextRequestSchema,
  generateSpanId,
  getAuditActionInfo,
  listAllowedNeeds,
  stepTypeSchema,
  type AdminAuthorizer,
  type AdminSession,
  type ContextBuildErrorCode,
  type ContextCache,
  type ContextConfig,
  type ContextMetrics,
  type IdentityCredentials,
  type IdentityResolver,
  type PacketStore,
  type PipelineDeps,
  type RateLimiter,
  type ResolvedIdentity,
} from '@smallseedlabs/proba-context-core';

export const SERVICE_NAME = 'context-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  service: typeof SERVICE_NAME;
  configVersion: string;
  checks: Record<string, 'ok' | 'fail'>;
}

/** What the context routes need. */
export interface ContextServices {
  deps: PipelineDeps;
  identity: IdentityResolver;
  rateLimiter: RateLimiter;
  rateLimit: { max: number; windowMs: number };
  packetStore: PacketStore;
  cache: ContextCache;
  metrics: ContextMetrics;
  admin?: AdminAuthorizer;
  /** Empty = CORS disabled (strict default). */
  corsOrigins: string[];
  /** Running total of scope violations observed on this process. */
  scopeViolationCount: { value: number };
}

const BUILD_ERROR_STATUS: Record<ContextBuildErrorCode, number> = {
  invalid_request: 400,
  identity_mismatch: 403,
  template_missing: 422,
  budget_exceeded_by_required: 422,
  required_source_failed: 502,
  audit_unavailable: 503,
  internal_error: 500,
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function credentialsOf(request: FastifyRequest, body?: Record<string, unknown>): IdentityCredentials {
  const credentials: IdentityCredentials = {};
  const authorization = header(request, 'authorization');
  const actAs = header(request, 'x-act-as');
  const local = header(request, 'x-local-identity');
  if (authorization !== undefined) credentials.authorization = authorization;
  if (actAs !== undefined) credentials.actAsAssertion = actAs;
  if (local !== undefined) credentials.localIdentity = local;
  if (body) {
    credentials.scope = {
      ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.goalId === 'string' ? { goalId: body.goalId } : {}),
      ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
    };
  }
  return credentials;
}

/** Request body limit from the config; the Fastify default would let a large body through. */
export function bodyLimitOf(config: ContextConfig): number {
  return config.limits.maxRequestBytes;
}

/** Default ceiling for authenticated context routes (per IP, sliding window). */
export const CONTEXT_ROUTE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

/**
 * Builds the HTTP app. `GET /health` is always served. Context and admin routes register when `services` is given.
 */
export async function buildApp(
  options: FastifyServerOptions = {},
  services?: ContextServices
): Promise<FastifyInstance> {
  const app = Fastify({
    ...(services ? { bodyLimit: bodyLimitOf(services.deps.config) } : {}),
    ...options,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  if (services && services.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: services.corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
    });
  }

  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (statusCode >= 500) {
      app.log.error({ err }, 'request failed');
      return reply.status(500).send({ error: { code: 'internal_error', message: 'The request could not be completed.' } });
    }
    return reply.status(statusCode).send({ error: { code: 'invalid_request', message: err.message } });
  });

  app.get('/health', async (): Promise<HealthResponse> => ({ status: 'ok', service: SERVICE_NAME }));

  if (services) await registerContextRoutes(app, services);
  return app;
}

async function registerContextRoutes(app: FastifyInstance, services: ContextServices): Promise<void> {
  const { deps } = services;

  await app.register(rateLimit, {
    global: false,
    max: CONTEXT_ROUTE_RATE_LIMIT.max,
    timeWindow: CONTEXT_ROUTE_RATE_LIMIT.timeWindow,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  app.get(
    '/ready',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (_request, reply): Promise<ReadyResponse> => {
      const checks: Record<string, 'ok' | 'fail'> = {
        config: services.deps.config.version ? 'ok' : 'fail',
      };
      try {
        await services.cache.ping?.();
        checks.cache = 'ok';
      } catch {
        checks.cache = 'fail';
      }
      const ready = Object.values(checks).every((c) => c === 'ok');
      const body: ReadyResponse = {
        status: ready ? 'ready' : 'not_ready',
        service: SERVICE_NAME,
        configVersion: services.deps.config.version,
        checks,
      };
      return reply.status(ready ? 200 : 503).send(body);
    }
  );

  app.get('/metrics', { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    // Internal/admin: Firebase admin when configured; otherwise open on the loopback network only
    // (Compose binds 127.0.0.1). Do not put user ids or text in labels.
    if (services.admin) {
      const session = await requireAdmin(request, reply, services);
      if (!session) return;
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.status(200).send(services.metrics.render());
  });

  async function authenticate(request: FastifyRequest, body?: Record<string, unknown>): Promise<ResolvedIdentity> {
    return services.identity.resolve(credentialsOf(request, body));
  }

  async function applyCallerLimits(reply: FastifyReply, identity: ResolvedIdentity, callerKey: string): Promise<boolean> {
    const { max, windowMs } = services.rateLimit;
    const caller = await services.rateLimiter.hit(`caller:${callerKey}`, max, windowMs);
    const user = await services.rateLimiter.hit(`user:${identity.userId}`, max, windowMs);
    const decision = !caller.allowed ? caller : !user.allowed ? user : caller;
    reply.header('X-RateLimit-Limit', String(decision.limit)).header('X-RateLimit-Remaining', String(decision.remaining));
    if (!caller.allowed || !user.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      await reply.status(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } });
      return false;
    }
    return true;
  }

  async function auditAuthFailure(
    code: string,
    status: number,
    identity?: Pick<ResolvedIdentity, 'workspaceId' | 'userId' | 'goalId' | 'threadId'>
  ): Promise<void> {
    const info = getAuditActionInfo('auth.denied');
    const event = buildAuditEvent({
      eventId: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      spanId: generateSpanId(),
      workspaceId: identity?.workspaceId ?? 'seedbed',
      ...(identity?.userId ? { userId: identity.userId } : {}),
      ...(identity?.goalId ? { goalId: identity.goalId } : {}),
      ...(identity?.threadId ? { threadId: identity.threadId } : {}),
      actor: { type: 'service', id: SERVICE_NAME },
      service: SERVICE_NAME,
      action: 'auth.denied',
      category: info?.category ?? 'auth',
      ...(info ? { riskLevel: info.riskLevel } : {}),
      outcome: 'denied',
      errorCode: code,
      occurredAt: deps.clock.now().toISOString(),
      details: { counts: { httpStatus: status }, reason: code },
    });
    try {
      await deps.audit.emit(event);
    } catch {
      // Auth failure response still goes out; audit is best-effort for pre-identity denials.
    }
  }

  app.post(
    '/v1/context/build',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      let identity: ResolvedIdentity;
      try {
        identity = await authenticate(request, rawBody);
      } catch (err) {
        return identityFailure(reply, err, (code, status) => auditAuthFailure(code, status));
      }

      if (!(await applyCallerLimits(reply, identity, request.ip))) return;

      const parsed = contextRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: 'The request body is not a valid context request.',
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        });
      }

      try {
        const packet = await buildContext(deps, parsed.data, identity);
        const scopeDrops = Object.values(packet.manifest.sources).reduce(
          (sum, s) => sum + (s.droppedReasons?.scope_violation ?? 0),
          0
        );
        if (scopeDrops > 0) services.scopeViolationCount.value += scopeDrops;

        await services.packetStore.put({
          packetId: packet.packetId,
          packetHash: packet.packetHash,
          workspaceId: packet.workspaceId,
          userId: packet.userId,
          goalId: packet.goalId,
          stepId: packet.stepId,
          configVersion: packet.configVersion,
          templateVersion: packet.templateVersion,
          manifest: packet.manifest,
          createdAt: deps.clock.now().toISOString(),
        });

        return reply.status(200).send(packet);
      } catch (err) {
        if (err instanceof ContextBuildError) {
          if (err.code === 'identity_mismatch') {
            await auditAuthFailure(err.code, 403, identity);
          }
          if (err.code === 'internal_error' || err.code === 'audit_unavailable') {
            app.log.error({ err }, 'context build failed');
          }
          return reply.status(BUILD_ERROR_STATUS[err.code]).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    }
  );

  app.get(
    '/v1/context/needs',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      let identity: ResolvedIdentity;
      try {
        identity = await authenticate(request);
      } catch (err) {
        return identityFailure(reply, err, (code, status) => auditAuthFailure(code, status));
      }
      if (!(await applyCallerLimits(reply, identity, request.ip))) return;

      const step = stepTypeSchema.safeParse((request.query as { stepType?: unknown }).stepType);
      if (!step.success) {
        return reply.status(400).send({
          error: {
            code: 'invalid_request',
            message: `stepType must be one of: ${stepTypeSchema.options.join(', ')}.`,
          },
        });
      }
      const allowedNeeds = listAllowedNeeds(deps.config, deps.policyGuard, step.data);
      return reply.status(200).send({
        stepType: step.data,
        allowedNeeds,
        maxNeedsPerRequest: deps.config.limits.maxNeedsPerRequest,
        maxRoundsPerStep: deps.config.needs.maxRoundsPerStep,
        extraTokenShare: deps.config.needs.extraTokenShare,
      });
    }
  );

  app.get(
    '/v1/context/packets',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const session = await requireAdmin(request, reply, services);
      if (!session) return;

      const query = request.query as { goalId?: string; limit?: string; cursor?: string };
      if (!query.goalId?.trim()) {
        return reply.status(400).send({ error: { code: 'invalid_request', message: 'goalId is required.' } });
      }
      const limit = query.limit ? Number(query.limit) : undefined;
      const listed = await services.packetStore.listByGoal(query.goalId.trim(), {
        ...(Number.isInteger(limit) ? { limit } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      await auditPacketView(deps, session, { goalId: query.goalId, counts: { packets: listed.items.length } });
      return reply.status(200).send({
        items: listed.items.map(manifestOnly),
        ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
      });
    }
  );

  app.get(
    '/v1/context/packets/:packetId',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const session = await requireAdmin(request, reply, services);
      if (!session) return;

      const packetId = (request.params as { packetId: string }).packetId;
      const record = await services.packetStore.get(packetId);
      if (!record) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Packet not found.' } });
      }
      await auditPacketView(deps, session, {
        packetId: record.packetId,
        goalId: record.goalId,
        workspaceId: record.workspaceId,
      });
      return reply.status(200).send(manifestOnly(record));
    }
  );

  app.post(
    '/v1/cache/invalidate',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const session = await requireAdmin(request, reply, services);
      if (!session) return;

      const body = (request.body ?? {}) as { workspaceId?: string; userId?: string; goalId?: string };
      const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
      const goalId = typeof body.goalId === 'string' ? body.goalId.trim() : '';
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
      if (!userId && !goalId) {
        return reply.status(400).send({
          error: { code: 'invalid_request', message: 'Provide userId and/or goalId to invalidate.' },
        });
      }
      const removed = await services.cache.invalidate({
        ...(workspaceId ? { workspaceId } : {}),
        ...(userId ? { userId } : {}),
        ...(goalId ? { goalId } : {}),
      });
      await auditCacheInvalidated(deps, session, {
        ...(workspaceId ? { workspaceId } : {}),
        ...(userId ? { userId } : {}),
        ...(goalId ? { goalId } : {}),
        counts: { removed },
      });
      return reply.status(200).send({ removed });
    }
  );
}

function manifestOnly(record: {
  packetId: string;
  packetHash: string;
  workspaceId: string;
  userId: string;
  goalId: string;
  stepId: string;
  configVersion: string;
  templateVersion: string;
  manifest: unknown;
  createdAt: string;
}) {
  return {
    packetId: record.packetId,
    packetHash: record.packetHash,
    workspaceId: record.workspaceId,
    userId: record.userId,
    goalId: record.goalId,
    stepId: record.stepId,
    configVersion: record.configVersion,
    templateVersion: record.templateVersion,
    manifest: record.manifest,
    createdAt: record.createdAt,
  };
}

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  services: ContextServices
): Promise<AdminSession | undefined> {
  if (!services.admin) {
    await reply.status(503).send({ error: { code: 'admin_unconfigured', message: 'Admin routes are not configured.' } });
    return undefined;
  }
  let session: AdminSession;
  try {
    session = await services.admin.authorize(header(request, 'authorization'));
  } catch (err) {
    if (err instanceof IdentityRejectedError) {
      const status =
        err.code === 'not_allowed' || err.code === 'email_not_verified' || err.code === 'email_required' ? 403 : 401;
      await auditAuthDenied(services, err.code, status);
      await reply.status(status).send({ error: { code: err.code, message: err.message } });
      return undefined;
    }
    throw err;
  }
  if (session.role !== 'admin') {
    await auditAuthDenied(services, 'insufficient_role', 403, session);
    await reply.status(403).send({
      error: { code: 'insufficient_role', message: 'This needs an administrator account.' },
    });
    return undefined;
  }
  return session;
}

async function auditAuthDenied(
  services: ContextServices,
  code: string,
  status: number,
  session?: AdminSession
): Promise<void> {
  const info = getAuditActionInfo('auth.denied');
  const event = buildAuditEvent({
    eventId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    spanId: generateSpanId(),
    workspaceId: 'seedbed',
    actor: { type: 'user', id: session?.subject ?? 'anonymous' },
    service: SERVICE_NAME,
    action: 'auth.denied',
    category: info?.category ?? 'auth',
    ...(info ? { riskLevel: info.riskLevel } : {}),
    outcome: 'denied',
    errorCode: code,
    occurredAt: services.deps.clock.now().toISOString(),
    details: { counts: { httpStatus: status }, reason: code },
  });
  try {
    await services.deps.audit.emit(event);
  } catch {
    // best-effort
  }
}

async function auditPacketView(
  deps: PipelineDeps,
  session: AdminSession,
  details: Record<string, unknown>
): Promise<void> {
  const info = getAuditActionInfo('context.packet_viewed');
  const event = buildAuditEvent({
    eventId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    spanId: generateSpanId(),
    workspaceId: typeof details.workspaceId === 'string' ? details.workspaceId : 'seedbed',
    ...(typeof details.goalId === 'string' ? { goalId: details.goalId } : {}),
    actor: { type: 'user', id: session.subject },
    service: SERVICE_NAME,
    action: 'context.packet_viewed',
    category: info?.category ?? 'data_access',
    ...(info ? { riskLevel: info.riskLevel } : {}),
    outcome: 'success',
    occurredAt: deps.clock.now().toISOString(),
    details: { ...details, role: session.role },
  });
  await deps.audit.emit(event);
}

async function auditCacheInvalidated(
  deps: PipelineDeps,
  session: AdminSession,
  details: Record<string, unknown>
): Promise<void> {
  const info = getAuditActionInfo('context.cache_invalidated');
  const event = buildAuditEvent({
    eventId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    spanId: generateSpanId(),
    workspaceId: typeof details.workspaceId === 'string' ? details.workspaceId : 'seedbed',
    ...(typeof details.userId === 'string' ? { userId: details.userId } : {}),
    ...(typeof details.goalId === 'string' ? { goalId: details.goalId } : {}),
    actor: { type: 'user', id: session.subject },
    service: SERVICE_NAME,
    action: 'context.cache_invalidated',
    category: info?.category ?? 'data_access',
    ...(info ? { riskLevel: info.riskLevel } : {}),
    outcome: 'success',
    occurredAt: deps.clock.now().toISOString(),
    details: { ...details, role: session.role },
  });
  await deps.audit.emit(event);
}

function identityFailure(
  reply: FastifyReply,
  err: unknown,
  audit: (code: string, status: number) => Promise<void>
) {
  if (err instanceof IdentityRejectedError) {
    const status = err.code === 'identity_unconfigured' ? 503 : err.code === 'authorize_denied' ? 403 : 401;
    void audit(err.code, status);
    return reply.status(status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}
