# KZSU → Spotify Bridge

Polls KZSU Zootopia's recent-songs feed (`http://kzsu.rocks/songs`) hourly,
matches each song to Spotify, and rebuilds two playlists every morning at
3:00 AM Pacific:

- **College Rock Dynamic Playlist** — 150 tracks chosen by a weighted lottery
  (fewer past picks and longer time since last pick → higher odds; 14-day
  cooldown between picks of the same track).
- **KZSU Zootopia- Yesterday's Songs** — everything identified from yesterday's
  airplay, in airing order.

A password-protected dashboard shows library stats, filterable track/play
lists, playlist run history, and admin actions (rebuild now, retry unmatched).

## Local development

```sh
cp .env.example .env      # fill in DASHBOARD_PASSWORD, COOKIE_SECRET, Spotify creds
npm install
npm run dev               # dashboard at http://127.0.0.1:8080
npm test
```

Manual entrypoints:

```sh
npm run ingest:once                # one feed poll + inline matching
npm run playlist:once              # both playlists now (or: -- dynamic | yesterday)
```

## Spotify setup (one time)

1. Create an app at https://developer.spotify.com/dashboard.
2. Add redirect URIs `http://127.0.0.1:8080/auth/spotify/callback` and
   `https://<your-app>.fly.dev/auth/spotify/callback`.
3. Put the client id/secret in `.env` (local) / `fly secrets` (prod).
4. Log in to the dashboard and click **Connect Spotify** (`/auth/spotify`).
   The refresh token is stored in the database; you won't need to do this
   again unless it's revoked.

## Deploying to Fly.io

```sh
fly launch --no-deploy            # creates the app; keep the generated name in fly.toml + PUBLIC_BASE_URL
fly volumes create data --size 1 --region sjc
fly storage create                # Tigris bucket for Litestream backups
fly secrets set \
  DASHBOARD_PASSWORD=... \
  COOKIE_SECRET=... \
  SPOTIFY_CLIENT_ID=... \
  SPOTIFY_CLIENT_SECRET=... \
  LITESTREAM_REPLICA_URL=s3://<bucket>/kzsu.db \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev AWS_REGION=auto
fly deploy
```

Then open the app URL, log in, and connect Spotify. Never scale beyond one
machine — SQLite on a volume is single-writer.

## Architecture

- `src/ingest/` — feed fetch, HH:MM → Pacific timestamp inference (midnight
  rollover), title/year parsing, play dedup, track upsert.
- `src/matching/` — normalization + similarity scoring, accept threshold with
  per-component gates, retry queue with backoff (1d/3d/7d/14d/30d…, gives up
  after 8 tries; retryable from the dashboard).
- `src/providers/` — `MusicProvider` abstraction; Spotify implementation
  (search, ensure/replace playlist, OAuth + token refresh, 429/5xx retry).
  Add future services in `registry.ts`.
- `src/playlists/` — weighted-lottery selection with fallback tiers,
  dynamic/yesterday builders, run bookkeeping (`playlist_runs`/`playlist_entries`).
- `src/scheduler/` — in-process cron: ingest hourly at :05, playlists 03:00,
  retry pass 04:00 (station time), plus boot catch-up for a missed 3am run.
- `src/web/` — Fastify server-rendered dashboard, signed-cookie auth,
  admin routes, Spotify OAuth bootstrap.
- Database: SQLite (WAL) via better-sqlite3; migrations in `src/db/migrations.ts`.
