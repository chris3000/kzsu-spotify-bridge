import { TZDate } from '@date-fns/tz';
import cron from 'node-cron';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { DB } from '../db/client.js';
import { runIngest } from '../ingest/ingest.js';
import { matchTracks } from '../matching/matcher.js';
import { retryUnmatched } from '../matching/retry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import {
  hasSucceededToday,
  pacificDateString,
  runAllPlaylists,
  runPlaylistJob,
} from '../playlists/runner.js';

/** Prevents overlapping executions of the same job on this single instance. */
class JobLock {
  private running = new Set<string>();

  async run(name: string, log: Logger, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) {
      log.warn({ job: name }, 'job still running; skipping this tick');
      return;
    }
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      log.error({ job: name, err }, 'job failed');
    } finally {
      this.running.delete(name);
    }
  }
}

export interface Scheduler {
  ingestNow(): Promise<void>;
  stop(): void;
}

export function startScheduler(
  db: DB,
  registry: ProviderRegistry,
  config: Config,
  log: Logger,
): Scheduler {
  const lock = new JobLock();
  const tz = config.TZ_STATION;

  const ingestJob = () =>
    lock.run('ingest', log, async () => {
      const result = await runIngest(db, config, log);
      if (result.newTrackIds.length > 0) {
        await matchTracks(
          db,
          registry.providers,
          config,
          result.newTrackIds,
          log,
        );
      }
    });

  const playlistJob = (trigger: 'cron' | 'catchup') =>
    lock.run('playlists', log, async () => {
      await runAllPlaylists(db, registry.providers, config, trigger, log);
    });

  const retryJob = () =>
    lock.run('retry', log, async () => {
      await retryUnmatched(db, registry.providers, config, log);
    });

  const tasks = [
    cron.schedule('5 * * * *', ingestJob, { timezone: tz }),
    cron.schedule('0 3 * * *', () => playlistJob('cron'), { timezone: tz }),
    cron.schedule('0 4 * * *', retryJob, { timezone: tz }),
  ];

  // Boot: ingest immediately (idempotent), and catch up on a missed 3am run.
  void ingestJob().then(() => {
    const now = Math.floor(Date.now() / 1000);
    const local = new TZDate(now * 1000, tz);
    if (local.getHours() >= 3) {
      const today = pacificDateString(now, tz);
      const dynamicDue = !hasSucceededToday(db, 'dynamic', today);
      const yesterdayDue = !hasSucceededToday(db, 'yesterday', today);
      if (dynamicDue || yesterdayDue) {
        log.info({ dynamicDue, yesterdayDue }, 'running playlist catch-up');
        void playlistJob('catchup');
      }
    }
  });

  log.info('scheduler started (ingest hourly at :05, playlists 03:00, retry 04:00 station time)');

  return {
    ingestNow: ingestJob,
    stop: () => tasks.forEach((t) => t.stop()),
  };
}

export { runPlaylistJob };
