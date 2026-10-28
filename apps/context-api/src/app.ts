import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

export const SERVICE_NAME = 'context-api';

export interface HealthResponse {
  status: 'ok';
  service: typeof SERVICE_NAME;
}

export function buildApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.get('/health', async (): Promise<HealthResponse> => ({ status: 'ok', service: SERVICE_NAME }));

  return app;
}
