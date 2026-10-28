import { resolve } from 'node:path';
import { ConfigError, loadContextConfig } from '@smallseedlabs/proba-context-core';
import { buildApp } from './app.js';

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
  const app = buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  try {
    // Validate the configuration before accepting traffic: a bad file stops the process here.
    const configPath = resolve(process.env.CONTEXT_CONFIG_PATH ?? 'config/context.config.yaml');
    const config = loadContextConfig(configPath);
    app.log.info({ configPath, configVersion: config.version, identityMode: config.identity.mode }, 'configuration loaded');

    await app.listen({ port: readPort(process.env.PORT), host: process.env.HOST ?? '0.0.0.0' });
  } catch (err) {
    if (err instanceof ConfigError) app.log.error(err.message);
    else app.log.error(err);
    process.exit(1);
  }

  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
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
