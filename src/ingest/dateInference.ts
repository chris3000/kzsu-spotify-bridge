import { TZDate } from '@date-fns/tz';

export interface FeedEntry {
  date: string; // "HH:MM" station-local (Pacific) wall clock
  artist: string;
  title: string;
}

export interface DatedEntry extends FeedEntry {
  /** Inferred absolute play time, epoch seconds UTC. */
  playedAt: number;
  /** Station-local calendar date the play happened on, "YYYY-MM-DD". */
  localDate: string;
}

const GRACE_SECONDS = 10 * 60;
const MAX_ROLLBACK_DAYS = 2;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Build the epoch timestamp for wall-clock HH:MM on a given local calendar day.
 * DST fall-back ambiguity resolves to whatever instant TZDate picks; a one-hour
 * imprecision on a handful of plays twice a year only affects played_at, not identity.
 */
function localTimestamp(
  year: number,
  month: number,
  day: number,
  hh: number,
  mm: number,
  timeZone: string,
): number {
  const d = new TZDate(year, month, day, hh, mm, 0, timeZone);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Infer full timestamps for feed entries whose `date` field is only HH:MM.
 *
 * Entries are assumed newest-first (the live feed's order); if they arrive
 * oldest-first we detect it and reverse. Walking newest → oldest, we start at
 * "today" in the station timezone and roll the assumed calendar date back one
 * day whenever a candidate timestamp lands in the future (beyond a grace
 * window) or the wall-clock time increases while walking backward (midnight
 * crossing).
 *
 * Returns entries in the same order they were given, with invalid or
 * too-old-to-anchor entries dropped.
 */
export function inferDates(
  entries: FeedEntry[],
  nowEpochSeconds: number,
  timeZone: string,
): DatedEntry[] {
  if (entries.length === 0) return [];

  const parsed = entries
    .map((e) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(e.date.trim());
      if (!m) return null;
      const hh = parseInt(m[1]!, 10);
      const mm = parseInt(m[2]!, 10);
      if (hh > 23 || mm > 59) return null;
      return { entry: e, hh, mm, minutes: hh * 60 + mm };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (parsed.length === 0) return [];

  // Detect ordering: in a newest-first list, times mostly decrease. Jumps of
  // more than 12h are midnight crossings and vote for the opposite direction.
  let decreases = 0;
  let increases = 0;
  for (let i = 1; i < parsed.length; i++) {
    const diff = parsed[i]!.minutes - parsed[i - 1]!.minutes;
    if (diff === 0) continue;
    if (diff > 720) decreases++;
    else if (diff < -720) increases++;
    else if (diff < 0) decreases++;
    else increases++;
  }
  const newestFirst = decreases >= increases;
  const walk = newestFirst ? parsed : [...parsed].reverse();

  const now = new TZDate(nowEpochSeconds * 1000, timeZone);
  let y = now.getFullYear();
  let mo = now.getMonth();
  let d = now.getDate();
  const startDay = { y, mo, d };
  let rollbacks = 0;
  let prevMinutes: number | null = null;

  const out: DatedEntry[] = [];
  for (const p of walk) {
    // Midnight crossing: walking backward in time, wall clock jumping later
    // means the previous calendar day.
    if (prevMinutes !== null && p.minutes > prevMinutes) {
      if (rollbacks >= MAX_ROLLBACK_DAYS) continue; // feed covers <48h; drop
      const back = new TZDate(y, mo, d, 12, 0, 0, 'UTC');
      back.setDate(back.getDate() - 1);
      y = back.getFullYear();
      mo = back.getMonth();
      d = back.getDate();
      rollbacks++;
    }
    prevMinutes = p.minutes;

    let ts = localTimestamp(y, mo, d, p.hh, p.mm, timeZone);
    // Future beyond grace: entry is from before a midnight we haven't rolled
    // past yet (only possible for the first entries right after midnight).
    if (
      ts > nowEpochSeconds + GRACE_SECONDS &&
      y === startDay.y &&
      mo === startDay.mo &&
      d === startDay.d
    ) {
      if (rollbacks >= MAX_ROLLBACK_DAYS) continue;
      const back = new TZDate(y, mo, d, 12, 0, 0, 'UTC');
      back.setDate(back.getDate() - 1);
      y = back.getFullYear();
      mo = back.getMonth();
      d = back.getDate();
      rollbacks++;
      ts = localTimestamp(y, mo, d, p.hh, p.mm, timeZone);
    }

    out.push({
      ...p.entry,
      playedAt: ts,
      localDate: `${y}-${pad(mo + 1)}-${pad(d)}`,
    });
  }

  return newestFirst ? out : out.reverse();
}
