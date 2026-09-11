import { z } from 'zod';
import type { FeedEntry } from './dateInference.js';

const feedSchema = z.array(
  z.object({
    date: z.string(),
    artist: z.string(),
    title: z.string(),
  }),
);

export async function fetchFeed(url: string): Promise<FeedEntry[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Feed request failed: HTTP ${res.status}`);
  }
  return feedSchema.parse(await res.json());
}
