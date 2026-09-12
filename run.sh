#!/bin/sh
set -e

DB_PATH="${DATABASE_PATH:-/data/kzsu.db}"

# Restore from the replica if the volume is empty (fresh machine / recovery).
if [ -n "$BUCKET_NAME" ]; then
  litestream restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml "$DB_PATH"
  exec litestream replicate -config /etc/litestream.yml -exec "node dist/index.js"
else
  echo "BUCKET_NAME not set; running without replication" >&2
  exec node dist/index.js
fi
