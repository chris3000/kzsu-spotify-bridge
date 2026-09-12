import type {
  MusicProvider,
  ProviderTrack,
  SearchQuery,
} from '../../src/providers/types.js';

export function candidate(
  overrides: Partial<ProviderTrack> & { providerId: string },
): ProviderTrack {
  return {
    uri: `fake:track:${overrides.providerId}`,
    title: 'Untitled',
    artists: ['Unknown'],
    ...overrides,
  };
}

/** In-memory MusicProvider for tests: canned search results, recorded playlist calls. */
export class FakeProvider implements MusicProvider {
  readonly name: string;
  ready = true;
  /** Map from lowercased "title|artist" (or '*') to canned candidates. */
  results = new Map<string, ProviderTrack[]>();
  searchCalls: SearchQuery[] = [];
  playlists = new Map<string, { name: string; uris: string[] }>();
  replaceCalls: { playlistId: string; uris: string[] }[] = [];
  failSearches = false;
  private nextId = 1;

  constructor(name = 'spotify') {
    this.name = name;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  async searchTrack(q: SearchQuery): Promise<ProviderTrack[]> {
    this.searchCalls.push(q);
    if (this.failSearches) throw new Error('search unavailable');
    return (
      this.results.get(`${q.title.toLowerCase()}|${q.artist.toLowerCase()}`) ??
      this.results.get('*') ??
      []
    );
  }

  async ensurePlaylist(
    name: string,
    cachedId?: string | null,
  ): Promise<{ id: string; url: string }> {
    if (cachedId && this.playlists.has(cachedId)) {
      return { id: cachedId, url: `https://fake/playlist/${cachedId}` };
    }
    const id = `pl-${this.nextId++}`;
    this.playlists.set(id, { name, uris: [] });
    return { id, url: `https://fake/playlist/${id}` };
  }

  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    const pl = this.playlists.get(playlistId);
    if (!pl) throw new Error(`unknown playlist ${playlistId}`);
    pl.uris = [...uris];
    this.replaceCalls.push({ playlistId, uris: [...uris] });
  }

  descriptions = new Map<string, string>();

  async setPlaylistDescription(playlistId: string, description: string): Promise<void> {
    this.descriptions.set(playlistId, description);
  }
}
