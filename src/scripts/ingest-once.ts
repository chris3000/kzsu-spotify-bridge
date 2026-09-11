import pino from 'pino';
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { runIngest } from '../ingest/ingest.js';
import { matchTracks } from '../matching/matcher.js';
import { createRegistry } from '../providers/registry.js';

const config = loadConfig();
const log = pino({ level: 'debug', transport: { target: 'pino-pretty' } });
const db = openDb(config.DATABASE_PATH);
const registry = createRegistry(db, config);

const result = await runIngest(db, config, log);
if (result.newTrackIds.length > 0) {
  const m = await matchTracks(db, registry.providers, config, result.newTrackIds, log);
  log.info(m, 'inline matching done');
}
db.close();
