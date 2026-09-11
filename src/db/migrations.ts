// Migrations are append-only: never edit an existing entry, add a new one.
export const migrations: { name: string; sql: string }[] = [
  {
    name: '0001_initial',
    sql: `
CREATE TABLE tracks (
  id               INTEGER PRIMARY KEY,
  title            TEXT NOT NULL,
  artist           TEXT NOT NULL,
  year             INTEGER,
  norm_key         TEXT NOT NULL UNIQUE,
  date_added       INTEGER NOT NULL,
  times_selected   INTEGER NOT NULL DEFAULT 0,
  last_selected_at INTEGER,
  status           TEXT NOT NULL DEFAULT 'unmatched'
                   CHECK (status IN ('matched','unmatched','gave_up'))
);
CREATE INDEX idx_tracks_status ON tracks(status);
CREATE INDEX idx_tracks_artist ON tracks(artist);
CREATE INDEX idx_tracks_last_selected ON tracks(last_selected_at);

CREATE TABLE provider_matches (
  track_id    INTEGER NOT NULL REFERENCES tracks(id),
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  uri         TEXT,
  confidence  REAL,
  matched_at  INTEGER NOT NULL,
  raw_title   TEXT,
  raw_artist  TEXT,
  PRIMARY KEY (track_id, provider)
);
CREATE INDEX idx_pm_provider_id ON provider_matches(provider, provider_id);

CREATE TABLE plays (
  id         INTEGER PRIMARY KEY,
  track_id   INTEGER NOT NULL REFERENCES tracks(id),
  played_at  INTEGER NOT NULL,
  raw_artist TEXT NOT NULL,
  raw_title  TEXT NOT NULL,
  dedup_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_plays_played_at ON plays(played_at);
CREATE INDEX idx_plays_track ON plays(track_id);

CREATE TABLE match_attempts (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_attempt INTEGER,
  next_attempt INTEGER NOT NULL,
  last_error   TEXT
);
CREATE INDEX idx_ma_next ON match_attempts(next_attempt);

CREATE TABLE playlist_runs (
  id                   INTEGER PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('dynamic','yesterday')),
  run_date             TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  status               TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  track_count          INTEGER,
  provider_playlist_id TEXT,
  notes                TEXT,
  error                TEXT,
  trigger              TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual','catchup'))
);
CREATE INDEX idx_runs_kind_date ON playlist_runs(kind, run_date);

CREATE TABLE playlist_entries (
  run_id   INTEGER NOT NULL REFERENCES playlist_runs(id),
  position INTEGER NOT NULL,
  track_id INTEGER NOT NULL REFERENCES tracks(id),
  PRIMARY KEY (run_id, position)
);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
];
