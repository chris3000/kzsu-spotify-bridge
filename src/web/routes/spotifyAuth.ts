import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { ProviderRegistry } from '../../providers/registry.js';

const STATE_COOKIE = 'spotify_oauth_state';

export function registerSpotifyAuth(
  app: FastifyInstance,
  registry: ProviderRegistry,
  log: Logger,
): void {
  app.get('/auth/spotify', async (_req, reply) => {
    const state = randomBytes(16).toString('hex');
    return reply
      .setCookie(STATE_COOKIE, state, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        signed: true,
        maxAge: 600,
      })
      .redirect(registry.spotifyAuth.authorizeUrl(state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/spotify/callback',
    async (req, reply) => {
      const { code, state, error } = req.query;
      if (error) return reply.code(400).send(`Spotify authorization failed: ${error}`);
      const cookie = req.cookies[STATE_COOKIE];
      const unsigned = cookie ? req.unsignCookie(cookie) : null;
      if (!state || !unsigned?.valid || unsigned.value !== state) {
        return reply.code(400).send('OAuth state mismatch; start over at /auth/spotify');
      }
      if (!code) return reply.code(400).send('Missing authorization code');
      await registry.spotifyAuth.exchangeCode(code);
      log.info('Spotify authorization complete');
      return reply.clearCookie(STATE_COOKIE, { path: '/' }).redirect('/');
    },
  );
}
