import { describe, expect, it } from 'vitest';
import { isNonSong } from '../src/ingest/filter.js';

describe('isNonSong', () => {
  it.each([
    ['', '0819-0900,1200,1700 Ken Der News'],
    ['', 'Ken Der News 2020-04-09'],
    ['', 'One Minute Silence'],
    ['', 'Wear A Mask #1-00413'],
    ['', 'PSA - Stanford Master of Liberal Arts Program - 52 secs - 8_14-10_12'],
    ['', 'Thursday 4'],
    ['COVID-19', 'Preventive Steps'],
    ['COVID-19', 'Stanford Athletics COVID-19-00391-v3'],
    ['Some DJ', 'Morning Ken Der News Update'],
    ['Station', 'PSA: Blood Drive'],
    ['Station', 'Wearing A Mask #2-00414'],
    ['   ', 'Whitespace Artist'],
  ])('flags non-song: %j / %j', (artist, title) => {
    expect(isNonSong(artist, title)).toBe(true);
  });

  it.each([
    ['Big Thief', 'Orange (2019)'],
    ['Public Service Broadcasting', 'Go! (2015)'], // "PSA"-adjacent name, real band
    ['Grandaddy', 'A.M. 180'],
    ['M.I.A.', 'Paper Planes'],
    ['The 1975', 'Chocolate'],
    ['Anti-Flag', 'Broken Bones #14'], // short number, not a 5-digit cart id
  ])('keeps real song: %j / %j', (artist, title) => {
    expect(isNonSong(artist, title)).toBe(false);
  });
});
