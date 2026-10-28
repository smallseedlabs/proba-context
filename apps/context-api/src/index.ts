import { resolve } from 'node:path';
import { ConfigError } from '@smallseedlabs/proba-context-core';
import { buildApp } from './app.js';
import { createRuntime, type Runtime } from './runtime.js';

const DEFAULT_PORT = 3500;

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

async function main(): Promise<void> {
  const logger = { level: process.env.LOG_LEVEL ?? 'info' };
  let runtime: Runtime;
  try {
    // Validate the configuration before accepting traffic: a bad file or deployment stops the process here.
    const configPath = resolve(process.env.CONTEXT_CONFIG_PATH ?? 'config/context.config.yaml');
    runtime = createRuntime(process.env, configPath);
  } catch (err) {
    // The app does not exist yet; use a throw-away instance only for its structured logger.
    const bootLog = buildApp({ logger }).log;
    bootLog.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }

  const app = buildApp({ logger }, runtime.services);
  try {
    app.log.info(
      {
        configVersion: runtime.config.version,
        identityMode: runtime.identityMode,
        auditSink: runtime.auditSink,
      },
      'configuration loaded'
    );
    await app.listen({ port: readPort(process.env.PORT), host: process.env.HOST ?? '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => runtime.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error(err);
          process.exit(1);
        }
      );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
