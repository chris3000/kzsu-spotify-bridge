import pino from 'pino';
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { runAllPlaylists, runPlaylistJob, type RunKind } from '../playlists/runner.js';
import { createRegistry } from '../providers/registry.js';

const config = loadConfig();
const log = pino({ level: 'debug', transport: { target: 'pino-pretty' } });
const db = openDb(config.DATABASE_PATH);
const registry = createRegistry(db, config);

const kindArg = process.argv[2]; // optional: dynamic | yesterday
if (kindArg === 'dynamic' || kindArg === 'yesterday') {
  const outcome = await runPlaylistJob(
    db, registry.providers, config, kindArg as RunKind, 'manual', log,
  );
  log.info(outcome, 'run finished');
} else {
  const outcomes = await runAllPlaylists(db, registry.providers, config, 'manual', log);
  log.info({ outcomes }, 'runs finished');
}
db.close();
