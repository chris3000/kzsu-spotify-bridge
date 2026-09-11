import { describe, expect, it } from 'vitest';
import {
  artistSimilarity,
  jaroWinkler,
  normalize,
  stringSimilarity,
  stripVersionDecorations,
  titleSimilarity,
  tokenJaccard,
} from '../src/matching/similarity.js';

describe('normalize', () => {
  it('strips diacritics, case, punctuation, and leading The', () => {
    expect(normalize('The Flâming Lips!')).toBe('flaming lips');
    expect(normalize('Mates Of State')).toBe('mates of state');
    expect(normalize('Davíla 666')).toBe('davila 666');
  });

  it('removes apostrophes instead of splitting on them', () => {
    expect(normalize("Don't Let Me Down")).toBe('dont let me down');
  });

  it('maps & to and', () => {
    expect(normalize('Up, Bustle & Out')).toBe('up bustle and out');
  });
});

describe('jaroWinkler', () => {
  it('is 1 for identical strings and 0 for disjoint', () => {
    expect(jaroWinkler('orange', 'orange')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('scores close strings high', () => {
    expect(jaroWinkler('colour', 'color')).toBeGreaterThan(0.85);
  });
});

describe('tokenJaccard', () => {
  it('penalizes token supersets symmetrically', () => {
    expect(tokenJaccard('orange', 'orange juice blues')).toBeCloseTo(1 / 3);
  });
});

describe('stripVersionDecorations', () => {
  it('removes dash suffixes and parentheticals', () => {
    expect(stripVersionDecorations('Orange - Live at the Fillmore')).toBe('Orange');
    expect(stripVersionDecorations('Riptides (2020 Remaster)')).toBe('Riptides');
    expect(stripVersionDecorations('Heat Wave [Live]')).toBe('Heat Wave');
  });

  it('keeps the original when stripping empties the title', () => {
    expect(stripVersionDecorations('(untitled)')).toBe('(untitled)');
  });
});

describe('titleSimilarity', () => {
  it('treats live/remaster decorations as the same song', () => {
    expect(titleSimilarity('Orange', 'Orange - Live')).toBe(1);
    expect(titleSimilarity('Orange', 'Orange (Remastered 2019)')).toBe(1);
  });

  it('does not treat token supersets as the same song', () => {
    expect(titleSimilarity('Orange', 'Orange Juice Blues')).toBeLessThan(0.6);
  });

  it('distinguishes different songs', () => {
    expect(stringSimilarity('Orange', 'Purple Rain')).toBeLessThan(0.6);
  });
});

describe('artistSimilarity', () => {
  it('matches any single artist of a multi-artist credit', () => {
    expect(artistSimilarity('Big Thief', ['Someone Else', 'Big Thief'])).toBe(1);
  });

  it('matches a joint billing against the joined artist list', () => {
    expect(
      artistSimilarity('The Flaming Lips & Stardeath And White Dwarfs', [
        'The Flaming Lips',
        'Stardeath and White Dwarfs',
      ]),
    ).toBeGreaterThan(0.8);
  });

  it('penalizes name extensions like tribute bands', () => {
    expect(artistSimilarity('Big Thief', ['Big Thief Tribute Band'])).toBeLessThan(0.6);
  });
});
