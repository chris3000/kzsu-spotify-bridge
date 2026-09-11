/**
 * Normalize a string for identity keys and similarity comparison:
 * NFKD → strip diacritics → lowercase → drop apostrophes → '&'→'and'
 * → strip non-alphanumerics → drop leading article "the" → collapse whitespace.
 */
export function normalize(s: string): string {
  let out = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.startsWith('the ')) out = out.slice(4);
  return out;
}

/** Jaro similarity in [0, 1]. */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchWindow = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(lb - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (
    (matches / la + matches / lb + (matches - transpositions) / matches) / 3
  );
}

/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1, max prefix 4). */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

/** Symmetric token Jaccard: |intersection| / |union|. */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Core similarity on two raw strings after normalization: max of token
 * Jaccard and Jaro-Winkler damped by token-count ratio. The damping stops
 * JW's prefix boost from calling "Orange" ≈ "Orange Juice Blues" or
 * "Big Thief" ≈ "Big Thief Tribute Band" a match.
 */
export function stringSimilarity(rawA: string, rawB: string): number {
  const a = normalize(rawA);
  const b = normalize(rawB);
  if (a === b) return a.length > 0 ? 1 : 0;
  if (!a || !b) return 0;
  const na = a.split(' ').length;
  const nb = b.split(' ').length;
  const damp = Math.min(na, nb) / Math.max(na, nb);
  return Math.max(tokenJaccard(a, b), jaroWinkler(a, b) * damp);
}

/**
 * Remove provider version decorations from a title: parentheticals/brackets
 * and a " - ..." suffix (Spotify's convention for "- Live", "- Remastered
 * 2009", "- Radio Edit", ...). Falls back to the original if stripping
 * removes everything.
 */
export function stripVersionDecorations(title: string): string {
  const stripped = title
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : title;
}

/** Title similarity: best score across decoration-stripped variants of both sides. */
export function titleSimilarity(ourTitle: string, candidateTitle: string): number {
  const ours = [...new Set([ourTitle, stripVersionDecorations(ourTitle)])];
  const theirs = [
    ...new Set([candidateTitle, stripVersionDecorations(candidateTitle)]),
  ];
  let best = 0;
  for (const a of ours) {
    for (const b of theirs) {
      best = Math.max(best, stringSimilarity(a, b));
    }
  }
  return best;
}

/**
 * Artist similarity: our artist string (possibly a joint billing like
 * "A & B") against each candidate artist individually and all of them joined.
 */
export function artistSimilarity(
  ourArtist: string,
  candidateArtists: string[],
): number {
  const variants = [...candidateArtists];
  if (candidateArtists.length > 1) variants.push(candidateArtists.join(' '));
  return Math.max(0, ...variants.map((a) => stringSimilarity(ourArtist, a)));
}
