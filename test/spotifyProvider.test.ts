import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotifyAuth } from '../src/providers/spotify/auth.js';
import { SpotifyProvider } from '../src/providers/spotify/provider.js';

const fakeAuth = {
  hasRefreshToken: () => true,
  accessToken: async () => 'test-token',
} as unknown as SpotifyAuth;

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown } | null;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SpotifyProvider.ensurePlaylist', () => {
  let provider: SpotifyProvider;
  let calls: { method: string; url: string; body?: unknown }[];
  let routes: Route[];

  beforeEach(() => {
    provider = new SpotifyProvider(fakeAuth);
    calls = [];
    routes = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        method: init?.method ?? 'GET',
        url: u,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      for (const route of routes) {
        const hit = route(u, init);
        if (hit) return jsonResponse(hit.status, hit.body ?? {});
      }
      return jsonResponse(404, { error: 'no route' });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const me = (id = 'chris') => ((u: string) => (u.includes('/me') && !u.includes('/me/playlists') ? { status: 200, body: { id } } : null)) as Route;
  const myPlaylists = (items: { id: string; name: string; owner: string }[]) =>
    ((u: string) =>
      u.includes('/me/playlists')
        ? {
            status: 200,
            body: {
              items: items.map((i) => ({ id: i.id, name: i.name, owner: { id: i.owner } })),
              next: null,
            },
          }
        : null) as Route;

  it('reuses a valid cached playlist id without creating', async () => {
    routes.push((u) =>
      u.includes('/playlists/cached123') ? { status: 200, body: { id: 'cached123' } } : null,
    );
    const p = await provider.ensurePlaylist('Indie Rock Dynamic Playlist', 'cached123');
    expect(p.id).toBe('cached123');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('adopts an existing playlist with the same name instead of creating a duplicate', async () => {
    routes.push(me());
    routes.push(
      myPlaylists([
        { id: 'other', name: 'Some Other List', owner: 'chris' },
        { id: 'existing42', name: 'Indie Rock Dynamic Playlist', owner: 'chris' },
      ]),
    );
    const p = await provider.ensurePlaylist('Indie Rock Dynamic Playlist');
    expect(p.id).toBe('existing42');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('ignores same-name playlists owned by someone else', async () => {
    routes.push(me());
    routes.push(myPlaylists([{ id: 'notmine', name: 'Indie Rock Dynamic Playlist', owner: 'stranger' }]));
    routes.push((u, init) =>
      u.includes('/users/chris/playlists') && init?.method === 'POST'
        ? { status: 201, body: { id: 'fresh1' } }
        : null,
    );
    const p = await provider.ensurePlaylist('Indie Rock Dynamic Playlist');
    expect(p.id).toBe('fresh1');
  });

  it('falls back to name lookup when the cached id is gone (404)', async () => {
    routes.push((u) =>
      u.includes('/playlists/stale') ? { status: 404, body: { error: 'gone' } } : null,
    );
    routes.push(me());
    routes.push(myPlaylists([{ id: 'byname7', name: 'Indie Rock Dynamic Playlist', owner: 'chris' }]));
    const p = await provider.ensurePlaylist('Indie Rock Dynamic Playlist', 'stale');
    expect(p.id).toBe('byname7');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates only when nothing reusable exists', async () => {
    routes.push(me());
    routes.push(myPlaylists([]));
    routes.push((u, init) =>
      u.includes('/users/chris/playlists') && init?.method === 'POST'
        ? { status: 201, body: { id: 'created9' } }
        : null,
    );
    const p = await provider.ensurePlaylist('Indie Rock Dynamic Playlist');
    expect(p.id).toBe('created9');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ name: 'Indie Rock Dynamic Playlist' });
  });
});
