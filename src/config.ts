import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/kzsu.db'),
  DASHBOARD_PASSWORD: z.string().min(1),
  COOKIE_SECRET: z.string().min(32),
  SPOTIFY_CLIENT_ID: z.string().default(''),
  SPOTIFY_CLIENT_SECRET: z.string().default(''),
  PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
  FEED_URL: z.string().url().default('http://kzsu.rocks/songs'),
  DYNAMIC_PLAYLIST_NAME: z.string().default('Indie Rock Dynamic Playlist'),
  YESTERDAY_PLAYLIST_NAME: z.string().default("Zootopia- Yesterday's Songs"),
  PLAYLIST_SIZE: z.coerce.number().int().positive().default(150),
  COOLDOWN_DAYS: z.coerce.number().positive().default(14),
  STALENESS_HALF_DAYS: z.coerce.number().positive().default(30),
  STALENESS_CAP: z.coerce.number().positive().default(4),
  MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  TZ_STATION: z.string().default('America/Los_Angeles'),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
