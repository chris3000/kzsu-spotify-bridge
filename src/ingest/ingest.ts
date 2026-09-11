import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { kvSet, type DB } from '../db/client.js';
import { normalize } from '../matching/similarity.js';
import { inferDates, type FeedEntry } from './dateInference.js';
import { fetchFeed } from './feed.js';
import { normKey, parseTitle } from './parse.js';

export interface IngestResult {
  fetched: number;
  newPlays: number;
  newTracks: number;
  /** Track ids created this cycle (still unmatched). */
  newTrackIds: number[];
}

export function dedupKey(
  localDate: string,
  hhmm: string,
  artist: string,
  rawTitle: string,
): string {
  return createHash('sha1')
    .update(
      `${localDate}|${hhmm}|${normalize(artist)}|${normalize(rawTitle)}`,
    )
    .digest('hex');
}

/**
 * Insert feed entries as plays + tracks. Pure DB logic, no network — callable
 * from tests and from runIngest.
 */
export function ingestEntries(
  db: DB,
  entries: FeedEntry[],
  nowEpochSeconds: number,
  timeZone: string,
): IngestResult {
  const dated = inferDates(entries, nowEpochSeconds, timeZone);

  const insertTrack = db.prepare(
    `INSERT INTO tracks (title, artist, year, norm_key, date_added, status)
     VALUES (?, ?, ?, ?, ?, 'unmatched')
     ON CONFLICT(norm_key) DO NOTHING`,
  );
  const selectTrack = db.prepare('SELECT id FROM tracks WHERE norm_key = ?');
  const enqueueMatch = db.prepare(
    `INSERT INTO match_attempts (track_id, attempts, next_attempt) VALUES (?, 0, ?)
     ON CONFLICT(track_id) DO NOTHING`,
  );
  const insertPlay = db.prepare(
    `INSERT INTO plays (track_id, played_at, raw_artist, raw_title, dedup_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dedup_key) DO NOTHING`,
  );

  const result: IngestResult = {
    fetched: entries.length,
    newPlays: 0,
    newTracks: 0,
    newTrackIds: [],
  };

  db.transaction(() => {
    for (const e of dated) {
      const { title, year } = parseTitle(e.title);
      const key = normKey(e.artist, title);
      if (key === '|' || normalize(e.artist) === '') continue; // unusable entry

      const created = insertTrack.run(
        title,
        e.artist.trim(),
        year,
        key,
        e.playedAt,
      );
      const trackId = (selectTrack.get(key) as { id: number }).id;
      if (created.changes > 0) {
        result.newTracks++;
        result.newTrackIds.push(trackId);
        enqueueMatch.run(trackId, nowEpochSeconds);
      }

      const inserted = insertPlay.run(
        trackId,
        e.playedAt,
        e.artist,
        e.title,
        dedupKey(e.localDate, e.date.trim(), e.artist, e.title),
      );
      if (inserted.changes > 0) result.newPlays++;
    }
  })();

  return result;
}

/** Fetch the live feed and ingest it. Network errors propagate to the caller. */
export async function runIngest(
  db: DB,
  config: Config,
  log: Logger,
): Promise<IngestResult> {
  const entries = await fetchFeed(config.FEED_URL);
  const now = Math.floor(Date.now() / 1000);
  const result = ingestEntries(db, entries, now, config.TZ_STATION);
  kvSet(db, 'last_ingest_at', String(now));
  log.info(
    {
      fetched: result.fetched,
      newPlays: result.newPlays,
      newTracks: result.newTracks,
    },
    'ingest complete',
  );
  return result;
}
