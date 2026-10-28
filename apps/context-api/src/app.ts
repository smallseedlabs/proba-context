import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import {
  ContextBuildError,
  IdentityRejectedError,
  NEED_KINDS,
  NEED_SECTION,
  buildContext,
  contextRequestSchema,
  stepTypeSchema,
  type ContextBuildErrorCode,
  type ContextConfig,
  type IdentityCredentials,
  type IdentityResolver,
  type PipelineDeps,
  type ResolvedIdentity,
} from '@smallseedlabs/proba-context-core';

export const SERVICE_NAME = 'context-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

/** What the context routes need: the pipeline's dependencies and a way to turn credentials into an identity. */
export interface ContextServices {
  deps: PipelineDeps;
  identity: IdentityResolver;
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

function credentialsOf(request: FastifyRequest): IdentityCredentials {
  const credentials: IdentityCredentials = {};
  const authorization = header(request, 'authorization');
  const actAs = header(request, 'x-act-as');
  const local = header(request, 'x-local-identity');
  if (authorization !== undefined) credentials.authorization = authorization;
  if (actAs !== undefined) credentials.actAsAssertion = actAs;
  if (local !== undefined) credentials.localIdentity = local;
  return credentials;
}

/** Request body limit from the config; the Fastify default would let a large body through. */
export function bodyLimitOf(config: ContextConfig): number {
  return config.limits.maxRequestBytes;
}

/** Default ceiling for authenticated context routes (per IP, sliding window). */
export const CONTEXT_ROUTE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

/**
 * Builds the HTTP app. `GET /health` is always served. The context routes (`POST /v1/context/build`,
 * `GET /v1/context/needs`) are registered when `services` is given.
 */
export async function buildApp(
  options: FastifyServerOptions = {},
  services?: ContextServices
): Promise<FastifyInstance> {
  const app = Fastify({
    ...(services ? { bodyLimit: bodyLimitOf(services.deps.config) } : {}),
    ...options,
  });

  app.setErrorHandler((err: FastifyError, _request, reply) => {
    const statusCode = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
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

  // Rate-limit authenticated routes (CodeQL + production hardening). Health stays uncapped.
  await app.register(rateLimit, {
    global: false,
    max: CONTEXT_ROUTE_RATE_LIMIT.max,
    timeWindow: CONTEXT_ROUTE_RATE_LIMIT.timeWindow,
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
  });

  async function authenticate(request: FastifyRequest): Promise<ResolvedIdentity> {
    return services.identity.resolve(credentialsOf(request));
  }

  app.post(
    '/v1/context/build',
    { config: { rateLimit: CONTEXT_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      let identity: ResolvedIdentity;
      try {
        identity = await authenticate(request);
      } catch (err) {
        return identityFailure(reply, err);
      }

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
        return reply.status(200).send(packet);
      } catch (err) {
        if (err instanceof ContextBuildError) {
          if (err.code === 'internal_error' || err.code === 'audit_unavailable') app.log.error({ err }, 'context build failed');
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
      try {
        await authenticate(request);
      } catch (err) {
        return identityFailure(reply, err);
      }
      const step = stepTypeSchema.safeParse((request.query as { stepType?: unknown }).stepType);
      if (!step.success) {
        return reply.status(400).send({
          error: { code: 'invalid_request', message: `stepType must be one of: ${stepTypeSchema.options.join(', ')}.` },
        });
      }
      const allowedNeeds = NEED_KINDS.filter(
        (kind) => deps.policyGuard.checkNeed(step.data, kind).allowed && deps.config.sources[NEED_SECTION[kind]].enabled
      );
      return reply.status(200).send({
        stepType: step.data,
        allowedNeeds,
        maxNeedsPerRequest: deps.config.limits.maxNeedsPerRequest,
      });
    }
  );
}

function identityFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof IdentityRejectedError) {
    // Without a configured verifier the service cannot say who the caller is, which is a server-side condition.
    const status = err.code === 'identity_unconfigured' ? 503 : 401;
    return reply.status(status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}
