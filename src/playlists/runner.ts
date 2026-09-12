import { TZDate } from '@date-fns/tz';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { kvGet, kvSet, type DB } from '../db/client.js';
import type { MusicProvider } from '../providers/types.js';
import { selectDynamicTracks } from './selection.js';

export type RunKind = 'dynamic' | 'yesterday';
export type RunTrigger = 'cron' | 'manual' | 'catchup';

export interface RunOutcome {
  kind: RunKind;
  status: 'success' | 'failed' | 'skipped';
  trackCount?: number;
  notes?: string;
  error?: string;
}

const DAY = 86400;

export function pacificDateString(epochSeconds: number, timeZone: string): string {
  const d = new TZDate(epochSeconds * 1000, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prettyDate(epochSeconds: number, timeZone: string): string {
  return new Date(epochSeconds * 1000).toLocaleDateString('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Best-effort: a failed description update should not fail the run. */
async function updateDescription(
  provider: MusicProvider,
  playlistId: string,
  description: string,
  log: Logger,
): Promise<void> {
  try {
    await provider.setPlaylistDescription(playlistId, description);
  } catch (err) {
    log.warn({ playlistId, err }, 'failed to update playlist description');
  }
}

/** Epoch bounds [start, end) of the station-local calendar day containing `epochSeconds - dayOffset days`. */
function localDayBounds(
  epochSeconds: number,
  timeZone: string,
  dayOffset: number,
): { start: number; end: number } {
  const d = new TZDate(epochSeconds * 1000, timeZone);
  const start = new TZDate(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - dayOffset,
    0,
    0,
    0,
    timeZone,
  );
  const end = new TZDate(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() - dayOffset + 1,
    0,
    0,
    0,
    timeZone,
  );
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
  };
}

export function hasSucceededToday(
  db: DB,
  kind: RunKind,
  runDate: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM playlist_runs WHERE kind = ? AND run_date = ? AND status = 'success' LIMIT 1`,
    )
    .get(kind, runDate);
  return row !== undefined;
}

/**
 * Run one playlist job (dynamic or yesterday) against every ready provider.
 * Cron/catchup triggers skip if today's run already succeeded; manual always runs.
 * Selection bookkeeping (times_selected / last_selected_at) commits only after
 * the provider push succeeds.
 */
export async function runPlaylistJob(
  db: DB,
  providers: MusicProvider[],
  config: Config,
  kind: RunKind,
  trigger: RunTrigger,
  log: Logger,
  now: number = Math.floor(Date.now() / 1000),
  rng: () => number = Math.random,
): Promise<RunOutcome> {
  const runDate = pacificDateString(now, config.TZ_STATION);
  if (trigger !== 'manual' && hasSucceededToday(db, kind, runDate)) {
    log.info({ kind, runDate, trigger }, 'playlist run already succeeded today; skipping');
    return { kind, status: 'skipped' };
  }

  const provider = providers[0];
  if (!provider || !(await provider.isReady())) {
    const error = 'no ready provider (Spotify not authorized?)';
    recordRun(db, kind, runDate, now, trigger, { status: 'failed', error });
    log.warn({ kind }, error);
    return { kind, status: 'failed', error };
  }

  try {
    if (kind === 'dynamic') {
      return await runDynamic(db, provider, config, runDate, trigger, log, now, rng);
    }
    return await runYesterday(db, provider, config, runDate, trigger, log, now);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordRun(db, kind, runDate, now, trigger, { status: 'failed', error });
    log.error({ kind, err: error }, 'playlist run failed');
    return { kind, status: 'failed', error };
  }
}

async function runDynamic(
  db: DB,
  provider: MusicProvider,
  config: Config,
  runDate: string,
  trigger: RunTrigger,
  log: Logger,
  now: number,
  rng: () => number,
): Promise<RunOutcome> {
  const selection = selectDynamicTracks(db, provider.name, config, now, rng);
  if (selection.tracks.length === 0) {
    const error = 'no matched tracks available for selection';
    recordRun(db, 'dynamic', runDate, now, trigger, { status: 'failed', error });
    return { kind: 'dynamic', status: 'failed', error };
  }

  const playlist = await ensureKnownPlaylist(
    db,
    provider,
    'dynamic',
    config.DYNAMIC_PLAYLIST_NAME,
  );
  await provider.replacePlaylistItems(
    playlist.id,
    selection.tracks.map((t) => t.uri),
  );
  await updateDescription(
    provider,
    playlist.id,
    `An eclectic music mix of college radio rock. A full day of music, updated daily. Last updated ${prettyDate(now, config.TZ_STATION)}.`,
    log,
  );

  const notes =
    selection.fallbackTier > 0 ? `fallback tier ${selection.fallbackTier}` : null;
  db.transaction(() => {
    const runId = recordRun(db, 'dynamic', runDate, now, trigger, {
      status: 'success',
      trackCount: selection.tracks.length,
      playlistId: playlist.id,
      notes,
    });
    const insertEntry = db.prepare(
      'INSERT INTO playlist_entries (run_id, position, track_id) VALUES (?, ?, ?)',
    );
    const bump = db.prepare(
      'UPDATE tracks SET times_selected = times_selected + 1, last_selected_at = ? WHERE id = ?',
    );
    selection.tracks.forEach((t, i) => {
      insertEntry.run(runId, i, t.id);
      bump.run(now, t.id);
    });
  })();

  log.info(
    { count: selection.tracks.length, tier: selection.fallbackTier, playlist: playlist.id },
    'dynamic playlist updated',
  );
  return {
    kind: 'dynamic',
    status: 'success',
    trackCount: selection.tracks.length,
    notes: notes ?? undefined,
  };
}

async function runYesterday(
  db: DB,
  provider: MusicProvider,
  config: Config,
  runDate: string,
  trigger: RunTrigger,
  log: Logger,
  now: number,
): Promise<RunOutcome> {
  const { start, end } = localDayBounds(now, config.TZ_STATION, 1);
  const rows = db
    .prepare(
      `SELECT t.id, pm.uri, MIN(p.played_at) AS first_played
       FROM plays p
       JOIN tracks t ON t.id = p.track_id AND t.status = 'matched'
       JOIN provider_matches pm ON pm.track_id = t.id AND pm.provider = ? AND pm.uri IS NOT NULL
       WHERE p.played_at >= ? AND p.played_at < ?
       GROUP BY t.id
       ORDER BY first_played ASC`,
    )
    .all(provider.name, start, end) as { id: number; uri: string }[];

  if (rows.length === 0) {
    const error = 'no matched plays found for yesterday';
    recordRun(db, 'yesterday', runDate, now, trigger, { status: 'failed', error });
    return { kind: 'yesterday', status: 'failed', error };
  }

  const playlist = await ensureKnownPlaylist(
    db,
    provider,
    'yesterday',
    config.YESTERDAY_PLAYLIST_NAME,
  );
  await provider.replacePlaylistItems(
    playlist.id,
    rows.map((r) => r.uri),
  );
  await updateDescription(
    provider,
    playlist.id,
    `Every song identified on KZSU Zootopia on ${prettyDate(start, config.TZ_STATION)}. Last updated ${prettyDate(now, config.TZ_STATION)}.`,
    log,
  );

  db.transaction(() => {
    const runId = recordRun(db, 'yesterday', runDate, now, trigger, {
      status: 'success',
      trackCount: rows.length,
      playlistId: playlist.id,
    });
    const insertEntry = db.prepare(
      'INSERT INTO playlist_entries (run_id, position, track_id) VALUES (?, ?, ?)',
    );
    rows.forEach((r, i) => insertEntry.run(runId, i, r.id));
  })();

  log.info({ count: rows.length, playlist: playlist.id }, 'yesterday playlist updated');
  return { kind: 'yesterday', status: 'success', trackCount: rows.length };
}

async function ensureKnownPlaylist(
  db: DB,
  provider: MusicProvider,
  kind: RunKind,
  name: string,
): Promise<{ id: string; url: string }> {
  const kvKey = `playlist_id:${provider.name}:${kind}`;
  const cached = kvGet(db, kvKey);
  const playlist = await provider.ensurePlaylist(name, cached);
  if (playlist.id !== cached) kvSet(db, kvKey, playlist.id);
  return playlist;
}

function recordRun(
  db: DB,
  kind: RunKind,
  runDate: string,
  now: number,
  trigger: RunTrigger,
  r: {
    status: 'success' | 'failed';
    trackCount?: number;
    playlistId?: string;
    notes?: string | null;
    error?: string;
  },
): number {
  const res = db
    .prepare(
      `INSERT INTO playlist_runs
         (kind, run_date, started_at, finished_at, status, track_count, provider_playlist_id, notes, error, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      runDate,
      now,
      Math.floor(Date.now() / 1000),
      r.status,
      r.trackCount ?? null,
      r.playlistId ?? null,
      r.notes ?? null,
      r.error ?? null,
      trigger,
    );
  return Number(res.lastInsertRowid);
}

/** Both daily playlists, dynamic first. */
export async function runAllPlaylists(
  db: DB,
  providers: MusicProvider[],
  config: Config,
  trigger: RunTrigger,
  log: Logger,
): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  outcomes.push(await runPlaylistJob(db, providers, config, 'dynamic', trigger, log));
  outcomes.push(await runPlaylistJob(db, providers, config, 'yesterday', trigger, log));
  return outcomes;
}
