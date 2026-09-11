import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import {
  selectDynamicTracks,
  trackWeight,
  weightedSample,
} from '../src/playlists/selection.js';
import {
  addSpotifyMatch,
  insertTrack,
  testConfig,
  testDb,
} from './helpers/setup.js';

const DAY = 86400;
const NOW = 1_780_000_000;
const config = testConfig({ PLAYLIST_SIZE: 5 });

/** Deterministic LCG for reproducible sampling. */
function seededRng(seed = 42): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

function matchedTrack(
  db: DB,
  i: number,
  opts: { timesSelected?: number; lastSelectedAt?: number | null } = {},
): number {
  const id = insertTrack(db, {
    title: `Song ${i}`,
    artist: `Artist ${i}`,
    status: 'matched',
    timesSelected: opts.timesSelected ?? 0,
    lastSelectedAt: opts.lastSelectedAt ?? null,
  });
  addSpotifyMatch(db, id, `sp${i}`);
  return id;
}

describe('trackWeight', () => {
  it('caps never-selected tracks at the staleness cap', () => {
    const w = trackWeight({ times_selected: 0, last_selected_at: null }, NOW, config);
    expect(w).toBe(config.STALENESS_CAP);
  });

  it('decays with pick count', () => {
    const fresh = trackWeight({ times_selected: 0, last_selected_at: null }, NOW, config);
    const picked = trackWeight({ times_selected: 4, last_selected_at: null }, NOW, config);
    expect(picked).toBeCloseTo(fresh / 5);
  });

  it('grows with staleness', () => {
    const recent = trackWeight(
      { times_selected: 1, last_selected_at: NOW - 15 * DAY },
      NOW,
      config,
    );
    const stale = trackWeight(
      { times_selected: 1, last_selected_at: NOW - 60 * DAY },
      NOW,
      config,
    );
    expect(stale).toBeGreaterThan(recent);
  });
});

describe('weightedSample', () => {
  it('returns at most `size` distinct tracks', () => {
    const tracks = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      uri: `u${i}`,
      times_selected: 0,
      last_selected_at: null,
    }));
    const picked = weightedSample(tracks, 5, NOW, config, seededRng());
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((t) => t.id)).size).toBe(5);
  });

  it('is deterministic under a seeded RNG', () => {
    const tracks = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      uri: `u${i}`,
      times_selected: i % 3,
      last_selected_at: null,
    }));
    const a = weightedSample(tracks, 5, NOW, config, seededRng(7));
    const b = weightedSample(tracks, 5, NOW, config, seededRng(7));
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('strongly favors heavier weights', () => {
    // One never-selected track vs many heavily-picked recent ones.
    const tracks = [
      { id: 0, uri: 'u0', times_selected: 0, last_selected_at: null },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        uri: `u${i + 1}`,
        times_selected: 50,
        last_selected_at: NOW - 15 * DAY,
      })),
    ];
    let hits = 0;
    const rng = seededRng(1);
    for (let trial = 0; trial < 100; trial++) {
      const picked = weightedSample(tracks, 1, NOW, config, rng);
      if (picked[0]!.id === 0) hits++;
    }
    expect(hits).toBeGreaterThan(70);
  });
});

describe('selectDynamicTracks', () => {
  let db: DB;
  beforeEach(() => {
    db = testDb();
  });

  it('excludes tracks inside the cooldown window at tier 0', () => {
    for (let i = 0; i < 10; i++) matchedTrack(db, i);
    const cooled = matchedTrack(db, 99, { lastSelectedAt: NOW - 2 * DAY });
    const res = selectDynamicTracks(db, 'spotify', config, NOW, seededRng());
    expect(res.fallbackTier).toBe(0);
    expect(res.tracks.map((t) => t.id)).not.toContain(cooled);
  });

  it('ignores unmatched tracks entirely', () => {
    for (let i = 0; i < 10; i++) matchedTrack(db, i);
    insertTrack(db, { title: 'Nope', artist: 'Nobody', status: 'unmatched' });
    const res = selectDynamicTracks(db, 'spotify', config, NOW, seededRng());
    expect(res.tracks.every((t) => t.uri.startsWith('spotify:track:'))).toBe(true);
  });

  it('relaxes cooldown when the pool is too small', () => {
    // 5 needed; only 2 outside 14d cooldown, but 8 outside 7d... make: 3 fresh,
    // 4 selected 10 days ago (inside 14d, outside 7d).
    for (let i = 0; i < 3; i++) matchedTrack(db, i);
    for (let i = 3; i < 7; i++)
      matchedTrack(db, i, { lastSelectedAt: NOW - 10 * DAY });
    const res = selectDynamicTracks(db, 'spotify', config, NOW, seededRng());
    expect(res.fallbackTier).toBe(1);
    expect(res.tracks).toHaveLength(5);
  });

  it('takes the whole catalog at the last tier when tiny', () => {
    matchedTrack(db, 0, { lastSelectedAt: NOW - 1 * DAY });
    matchedTrack(db, 1);
    const res = selectDynamicTracks(db, 'spotify', config, NOW, seededRng());
    expect(res.tracks).toHaveLength(2);
    expect(res.fallbackTier).toBeGreaterThanOrEqual(2);
  });
});
