import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { DB } from '../db/client.js';
import type { MusicProvider, ProviderTrack } from '../providers/types.js';
import { artistSimilarity, titleSimilarity } from './similarity.js';

export interface TrackRow {
  id: number;
  title: string;
  artist: string;
  year: number | null;
}

export interface ScoredCandidate {
  candidate: ProviderTrack;
  score: number;
  titleSim: number;
  artistSim: number;
}

const NEAR_MISS_FLOOR = 0.65;
/** Component floors: a match must be plausible on BOTH title and artist, not
 * just on the weighted composite (an exact title can't buy back a wrong artist). */
const TITLE_GATE = 0.6;
const ARTIST_GATE = 0.6;
const BACKOFF_DAYS = [1, 3, 7, 14, 30, 30, 30, 30];
const MAX_ATTEMPTS = 8;
const DAY = 86400;

/** Score a provider candidate against our track: 0.5·title + 0.4·artist + 0.1·year. */
export function evaluateCandidate(
  track: { title: string; artist: string; year: number | null },
  candidate: ProviderTrack,
): Omit<ScoredCandidate, 'candidate'> {
  const titleSim = titleSimilarity(track.title, candidate.title);
  const artistSim = artistSimilarity(track.artist, candidate.artists);
  let yearBonus = 0.5; // unknown on either side
  if (track.year != null && candidate.albumYear != null) {
    yearBonus = Math.abs(track.year - candidate.albumYear) <= 1 ? 1 : 0;
  }
  const score = 0.5 * titleSim + 0.4 * artistSim + 0.1 * yearBonus;
  return { score, titleSim, artistSim };
}

export function isAcceptable(
  scored: Omit<ScoredCandidate, 'candidate'>,
  threshold: number,
): boolean {
  return (
    scored.score >= threshold &&
    scored.titleSim >= TITLE_GATE &&
    scored.artistSim >= ARTIST_GATE
  );
}

export function bestCandidate(
  track: { title: string; artist: string; year: number | null },
  candidates: ProviderTrack[],
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const candidate of candidates) {
    const scored = { candidate, ...evaluateCandidate(track, candidate) };
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
}

export type MatchOutcome =
  | { kind: 'matched'; provider: string; score: number; providerId: string }
  | { kind: 'missed'; reason: string }
  | { kind: 'error'; reason: string };

/**
 * Try to match one track against every registered provider. Records
 * provider_matches on success; updates the retry queue on miss/error.
 */
export async function matchTrack(
  db: DB,
  providers: MusicProvider[],
  config: Config,
  track: TrackRow,
  log: Logger,
): Promise<MatchOutcome> {
  const now = Math.floor(Date.now() / 1000);
  let lastNote = 'no candidates returned';
  let accepted: { provider: string; score: number; providerId: string } | null =
    null;

  for (const provider of providers) {
    if (!(await provider.isReady())) {
      lastNote = `${provider.name}: provider not ready (not authorized)`;
      continue;
    }
    let candidates: ProviderTrack[];
    try {
      candidates = await provider.searchTrack({
        title: track.title,
        artist: track.artist,
        year: track.year,
      });
    } catch (err) {
      const reason = `${provider.name}: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ trackId: track.id, err: reason }, 'provider search failed');
      recordMiss(db, track.id, now, reason);
      return { kind: 'error', reason };
    }

    const best = bestCandidate(track, candidates);
    if (best && isAcceptable(best, config.MATCH_THRESHOLD)) {
      db.prepare(
        `INSERT INTO provider_matches
           (track_id, provider, provider_id, uri, confidence, matched_at, raw_title, raw_artist)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id, provider) DO UPDATE SET
           provider_id = excluded.provider_id, uri = excluded.uri,
           confidence = excluded.confidence, matched_at = excluded.matched_at,
           raw_title = excluded.raw_title, raw_artist = excluded.raw_artist`,
      ).run(
        track.id,
        provider.name,
        best.candidate.providerId,
        best.candidate.uri,
        best.score,
        now,
        best.candidate.title,
        best.candidate.artists.join(', '),
      );
      accepted = {
        provider: provider.name,
        score: best.score,
        providerId: best.candidate.providerId,
      };
      log.debug(
        { trackId: track.id, provider: provider.name, score: best.score },
        'track matched',
      );
    } else if (best && best.score >= NEAR_MISS_FLOOR) {
      lastNote = `${provider.name}: near-miss ${best.score.toFixed(2)}: ${best.candidate.artists.join(', ')} - ${best.candidate.title}`;
    } else if (best) {
      lastNote = `${provider.name}: best score ${best.score.toFixed(2)} below floor`;
    } else {
      lastNote = `${provider.name}: no candidates returned`;
    }
  }

  if (accepted) {
    db.prepare(`UPDATE tracks SET status = 'matched' WHERE id = ?`).run(track.id);
    db.prepare('DELETE FROM match_attempts WHERE track_id = ?').run(track.id);
    return { kind: 'matched', ...accepted };
  }
  recordMiss(db, track.id, now, lastNote);
  return { kind: 'missed', reason: lastNote };
}

function recordMiss(db: DB, trackId: number, now: number, note: string): void {
  const row = db
    .prepare('SELECT attempts FROM match_attempts WHERE track_id = ?')
    .get(trackId) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const backoffDays =
    BACKOFF_DAYS[Math.min(attempts - 1, BACKOFF_DAYS.length - 1)]!;
  db.prepare(
    `INSERT INTO match_attempts (track_id, attempts, last_attempt, next_attempt, last_error)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       attempts = excluded.attempts, last_attempt = excluded.last_attempt,
       next_attempt = excluded.next_attempt, last_error = excluded.last_error`,
  ).run(trackId, attempts, now, now + backoffDays * DAY, note);
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE tracks SET status = 'gave_up' WHERE id = ? AND status = 'unmatched'`,
    ).run(trackId);
  }
}

/** Match a specific set of track ids (used inline after ingest). */
export async function matchTracks(
  db: DB,
  providers: MusicProvider[],
  config: Config,
  trackIds: number[],
  log: Logger,
): Promise<{ matched: number; missed: number }> {
  let matched = 0;
  let missed = 0;
  const select = db.prepare(
    'SELECT id, title, artist, year FROM tracks WHERE id = ?',
  );
  for (const id of trackIds) {
    const track = select.get(id) as TrackRow | undefined;
    if (!track) continue;
    const outcome = await matchTrack(db, providers, config, track, log);
    if (outcome.kind === 'matched') matched++;
    else missed++;
  }
  return { matched, missed };
}
