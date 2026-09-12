import { TZDate } from '@date-fns/tz';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { runPlaylistJob } from '../src/playlists/runner.js';
import { FakeProvider } from './helpers/fakeProvider.js';
import {
  addSpotifyMatch,
  insertTrack,
  testConfig,
  testDb,
  testLogger,
} from './helpers/setup.js';

const TZ = 'America/Los_Angeles';
const config = testConfig({ PLAYLIST_SIZE: 5 });
// 2026-09-10 03:00 Pacific
const NOW = Math.floor(new TZDate(2026, 8, 10, 3, 0, 0, TZ).getTime() / 1000);
const DAY = 86400;

function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function matchedTrack(db: DB, i: number): number {
  const id = insertTrack(db, {
    title: `Song ${i}`,
    artist: `Artist ${i}`,
    status: 'matched',
  });
  addSpotifyMatch(db, id, `sp${i}`);
  return id;
}

function addPlay(db: DB, trackId: number, playedAt: number): void {
  db.prepare(
    `INSERT INTO plays (track_id, played_at, raw_artist, raw_title, dedup_key)
     VALUES (?, ?, 'a', 't', ?)`,
  ).run(trackId, playedAt, `k-${trackId}-${playedAt}`);
}

describe('runPlaylistJob dynamic', () => {
  let db: DB;
  let provider: FakeProvider;
  beforeEach(() => {
    db = testDb();
    provider = new FakeProvider();
    for (let i = 0; i < 10; i++) matchedTrack(db, i);
  });

  it('pushes tracks, records the run, and bumps selection counters', async () => {
    const outcome = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng(),
    );
    expect(outcome.status).toBe('success');
    expect(outcome.trackCount).toBe(5);

    expect(provider.replaceCalls).toHaveLength(1);
    expect(provider.replaceCalls[0]!.uris).toHaveLength(5);

    const run = db
      .prepare(`SELECT * FROM playlist_runs WHERE kind = 'dynamic'`)
      .get() as Record<string, unknown>;
    expect(run.status).toBe('success');
    expect(run.run_date).toBe('2026-09-10');

    const bumped = db
      .prepare('SELECT COUNT(*) c FROM tracks WHERE times_selected = 1')
      .get() as { c: number };
    expect(bumped.c).toBe(5);
  });

  it('is idempotent for cron/catchup but manual reruns', async () => {
    await runPlaylistJob(db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng());
    const second = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'cron', testLogger, NOW + 60, seededRng(),
    );
    expect(second.status).toBe('skipped');
    const catchup = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'catchup', testLogger, NOW + 120, seededRng(),
    );
    expect(catchup.status).toBe('skipped');
    const manual = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'manual', testLogger, NOW + 180, seededRng(),
    );
    expect(manual.status).toBe('success');
    expect(provider.replaceCalls).toHaveLength(2);
  });

  it('does not burn selection counters when the provider push fails', async () => {
    provider.replacePlaylistItems = async () => {
      throw new Error('spotify exploded');
    };
    const outcome = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng(),
    );
    expect(outcome.status).toBe('failed');
    const bumped = db
      .prepare('SELECT COUNT(*) c FROM tracks WHERE times_selected > 0')
      .get() as { c: number };
    expect(bumped.c).toBe(0);
    const run = db
      .prepare(`SELECT status FROM playlist_runs WHERE kind = 'dynamic'`)
      .get() as { status: string };
    expect(run.status).toBe('failed');
  });

  it('fails cleanly when provider is not ready', async () => {
    provider.ready = false;
    const outcome = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng(),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('not authorized');
  });

  it('sets a description containing the last-updated date', async () => {
    await runPlaylistJob(db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng());
    const desc = [...provider.descriptions.values()][0]!;
    expect(desc).toContain('Last updated Sep 10, 2026');
    expect(desc).toContain('An eclectic music mix of college radio rock');
  });

  it('a failed description update does not fail the run', async () => {
    provider.setPlaylistDescription = async () => {
      throw new Error('spotify hiccup');
    };
    const outcome = await runPlaylistJob(
      db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng(),
    );
    expect(outcome.status).toBe('success');
  });

  it('reuses the cached playlist id across runs', async () => {
    await runPlaylistJob(db, [provider], config, 'dynamic', 'cron', testLogger, NOW, seededRng());
    await runPlaylistJob(
      db, [provider], config, 'dynamic', 'manual', testLogger, NOW + 60, seededRng(),
    );
    expect(provider.playlists.size).toBe(1);
  });
});

describe('runPlaylistJob yesterday', () => {
  let db: DB;
  let provider: FakeProvider;
  beforeEach(() => {
    db = testDb();
    provider = new FakeProvider();
  });

  it('includes exactly yesterday\'s matched plays, ordered by first airing', async () => {
    const a = matchedTrack(db, 1);
    const b = matchedTrack(db, 2);
    const c = matchedTrack(db, 3);
    const unmatchedId = insertTrack(db, {
      title: 'No Match',
      artist: 'Ghost',
      status: 'unmatched',
    });
    // Yesterday = 2026-09-09 Pacific.
    const yStart = Math.floor(new TZDate(2026, 8, 9, 0, 0, 0, TZ).getTime() / 1000);
    addPlay(db, b, yStart + 10 * 3600); // 10:00
    addPlay(db, a, yStart + 8 * 3600); // 08:00 (earlier → first)
    addPlay(db, a, yStart + 20 * 3600); // replay, still one entry
    addPlay(db, unmatchedId, yStart + 12 * 3600); // unmatched → omitted
    addPlay(db, c, yStart - 3600); // day before → omitted
    addPlay(db, c, yStart + DAY + 3600); // today → omitted

    const outcome = await runPlaylistJob(
      db, [provider], config, 'yesterday', 'cron', testLogger, NOW,
    );
    expect(outcome.status).toBe('success');
    expect(outcome.trackCount).toBe(2);
    expect(provider.replaceCalls[0]!.uris).toEqual([
      'spotify:track:sp1',
      'spotify:track:sp2',
    ]);
    const desc = [...provider.descriptions.values()][0]!;
    expect(desc).toContain('on Sep 9, 2026');
    expect(desc).toContain('Last updated Sep 10, 2026');
  });

  it('fails (and can retry) when yesterday had no matched plays', async () => {
    const outcome = await runPlaylistJob(
      db, [provider], config, 'yesterday', 'cron', testLogger, NOW,
    );
    expect(outcome.status).toBe('failed');
  });
});
