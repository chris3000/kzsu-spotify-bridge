import type { SpotifyAuth } from './auth.js';

const API_BASE = 'https://api.spotify.com/v1';

export class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Spotify Web API client: serialized requests (one in flight),
 * automatic bearer auth, 429 Retry-After handling, and 5xx backoff.
 */
export class SpotifyClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly auth: SpotifyAuth) {}

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const run = this.queue.then(
      () => this.requestWithRetry<T>(method, path, body),
      () => this.requestWithRetry<T>(method, path, body),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const backoffs = [1000, 4000, 16000];
    let rateLimitRetries = 0;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken();
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        if (rateLimitRetries++ >= 3) {
          throw new SpotifyApiError('Rate limited too many times', 429);
        }
        const retryAfter = Number(res.headers.get('retry-after') ?? 2);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        // Stale access token (e.g. revoked server-side); force refresh once.
        continue;
      }
      if (res.status >= 500 && attempt < backoffs.length) {
        await sleep(backoffs[attempt]!);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SpotifyApiError(
          `Spotify API ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
          res.status,
        );
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }
}
