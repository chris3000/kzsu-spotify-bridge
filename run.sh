#!/bin/sh
set -e

DB_PATH="${DATABASE_PATH:-/data/kzsu.db}"

# Restore from the replica if the volume is empty (fresh machine / recovery).
if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  litestream restore -if-db-not-exists -if-replica-exists -o "$DB_PATH" "$LITESTREAM_REPLICA_URL"
  exec litestream replicate -exec "node dist/index.js" "$DB_PATH" "$LITESTREAM_REPLICA_URL"
else
  echo "LITESTREAM_REPLICA_URL not set; running without replication" >&2
  exec node dist/index.js
fi
