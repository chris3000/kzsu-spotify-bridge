import { normalize } from '../matching/similarity.js';

/**
 * Feed entries that are station programming, not songs — news segments,
 * PSAs, health alerts — and should never be stored or matched.
 *
 * Patterns observed in real KZSU data:
 *   - empty artist field (news/PSA carts: "0819-0900,1200,1700 Ken Der News",
 *     "One Minute Silence", "Wear A Mask #1-00413", "PSA - Stanford ...")
 *   - artist "COVID-19" (station health announcements)
 *   - "Ken Der News" anywhere in the title
 *   - titles beginning with "PSA"
 *   - broadcast cart numbers like "#1-00413" in the title
 */
export function isNonSong(artist: string, rawTitle: string): boolean {
  if (normalize(artist) === '') return true;
  if (normalize(artist) === 'covid 19') return true;
  const title = rawTitle.toLowerCase();
  if (title.includes('ken der news')) return true;
  if (/^\s*psa\b/.test(title)) return true;
  if (/#\d+-\d{4,}/.test(title)) return true;
  return false;
}
