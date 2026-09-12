import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../../config.js';
import type { DB } from '../../db/client.js';
import { resetRetrySchedule, retryUnmatched } from '../../matching/retry.js';
import {
  runAllPlaylists,
  runPlaylistJob,
  type RunKind,
} from '../../playlists/runner.js';
import type { ProviderRegistry } from '../../providers/registry.js';

export function registerAdmin(
  app: FastifyInstance,
  db: DB,
  registry: ProviderRegistry,
  config: Config,
  log: Logger,
): void {
  app.post<{ Querystring: { kind?: string } }>(
    '/admin/rebuild',
    async (req, reply) => {
      // Run in the request so the redirect lands after the run is recorded;
      // Spotify pushes take a few seconds at most.
      if (req.query.kind === 'all') {
        await runAllPlaylists(db, registry.providers, config, 'manual', log);
      } else {
        const kind: RunKind = req.query.kind === 'yesterday' ? 'yesterday' : 'dynamic';
        await runPlaylistJob(db, registry.providers, config, kind, 'manual', log);
      }
      return reply.redirect('/runs');
    },
  );

  app.post('/admin/retry-unmatched', async (_req, reply) => {
    resetRetrySchedule(db);
    void retryUnmatched(db, registry.providers, config, log).catch((err) =>
      log.error({ err }, 'manual retry pass failed'),
    );
    return reply.redirect('/');
  });

  app.post<{ Params: { trackId: string } }>(
    '/admin/retry-unmatched/:trackId',
    async (req, reply) => {
      const trackId = Number(req.params.trackId);
      resetRetrySchedule(db, trackId);
      await retryUnmatched(db, registry.providers, config, log, 5);
      return reply.redirect('/tracks?status=unmatched');
    },
  );
}
