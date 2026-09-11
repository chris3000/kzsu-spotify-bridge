import type { Config } from '../config.js';
import type { DB } from '../db/client.js';
import { SpotifyAuth } from './spotify/auth.js';
import { SpotifyProvider } from './spotify/provider.js';
import type { MusicProvider } from './types.js';

export interface ProviderRegistry {
  providers: MusicProvider[];
  spotifyAuth: SpotifyAuth;
}

/** All registered streaming services. Add new providers here. */
export function createRegistry(db: DB, config: Config): ProviderRegistry {
  const spotifyAuth = new SpotifyAuth(db, config);
  return {
    providers: [new SpotifyProvider(spotifyAuth)],
    spotifyAuth,
  };
}
