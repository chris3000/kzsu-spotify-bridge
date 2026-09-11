import { TZDate } from '@date-fns/tz';
import { describe, expect, it } from 'vitest';
import { inferDates, type FeedEntry } from '../src/ingest/dateInference.js';

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

function entry(date: string, i = 0): FeedEntry {
  return { date, artist: `Artist ${i}`, title: `Title ${i} (2020)` };
}

describe('inferDates', () => {
  it('assigns today to a same-day newest-first feed', () => {
    const now = epoch(2026, 9, 10, 19, 40);
    const out = inferDates(
      [entry('19:33', 0), entry('19:30', 1), entry('18:55', 2)],
      now,
      TZ,
    );
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.localDate)).toEqual([
      '2026-09-10',
      '2026-09-10',
      '2026-09-10',
    ]);
    expect(out[0]!.playedAt).toBe(epoch(2026, 9, 10, 19, 33));
  });

  it('rolls back across midnight when wall clock jumps up', () => {
    const now = epoch(2026, 9, 10, 0, 45);
    const out = inferDates(
      [entry('00:40', 0), entry('00:12', 1), entry('23:55', 2), entry('23:10', 3)],
      now,
      TZ,
    );
    expect(out.map((e) => e.localDate)).toEqual([
      '2026-09-10',
      '2026-09-10',
      '2026-09-09',
      '2026-09-09',
    ]);
    expect(out[2]!.playedAt).toBe(epoch(2026, 9, 9, 23, 55));
  });

  it('rolls back the first entry when it is in the future (poll just after midnight)', () => {
    const now = epoch(2026, 9, 10, 0, 2);
    const out = inferDates([entry('23:58', 0), entry('23:40', 1)], now, TZ);
    expect(out.map((e) => e.localDate)).toEqual(['2026-09-09', '2026-09-09']);
  });

  it('tolerates small clock skew within the grace window', () => {
    const now = epoch(2026, 9, 10, 12, 0);
    const out = inferDates([entry('12:05', 0)], now, TZ);
    expect(out[0]!.localDate).toBe('2026-09-10');
  });

  it('handles oldest-first ordering by detecting and reversing', () => {
    const now = epoch(2026, 9, 10, 19, 40);
    const out = inferDates(
      [entry('18:55', 0), entry('19:30', 1), entry('19:33', 2)],
      now,
      TZ,
    );
    expect(out.map((e) => e.date)).toEqual(['18:55', '19:30', '19:33']);
    expect(out.every((e) => e.localDate === '2026-09-10')).toBe(true);
  });

  it('drops entries that would require rolling back more than 2 days', () => {
    const now = epoch(2026, 9, 10, 1, 0);
    // Three midnight crossings walking backward: today → -1 → -2 → dropped.
    const out = inferDates(
      [
        entry('00:30', 0),
        entry('23:00', 1),
        entry('22:00', 2),
        entry('23:30', 3), // second crossing
        entry('23:45', 4), // third crossing → dropped
      ],
      now,
      TZ,
    );
    expect(out.length).toBeLessThan(5);
  });

  it('skips malformed times', () => {
    const now = epoch(2026, 9, 10, 12, 0);
    const out = inferDates(
      [entry('11:55', 0), entry('nonsense', 1), entry('25:99', 2)],
      now,
      TZ,
    );
    expect(out).toHaveLength(1);
  });

  it('produces correct instants across DST spring-forward', () => {
    // 2026-03-08 02:00 PST → 03:00 PDT. Poll at 03:30 PDT.
    const now = epoch(2026, 3, 8, 3, 30);
    const out = inferDates([entry('03:15', 0), entry('01:45', 1)], now, TZ);
    expect(out[0]!.localDate).toBe('2026-03-08');
    expect(out[1]!.localDate).toBe('2026-03-08');
    // 01:45 PST → 09:45 UTC; 03:15 PDT → 10:15 UTC. Only 30 real minutes apart.
    expect(out[0]!.playedAt - out[1]!.playedAt).toBe(30 * 60);
  });
});
