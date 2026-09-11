import { TZDate } from '@date-fns/tz';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db/client.js';
import type { FeedEntry } from '../src/ingest/dateInference.js';
import { ingestEntries } from '../src/ingest/ingest.js';

const TZ = 'America/Los_Angeles';

function epoch(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
): number {
  return Math.floor(new TZDate(y, mo - 1, d, hh, mm, 0, TZ).getTime() / 1000);
}

describe('ingestEntries', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  const feed: FeedEntry[] = [
    { date: '19:33', artist: 'Big Thief', title: 'Orange (2019)' },
    { date: '19:30', artist: 'Buzzcocks', title: 'Just Lust (1978)' },
    { date: '19:26', artist: 'Big Thief', title: 'Orange (2019)' }, // real replay
  ];

  it('creates tracks and plays from a feed', () => {
    const now = epoch(2026, 9, 10, 19, 40);
    const r = ingestEntries(db, feed, now, TZ);
    expect(r.newTracks).toBe(2); // Orange dedupes to one track
    expect(r.newPlays).toBe(3); // but both airings are recorded
    const track = db
      .prepare('SELECT * FROM tracks WHERE artist = ?')
      .get('Big Thief') as Record<string, unknown>;
    expect(track.title).toBe('Orange');
    expect(track.year).toBe(2019);
    expect(track.status).toBe('unmatched');
    const queued = db.prepare('SELECT COUNT(*) c FROM match_attempts').get() as {
      c: number;
    };
    expect(queued.c).toBe(2);
  });

  it('is idempotent across overlapping polls', () => {
    const now1 = epoch(2026, 9, 10, 19, 40);
    ingestEntries(db, feed, now1, TZ);
    // Next hourly poll sees the same plays plus one new one.
    const now2 = epoch(2026, 9, 10, 20, 40);
    const r2 = ingestEntries(
      db,
      [{ date: '20:10', artist: 'Guster', title: 'What You Call Love (2010)' }, ...feed],
      now2,
      TZ,
    );
    expect(r2.newPlays).toBe(1);
    expect(r2.newTracks).toBe(1);
    const plays = db.prepare('SELECT COUNT(*) c FROM plays').get() as {
      c: number;
    };
    expect(plays.c).toBe(4);
  });

  it('same song at same time on different days is two plays', () => {
    ingestEntries(db, [feed[0]!], epoch(2026, 9, 10, 19, 40), TZ);
    ingestEntries(db, [feed[0]!], epoch(2026, 9, 11, 19, 40), TZ);
    const plays = db.prepare('SELECT COUNT(*) c FROM plays').get() as {
      c: number;
    };
    expect(plays.c).toBe(2);
    const tracks = db.prepare('SELECT COUNT(*) c FROM tracks').get() as {
      c: number;
    };
    expect(tracks.c).toBe(1);
  });
});
