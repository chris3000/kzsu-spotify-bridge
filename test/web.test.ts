import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import type { ProviderRegistry } from '../src/providers/registry.js';
import { SpotifyAuth } from '../src/providers/spotify/auth.js';
import { buildServer } from '../src/web/server.js';
import { FakeProvider } from './helpers/fakeProvider.js';
import {
  addSpotifyMatch,
  insertTrack,
  testConfig,
  testDb,
  testLogger,
} from './helpers/setup.js';

const config = testConfig({ PLAYLIST_SIZE: 3 });

describe('web server', () => {
  let db: DB;
  let app: FastifyInstance;
  let provider: FakeProvider;
  let cookie: { name: string; value: string };

  beforeEach(async () => {
    db = testDb();
    provider = new FakeProvider();
    const registry: ProviderRegistry = {
      providers: [provider],
      spotifyAuth: new SpotifyAuth(db, config),
    };
    app = await buildServer(db, registry, config, testLogger);
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'test-password' },
    });
    const setCookie = login.cookies.find((c) => c.name === 'kzsu_session');
    cookie = { name: setCookie!.name, value: setCookie!.value };
  });

  afterEach(async () => {
    await app.close();
  });

  const authed = (url: string, method: 'GET' | 'POST' = 'GET') =>
    app.inject({ method, url, cookies: { [cookie.name]: cookie.value } });

  it('serves /healthz without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('redirects unauthenticated requests to /login', async () => {
    for (const url of ['/', '/tracks', '/runs', '/auth/spotify']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/login');
    }
  });

  it('rejects a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { password: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
      cookies: { kzsu_session: 'ok' }, // unsigned
    });
    expect(res.statusCode).toBe(302);
  });

  it('renders the dashboard with stats', async () => {
    insertTrack(db, { title: 'A', artist: 'B', status: 'matched' });
    const res = await authed('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('tracks in database');
    expect(res.body).toContain('Spotify: authorized');
  });

  it('filters tracks by status and artist', async () => {
    insertTrack(db, { title: 'Hit', artist: 'Big Thief', status: 'matched' });
    insertTrack(db, { title: 'Miss', artist: 'Other', status: 'unmatched' });
    const res = await authed('/tracks?status=matched&artist=Thief');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Hit');
    expect(res.body).not.toContain('Miss');
  });

  it('escapes HTML in track data', async () => {
    insertTrack(db, {
      title: '<script>alert(1)</script>',
      artist: 'XSS',
      status: 'matched',
    });
    const res = await authed('/tracks');
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('admin rebuild creates a playlist run', async () => {
    for (let i = 0; i < 5; i++) {
      const id = insertTrack(db, {
        title: `S${i}`,
        artist: `A${i}`,
        status: 'matched',
      });
      addSpotifyMatch(db, id, `sp${i}`);
    }
    const res = await authed('/admin/rebuild?kind=dynamic', 'POST');
    expect(res.statusCode).toBe(302);
    const run = db
      .prepare(`SELECT status, trigger FROM playlist_runs WHERE kind = 'dynamic'`)
      .get() as { status: string; trigger: string };
    expect(run.status).toBe('success');
    expect(run.trigger).toBe('manual');
    expect(provider.replaceCalls).toHaveLength(1);

    const runsPage = await authed('/runs');
    expect(runsPage.body).toContain('manual');
  });

  it('per-track retry endpoint retries and redirects', async () => {
    const id = insertTrack(db, { title: 'Findable', artist: 'Someone', status: 'unmatched' });
    provider.results.set('*', []);
    const res = await authed(`/admin/retry-unmatched/${id}`, 'POST');
    expect(res.statusCode).toBe(302);
    const ma = db
      .prepare('SELECT attempts FROM match_attempts WHERE track_id = ?')
      .get(id) as { attempts: number };
    expect(ma.attempts).toBe(1);
  });

  it('starts the Spotify OAuth flow with a state cookie', async () => {
    const res = await authed('/auth/spotify');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('accounts.spotify.com/authorize');
    expect(res.headers.location).toContain('state=');
    const state = res.cookies.find((c) => c.name === 'spotify_oauth_state');
    expect(state).toBeDefined();
  });

  it('rejects an OAuth callback with mismatched state', async () => {
    const res = await authed('/auth/spotify/callback?code=x&state=forged');
    expect(res.statusCode).toBe(400);
  });
});
