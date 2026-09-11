import pino from 'pino';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb, type DB } from '../../src/db/client.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      DASHBOARD_PASSWORD: 'test-password',
      COOKIE_SECRET: 'test-cookie-secret-at-least-32-chars!!',
    } as NodeJS.ProcessEnv),
    ...overrides,
  };
}

export function testDb(): DB {
  return openDb(':memory:');
}

export const testLogger = pino({ level: 'silent' });

export function insertTrack(
  db: DB,
  t: {
    title: string;
    artist: string;
    year?: number | null;
    status?: string;
    dateAdded?: number;
    timesSelected?: number;
    lastSelectedAt?: number | null;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO tracks (title, artist, year, norm_key, date_added, times_selected, last_selected_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.title,
      t.artist,
      t.year ?? null,
      `${t.artist.toLowerCase()}|${t.title.toLowerCase()}`,
      t.dateAdded ?? 1_700_000_000,
      t.timesSelected ?? 0,
      t.lastSelectedAt ?? null,
      t.status ?? 'unmatched',
    );
  return Number(res.lastInsertRowid);
}

export function addSpotifyMatch(db: DB, trackId: number, providerId: string): void {
  db.prepare(
    `INSERT INTO provider_matches (track_id, provider, provider_id, uri, confidence, matched_at)
     VALUES (?, 'spotify', ?, ?, 1.0, unixepoch())`,
  ).run(trackId, providerId, `spotify:track:${providerId}`);
}
