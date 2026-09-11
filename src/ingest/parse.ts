import { normalize } from '../matching/similarity.js';

export interface ParsedTitle {
  /** Cleaned title: year and noise markers stripped. */
  title: string;
  /** Release year extracted from a trailing "(YYYY)" marker, if present. */
  year: number | null;
}

const YEAR_RE = /\(((?:19|20)\d{2})\)/g;
const NOISE_RES = [
  /\[live\]/gi,
  /\(live\)/gi,
  /\((?:featuring|feat\.?|ft\.?)\s+[^)]*\)/gi,
  /\[(?:featuring|feat\.?|ft\.?)\s+[^)]*\]/gi,
  /\s+-\s+live$/gi,
];

/** Parse a raw KZSU feed title like "Orange (2019)" or "Heat Wave [Live] (2022)". */
export function parseTitle(raw: string): ParsedTitle {
  let title = raw;
  let year: number | null = null;

  // Use the LAST year-looking parenthetical — some titles legitimately contain
  // numbers; the feed appends the release year at the end.
  const matches = [...title.matchAll(YEAR_RE)];
  const last = matches[matches.length - 1];
  if (last) {
    year = parseInt(last[1]!, 10);
    title =
      title.slice(0, last.index) + title.slice(last.index + last[0].length);
  }

  for (const re of NOISE_RES) title = title.replace(re, ' ');
  title = title.replace(/\s+/g, ' ').trim();
  // A title that was ONLY noise (shouldn't happen) falls back to the raw string.
  if (title.length === 0) title = raw.trim();
  return { title, year };
}

/** Identity key for a track: normalized artist + title. */
export function normKey(artist: string, cleanedTitle: string): string {
  return `${normalize(artist)}|${normalize(cleanedTitle)}`;
}
