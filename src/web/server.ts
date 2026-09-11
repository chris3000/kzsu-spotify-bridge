import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { DB } from '../db/client.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { registerAuth } from './auth.js';
import { registerAdmin } from './routes/admin.js';
import { registerDashboard } from './routes/dashboard.js';
import { registerSpotifyAuth } from './routes/spotifyAuth.js';

export async function buildServer(
  db: DB,
  registry: ProviderRegistry,
  config: Config,
  log: Logger,
): Promise<FastifyInstance> {
  // Cast away pino's logger generic; routes only need the base instance type.
  const app = Fastify({
    loggerInstance: log.child({ mod: 'http' }),
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;

  await app.register(fastifyCookie, { secret: config.COOKIE_SECRET });
  await app.register(fastifyFormbody);

  app.get('/healthz', async () => ({ ok: true }));

  registerAuth(app, config);
  registerDashboard(app, db, registry, config);
  registerAdmin(app, db, registry, config, log);
  registerSpotifyAuth(app, registry, log);

  return app;
}
