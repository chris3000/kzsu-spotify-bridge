import { describe, expect, it } from 'vitest';
import { normKey, parseTitle } from '../src/ingest/parse.js';

describe('parseTitle', () => {
  it.each([
    ['Orange (2019)', 'Orange', 2019],
    ['Masters of War (2026)', 'Masters of War', 2026],
    ['Just Lust (1978)', 'Just Lust', 1978],
    ['Heat Wave [Live] (2022)', 'Heat Wave', 2022],
    ['I Done Done It (Featuring Jai Malano) (2019)', 'I Done Done It', 2019],
    ['Astronaut (Feat Dean Wareham) (2010)', 'Astronaut', 2010],
    ['A Boy Like You (1995)', 'A Boy Like You', 1995],
    ['No Title Year', 'No Title Year', null],
    ['Song (Live) (2001)', 'Song', 2001],
    ['1979 (1995)', '1979', 1995],
  ])('parses %j', (raw, title, year) => {
    const parsed = parseTitle(raw);
    expect(parsed.title).toBe(title);
    expect(parsed.year).toBe(year);
  });

  it('uses the last year-like parenthetical as the year', () => {
    // "(2010)" could be part of the name; the feed appends year last.
    const p = parseTitle('Remember (1999) (2010)');
    expect(p.year).toBe(2010);
    expect(p.title).toBe('Remember (1999)');
  });

  it('falls back to raw when stripping removes everything', () => {
    const p = parseTitle('(2019)');
    expect(p.title).toBe('(2019)');
    expect(p.year).toBe(2019);
  });
});

describe('normKey', () => {
  it('is stable across case, punctuation, and leading The', () => {
    expect(normKey('The Beatles', "Don't Let Me Down")).toBe(
      normKey('beatles', 'dont let me down'),
    );
  });

  it('differs for different songs', () => {
    expect(normKey('Big Thief', 'Orange')).not.toBe(
      normKey('Big Thief', 'Paul'),
    );
  });
});
