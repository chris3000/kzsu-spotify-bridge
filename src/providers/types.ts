export interface ProviderTrack {
  providerId: string;
  uri: string;
  title: string;
  artists: string[];
  albumYear?: number;
  durationMs?: number;
}

export interface SearchQuery {
  title: string;
  artist: string;
  year?: number | null;
}

/**
 * A streaming service the bridge can match tracks against and push playlists
 * to. Implementations only search and mutate playlists — match scoring lives
 * in src/matching so it is shared across providers.
 */
export interface MusicProvider {
  readonly name: string;
  /** True when credentials are present and usable. */
  isReady(): Promise<boolean>;
  /** Return up to ~5 candidate tracks, unscored. */
  searchTrack(q: SearchQuery): Promise<ProviderTrack[]>;
  /** Verify a cached playlist id or create the playlist; returns id + web URL. */
  ensurePlaylist(name: string, cachedId?: string | null): Promise<{ id: string; url: string }>;
  /** Replace the playlist's entire contents with the given track URIs. */
  replacePlaylistItems(playlistId: string, uris: string[]): Promise<void>;
  /** Update the playlist's public description. */
  setPlaylistDescription(playlistId: string, description: string): Promise<void>;
}
