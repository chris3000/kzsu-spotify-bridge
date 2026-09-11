import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import {
  evaluateCandidate,
  isAcceptable,
  matchTrack,
  type TrackRow,
} from '../src/matching/matcher.js';
import { resetRetrySchedule, retryUnmatched } from '../src/matching/retry.js';
import { candidate, FakeProvider } from './helpers/fakeProvider.js';
import { insertTrack, testConfig, testDb, testLogger } from './helpers/setup.js';

const config = testConfig();

function unmatchedTrack(db: DB, title: string, artist: string, year?: number): TrackRow {
  const id = insertTrack(db, { title, artist, year: year ?? null });
  db.prepare(
    'INSERT INTO match_attempts (track_id, attempts, next_attempt) VALUES (?, 0, 0)',
  ).run(id);
  return { id, title, artist, year: year ?? null };
}

describe('evaluateCandidate / isAcceptable', () => {
  const track = { title: 'Orange', artist: 'Big Thief', year: 2019 };
  const accept = (c: Parameters<typeof evaluateCandidate>[1]) =>
    isAcceptable(evaluateCandidate(track, c), config.MATCH_THRESHOLD);

  it('accepts an exact match', () => {
    const scored = evaluateCandidate(
      track,
      candidate({ providerId: 'x', title: 'Orange', artists: ['Big Thief'], albumYear: 2019 }),
    );
    expect(scored.score).toBeGreaterThan(0.95);
    expect(isAcceptable(scored, config.MATCH_THRESHOLD)).toBe(true);
  });

  it('rejects an exact title by the wrong artist', () => {
    expect(
      accept(
        candidate({ providerId: 'x', title: 'Orange', artists: ['Completely Different'], albumYear: 2019 }),
      ),
    ).toBe(false);
  });

  it('rejects a title superset by the right artist', () => {
    expect(
      accept(
        candidate({ providerId: 'x', title: 'Orange Juice Blues', artists: ['Big Thief'], albumYear: 2019 }),
      ),
    ).toBe(false);
  });

  it('accepts a live-decorated title by the right artist', () => {
    expect(
      accept(
        candidate({ providerId: 'x', title: 'Orange - Live', artists: ['Big Thief'], albumYear: 2019 }),
      ),
    ).toBe(true);
  });

  it('takes the best artist among several (featuring splits)', () => {
    expect(
      accept(
        candidate({ providerId: 'x', title: 'Orange', artists: ['Someone Else', 'Big Thief'], albumYear: 2019 }),
      ),
    ).toBe(true);
  });

  it('gives half year-bonus when year unknown', () => {
    const withYear = evaluateCandidate(
      track,
      candidate({ providerId: 'x', title: 'Orange', artists: ['Big Thief'], albumYear: 2019 }),
    );
    const noYear = evaluateCandidate(
      track,
      candidate({ providerId: 'x', title: 'Orange', artists: ['Big Thief'] }),
    );
    expect(withYear.score - noYear.score).toBeCloseTo(0.05, 5);
  });
});

describe('matchTrack', () => {
  let db: DB;
  let provider: FakeProvider;
  beforeEach(() => {
    db = testDb();
    provider = new FakeProvider();
  });

  it('accepts a good candidate and records the match', async () => {
    const track = unmatchedTrack(db, 'Orange', 'Big Thief', 2019);
    provider.results.set('*', [
      candidate({ providerId: 'sp1', title: 'Orange', artists: ['Big Thief'], albumYear: 2019 }),
      candidate({ providerId: 'sp2', title: 'Oranges', artists: ['Other Band'] }),
    ]);
    const outcome = await matchTrack(db, [provider], config, track, testLogger);
    expect(outcome.kind).toBe('matched');
    const match = db
      .prepare('SELECT * FROM provider_matches WHERE track_id = ?')
      .get(track.id) as Record<string, unknown>;
    expect(match.provider_id).toBe('sp1');
    const row = db.prepare('SELECT status FROM tracks WHERE id = ?').get(track.id) as {
      status: string;
    };
    expect(row.status).toBe('matched');
    expect(
      db.prepare('SELECT COUNT(*) c FROM match_attempts WHERE track_id = ?').get(track.id),
    ).toEqual({ c: 0 });
  });

  it('records a near-miss and schedules a retry', async () => {
    const track = unmatchedTrack(db, 'Orange', 'Big Thief', 2019);
    provider.results.set('*', [
      candidate({ providerId: 'sp3', title: 'Orange Juice Blues', artists: ['Big Thief Tribute Band'] }),
    ]);
    const outcome = await matchTrack(db, [provider], config, track, testLogger);
    expect(outcome.kind).toBe('missed');
    const ma = db
      .prepare('SELECT * FROM match_attempts WHERE track_id = ?')
      .get(track.id) as Record<string, unknown>;
    expect(ma.attempts).toBe(1);
    expect(Number(ma.next_attempt)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('gives up after 8 attempts', async () => {
    const track = unmatchedTrack(db, 'Obscurity', 'Nobody', 2020);
    for (let i = 0; i < 8; i++) {
      await matchTrack(db, [provider], config, track, testLogger);
    }
    const row = db.prepare('SELECT status FROM tracks WHERE id = ?').get(track.id) as {
      status: string;
    };
    expect(row.status).toBe('gave_up');
  });

  it('treats provider errors as retryable, not permanent misses', async () => {
    const track = unmatchedTrack(db, 'Orange', 'Big Thief', 2019);
    provider.failSearches = true;
    const outcome = await matchTrack(db, [provider], config, track, testLogger);
    expect(outcome.kind).toBe('error');
    const ma = db
      .prepare('SELECT attempts FROM match_attempts WHERE track_id = ?')
      .get(track.id) as { attempts: number };
    expect(ma.attempts).toBe(1);
  });

  it('skips providers that are not ready', async () => {
    const track = unmatchedTrack(db, 'Orange', 'Big Thief', 2019);
    provider.ready = false;
    const outcome = await matchTrack(db, [provider], config, track, testLogger);
    expect(outcome.kind).toBe('missed');
    expect(provider.searchCalls).toHaveLength(0);
  });
});

describe('retryUnmatched', () => {
  it('processes only due entries and stops on provider errors', async () => {
    const db = testDb();
    const provider = new FakeProvider();
    const due = unmatchedTrack(db, 'Due Song', 'Artist A', 2020);
    const notDue = unmatchedTrack(db, 'Future Song', 'Artist B', 2020);
    db.prepare('UPDATE match_attempts SET next_attempt = ? WHERE track_id = ?').run(
      Math.floor(Date.now() / 1000) + 9999,
      notDue.id,
    );
    provider.results.set('due song|artist a', [
      candidate({ providerId: 'sp9', title: 'Due Song', artists: ['Artist A'], albumYear: 2020 }),
    ]);
    const res = await retryUnmatched(db, [provider], config, testLogger);
    expect(res.processed).toBe(1);
    expect(res.matched).toBe(1);
  });

  it('resetRetrySchedule makes gave_up tracks due again', async () => {
    const db = testDb();
    const id = insertTrack(db, { title: 'X', artist: 'Y', status: 'gave_up' });
    resetRetrySchedule(db, id);
    const provider = new FakeProvider();
    provider.results.set('*', [
      candidate({ providerId: 'spx', title: 'X', artists: ['Y'] }),
    ]);
    const res = await retryUnmatched(db, [provider], config, testLogger);
    expect(res.processed).toBe(1);
    expect(res.matched).toBe(1);
    const row = db.prepare('SELECT status FROM tracks WHERE id = ?').get(id) as {
      status: string;
    };
    expect(row.status).toBe('matched');
  });
});
