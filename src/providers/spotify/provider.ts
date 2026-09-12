import type {
  MusicProvider,
  ProviderTrack,
  SearchQuery,
} from '../types.js';
import type { SpotifyAuth } from './auth.js';
import { SpotifyApiError, SpotifyClient } from './client.js';

interface SpotifyTrackObject {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album?: { release_date?: string };
}

interface SearchResponse {
  tracks?: { items: SpotifyTrackObject[] };
}

function toProviderTrack(t: SpotifyTrackObject): ProviderTrack {
  const yearStr = t.album?.release_date?.slice(0, 4);
  const albumYear = yearStr ? parseInt(yearStr, 10) : undefined;
  return {
    providerId: t.id,
    uri: t.uri,
    title: t.name,
    artists: t.artists.map((a) => a.name),
    albumYear: Number.isFinite(albumYear) ? albumYear : undefined,
    durationMs: t.duration_ms,
  };
}

export class SpotifyProvider implements MusicProvider {
  readonly name = 'spotify';
  private readonly client: SpotifyClient;

  constructor(private readonly auth: SpotifyAuth) {
    this.client = new SpotifyClient(auth);
  }

  async isReady(): Promise<boolean> {
    if (!this.auth.hasRefreshToken()) return false;
    try {
      await this.auth.accessToken();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Query ladder: field-filtered first, then free text, then free text with
   * the title truncated at "-"/"/" separators. Dedupes candidates by id.
   */
  async searchTrack(q: SearchQuery): Promise<ProviderTrack[]> {
    const queries = [`track:"${q.title}" artist:"${q.artist}"`, `${q.title} ${q.artist}`];
    const cut = q.title.split(/\s+[-/]\s+/)[0]!.trim();
    if (cut && cut !== q.title) queries.push(`${cut} ${q.artist}`);

    const seen = new Map<string, ProviderTrack>();
    for (const query of queries) {
      const params = new URLSearchParams({
        q: query,
        type: 'track',
        limit: '5',
        market: 'US',
      });
      const res = await this.client.request<SearchResponse>(
        'GET',
        `/search?${params}`,
      );
      for (const item of res.tracks?.items ?? []) {
        if (!seen.has(item.id)) seen.set(item.id, toProviderTrack(item));
      }
      // Field-filtered result is highest signal; if it produced candidates,
      // that's usually enough. Free-text passes only run on empty results.
      if (seen.size > 0) break;
    }
    return [...seen.values()];
  }

  async ensurePlaylist(
    name: string,
    cachedId?: string | null,
  ): Promise<{ id: string; url: string }> {
    if (cachedId) {
      try {
        const p = await this.client.request<{
          id: string;
          external_urls?: { spotify?: string };
        }>('GET', `/playlists/${cachedId}?fields=id,external_urls`);
        return {
          id: p.id,
          url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
        };
      } catch (err) {
        if (!(err instanceof SpotifyApiError && err.status === 404)) throw err;
        // Playlist deleted — fall through to name lookup / create.
      }
    }
    const me = await this.client.request<{ id: string }>('GET', '/me');
    // Reuse an existing playlist with this exact name (owned by the user)
    // before ever creating one — guarantees a single stable playlist per
    // kind even on first boot or after a lost kv cache.
    const existing = await this.findOwnPlaylistByName(me.id, name);
    if (existing) return existing;
    const created = await this.client.request<{
      id: string;
      external_urls?: { spotify?: string };
    }>('POST', `/users/${encodeURIComponent(me.id)}/playlists`, {
      name,
      public: true,
      description: 'Managed by kzsu-spotify-bridge',
    });
    return {
      id: created.id,
      url:
        created.external_urls?.spotify ??
        `https://open.spotify.com/playlist/${created.id}`,
    };
  }

  private async findOwnPlaylistByName(
    meId: string,
    name: string,
  ): Promise<{ id: string; url: string } | null> {
    const target = name.trim();
    let path: string | null = '/me/playlists?limit=50';
    while (path) {
      const page: {
        items: {
          id: string;
          name: string;
          owner?: { id?: string };
          external_urls?: { spotify?: string };
        }[];
        next: string | null;
      } = await this.client.request('GET', path);
      for (const p of page.items) {
        if (p.name.trim() === target && p.owner?.id === meId) {
          return {
            id: p.id,
            url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
          };
        }
      }
      path = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return null;
  }

  async setPlaylistDescription(playlistId: string, description: string): Promise<void> {
    await this.client.request('PUT', `/playlists/${playlistId}`, { description });
  }

  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    const first = uris.slice(0, 100);
    await this.client.request('PUT', `/playlists/${playlistId}/tracks`, {
      uris: first,
    });
    for (let i = 100; i < uris.length; i += 100) {
      await this.client.request('POST', `/playlists/${playlistId}/tracks`, {
        uris: uris.slice(i, i + 100),
      });
    }
  }
}
