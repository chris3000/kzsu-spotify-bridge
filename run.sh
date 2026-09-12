#!/bin/sh
set -e

# Single source of truth for the DB path: the app reads DATABASE_PATH, and
# litestream.yml expands ${DATABASE_PATH}, so all three always agree.
export DATABASE_PATH="${DATABASE_PATH:-/data/kzsu.db}"

# Restore from the replica if the volume is empty (fresh machine / recovery).
if [ -n "$BUCKET_NAME" ]; then
  litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$DATABASE_PATH"
  exec litestream replicate -config /etc/litestream.yml -exec "node dist/index.js"
else
  echo "BUCKET_NAME not set; running without replication" >&2
  exec node dist/index.js
fi
