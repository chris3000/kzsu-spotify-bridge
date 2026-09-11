import pino from 'pino';
import { loadConfig } from './config.js';
import { openDb } from './db/client.js';
import { createRegistry } from './providers/registry.js';
import { startScheduler } from './scheduler/scheduler.js';
import { buildServer } from './web/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });

  const db = openDb(config.DATABASE_PATH);
  log.info({ path: config.DATABASE_PATH }, 'database ready');

  const registry = createRegistry(db, config);
  const app = await buildServer(db, registry, config, log);
  await app.listen({ port: config.PORT, host: config.HOST });

  const scheduler = startScheduler(db, registry, config, log);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
