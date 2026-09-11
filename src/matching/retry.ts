import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { DB } from '../db/client.js';
import type { MusicProvider } from '../providers/types.js';
import { matchTrack, type TrackRow } from './matcher.js';

/**
 * Process due entries in the unmatched retry queue (next_attempt <= now),
 * oldest first, up to `limit` rows.
 */
export async function retryUnmatched(
  db: DB,
  providers: MusicProvider[],
  config: Config,
  log: Logger,
  limit = 200,
): Promise<{ processed: number; matched: number }> {
  const now = Math.floor(Date.now() / 1000);
  const due = db
    .prepare(
      `SELECT t.id, t.title, t.artist, t.year
       FROM match_attempts ma JOIN tracks t ON t.id = ma.track_id
       WHERE ma.next_attempt <= ? AND t.status IN ('unmatched', 'gave_up')
       ORDER BY ma.next_attempt ASC
       LIMIT ?`,
    )
    .all(now, limit) as TrackRow[];

  let matched = 0;
  for (const track of due) {
    const outcome = await matchTrack(db, providers, config, track, log);
    if (outcome.kind === 'matched') matched++;
    if (outcome.kind === 'error') break; // provider trouble: stop the pass
  }
  log.info({ processed: due.length, matched }, 'unmatched retry pass complete');
  return { processed: due.length, matched };
}

/** Reset next_attempt so the given tracks (or all unmatched) retry immediately. */
export function resetRetrySchedule(db: DB, trackId?: number): number {
  const now = Math.floor(Date.now() / 1000);
  if (trackId != null) {
    // Ensure a queue row exists even if the track previously gave up.
    db.prepare(
      `INSERT INTO match_attempts (track_id, attempts, next_attempt)
       VALUES (?, 0, ?)
       ON CONFLICT(track_id) DO UPDATE SET next_attempt = excluded.next_attempt`,
    ).run(trackId, now);
    return 1;
  }
  const res = db
    .prepare('UPDATE match_attempts SET next_attempt = ?')
    .run(now);
  return res.changes;
}
