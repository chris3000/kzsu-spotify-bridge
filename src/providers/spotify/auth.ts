import type { Config } from '../../config.js';
import { kvDelete, kvGet, kvSet, type DB } from '../../db/client.js';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';

export const SCOPES = 'playlist-modify-public playlist-modify-private';

const KV_REFRESH = 'spotify_refresh_token';
const KV_ACCESS = 'spotify_access_token';
const KV_ACCESS_EXPIRES = 'spotify_access_expires_at';

export class SpotifyAuthError extends Error {}

/** Persistent token store + refresh logic for a single server-held account. */
export class SpotifyAuth {
  constructor(
    private readonly db: DB,
    private readonly config: Config,
  ) {}

  get redirectUri(): string {
    return `${this.config.PUBLIC_BASE_URL}/auth/spotify/callback`;
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.SPOTIFY_CLIENT_ID,
      scope: SCOPES,
      redirect_uri: this.redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  hasRefreshToken(): boolean {
    return kvGet(this.db, KV_REFRESH) !== null;
  }

  /** Exchange an authorization code (from the OAuth callback) for tokens. */
  async exchangeCode(code: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });
    const data = await this.tokenRequest(body);
    if (!data.refresh_token) {
      throw new SpotifyAuthError('Token response missing refresh_token');
    }
    kvSet(this.db, KV_REFRESH, data.refresh_token);
    this.storeAccess(data.access_token, data.expires_in);
  }

  /** Return a valid access token, refreshing if absent or within 5 min of expiry. */
  async accessToken(): Promise<string> {
    const cached = kvGet(this.db, KV_ACCESS);
    const expiresAt = Number(kvGet(this.db, KV_ACCESS_EXPIRES) ?? 0);
    const now = Math.floor(Date.now() / 1000);
    if (cached && expiresAt - now > 300) return cached;

    const refresh = kvGet(this.db, KV_REFRESH);
    if (!refresh) {
      throw new SpotifyAuthError(
        'Spotify is not authorized: no refresh token stored. Visit /auth/spotify.',
      );
    }
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
    });
    const data = await this.tokenRequest(body);
    // Spotify occasionally rotates the refresh token.
    if (data.refresh_token) kvSet(this.db, KV_REFRESH, data.refresh_token);
    this.storeAccess(data.access_token, data.expires_in);
    return data.access_token;
  }

  /** Wipe stored tokens (e.g. after invalid_grant) so the dashboard prompts re-auth. */
  clearTokens(): void {
    kvDelete(this.db, KV_REFRESH);
    kvDelete(this.db, KV_ACCESS);
    kvDelete(this.db, KV_ACCESS_EXPIRES);
  }

  private storeAccess(token: string, expiresIn: number): void {
    kvSet(this.db, KV_ACCESS, token);
    kvSet(
      this.db,
      KV_ACCESS_EXPIRES,
      String(Math.floor(Date.now() / 1000) + expiresIn),
    );
  }

  private async tokenRequest(body: URLSearchParams): Promise<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }> {
    const basic = Buffer.from(
      `${this.config.SPOTIFY_CLIENT_ID}:${this.config.SPOTIFY_CLIENT_SECRET}`,
    ).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      if (text.includes('invalid_grant')) {
        this.clearTokens();
        throw new SpotifyAuthError(
          'Spotify refresh token was revoked (invalid_grant); re-authorization required.',
        );
      }
      throw new SpotifyAuthError(`Spotify token request failed: HTTP ${res.status} ${text}`);
    }
    return JSON.parse(text);
  }
}
