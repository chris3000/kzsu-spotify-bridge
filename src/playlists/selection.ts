import type { Config } from '../config.js';
import type { DB } from '../db/client.js';

export interface SelectableTrack {
  id: number;
  uri: string;
  times_selected: number;
  last_selected_at: number | null;
}

export interface SelectionResult {
  tracks: SelectableTrack[];
  /** 0 = normal cooldown, 1 = relaxed to 7d, 2 = no cooldown, 3 = whole catalog. */
  fallbackTier: number;
}

const DAY = 86400;

/**
 * Weight for the lottery: decays hyperbolically with pick count, grows
 * linearly with staleness (capped), never-selected tracks get the cap.
 */
export function trackWeight(
  t: { times_selected: number; last_selected_at: number | null },
  now: number,
  config: Config,
): number {
  const staleness =
    t.last_selected_at == null
      ? config.STALENESS_CAP
      : Math.min(
          (now - t.last_selected_at) / DAY / config.STALENESS_HALF_DAYS,
          config.STALENESS_CAP,
        );
  return (1 / (1 + t.times_selected)) * Math.max(staleness, 0.01);
}

function eligibleTracks(
  db: DB,
  provider: string,
  cooldownCutoff: number | null,
  excludeIds: Set<number>,
): SelectableTrack[] {
  const rows = db
    .prepare(
      `SELECT t.id, pm.uri, t.times_selected, t.last_selected_at
       FROM tracks t
       JOIN provider_matches pm ON pm.track_id = t.id AND pm.provider = ?
       WHERE t.status = 'matched' AND pm.uri IS NOT NULL
         AND (? IS NULL OR t.last_selected_at IS NULL OR t.last_selected_at < ?)`,
    )
    .all(provider, cooldownCutoff, cooldownCutoff) as SelectableTrack[];
  return rows.filter((r) => !excludeIds.has(r.id));
}

/**
 * Weighted sampling without replacement (exponential-sort trick): each track
 * gets key = -ln(U)/weight; the `size` smallest keys win.
 */
export function weightedSample(
  tracks: SelectableTrack[],
  size: number,
  now: number,
  config: Config,
  rng: () => number,
): SelectableTrack[] {
  return tracks
    .map((t) => {
      const u = Math.max(rng(), 1e-12);
      return { t, key: -Math.log(u) / trackWeight(t, now, config) };
    })
    .sort((a, b) => a.key - b.key)
    .slice(0, size)
    .map((x) => x.t);
}

/**
 * Pick tracks for the dynamic playlist, relaxing constraints in tiers if the
 * eligible pool is smaller than the playlist size.
 */
export function selectDynamicTracks(
  db: DB,
  provider: string,
  config: Config,
  now: number,
  rng: () => number = Math.random,
): SelectionResult {
  const size = config.PLAYLIST_SIZE;
  const none = new Set<number>();

  const tiers: { cutoff: number | null; exclude: Set<number> }[] = [
    { cutoff: now - config.COOLDOWN_DAYS * DAY, exclude: none },
    { cutoff: now - 7 * DAY, exclude: none },
    // No cooldown, but avoid exact repeats of the latest successful run.
    { cutoff: null, exclude: lastRunTrackIds(db) },
    { cutoff: null, exclude: none },
  ];

  for (let tier = 0; tier < tiers.length; tier++) {
    const { cutoff, exclude } = tiers[tier]!;
    const pool = eligibleTracks(db, provider, cutoff, exclude);
    if (pool.length >= size || tier === tiers.length - 1) {
      return {
        tracks: weightedSample(pool, size, now, config, rng),
        fallbackTier: tier,
      };
    }
  }
  return { tracks: [], fallbackTier: 3 }; // unreachable
}

function lastRunTrackIds(db: DB): Set<number> {
  const run = db
    .prepare(
      `SELECT id FROM playlist_runs WHERE kind = 'dynamic' AND status = 'success'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get() as { id: number } | undefined;
  if (!run) return new Set();
  const rows = db
    .prepare('SELECT track_id FROM playlist_entries WHERE run_id = ?')
    .all(run.id) as { track_id: number }[];
  return new Set(rows.map((r) => r.track_id));
}
