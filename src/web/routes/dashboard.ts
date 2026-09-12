import { TZDate } from '@date-fns/tz';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { kvGet, type DB } from '../../db/client.js';
import { pacificDateString } from '../../playlists/runner.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { PLAYLIST_RUN_HOUR } from '../../scheduler/scheduler.js';
import {
  badge,
  esc,
  fmtAgo,
  fmtEpoch,
  fmtNum,
  html,
  layout,
  pagerFoot,
  raw,
  type NavCtx,
} from '../views/html.js';

const PAGE_SIZE = 25;
const DAY = 86400;

interface TrackFilters {
  q?: string;
  artist?: string;
  year?: string;
  status?: string;
  added_after?: string;
  added_before?: string;
  min_selected?: string;
  sort?: string;
  dir?: string;
  page?: string;
}

// Sidebar counts change only on ingest/playlist runs; a short cache keeps
// navigation from re-scanning three tables (plays grows unboundedly).
const COUNTS_TTL_MS = 10_000;
const countsCache = new WeakMap<DB, { at: number; counts: NavCtx['counts'] }>();

function navCounts(db: DB): NavCtx['counts'] {
  const cached = countsCache.get(db);
  if (cached && Date.now() - cached.at < COUNTS_TTL_MS) return cached.counts;
  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  const counts = {
    tracks: count('SELECT COUNT(*) c FROM tracks'),
    plays: count('SELECT COUNT(*) c FROM plays'),
    runs: count('SELECT COUNT(*) c FROM playlist_runs'),
  };
  countsCache.set(db, { at: Date.now(), counts });
  return counts;
}

function navCtx(
  db: DB,
  registry: ProviderRegistry,
  config: Config,
  active: NavCtx['active'],
): NavCtx {
  const local = new TZDate(Date.now(), config.TZ_STATION);
  const runLabel = `${String(PLAYLIST_RUN_HOUR).padStart(2, '0')}:00`;
  return {
    active,
    counts: navCounts(db),
    // A pure DB check — never a network round-trip. Revoked tokens are
    // cleared by SpotifyAuth on invalid_grant, so this stays truthful.
    spotifyReady: registry.spotifyAuth.hasRefreshToken(),
    nextRunLabel:
      local.getHours() < PLAYLIST_RUN_HOUR ? runLabel : `${runLabel} +1d`,
  };
}

export function registerDashboard(
  app: FastifyInstance,
  db: DB,
  registry: ProviderRegistry,
  config: Config,
): void {
  const tz = config.TZ_STATION;

  app.get('/', async (_req, reply) => {
    const nav = navCtx(db, registry, config, 'overview');
    const count = (sql: string, ...args: unknown[]): number =>
      (db.prepare(sql).get(...args) as { c: number }).c;
    const now = Math.floor(Date.now() / 1000);

    const matched = count(`SELECT COUNT(*) c FROM tracks WHERE status = 'matched'`);
    const unresolved = count(`SELECT COUNT(*) c FROM tracks WHERE status IN ('unmatched','gave_up')`);
    const total = matched + unresolved;
    const matchedWeek = count(
      `SELECT COUNT(*) c FROM provider_matches WHERE matched_at >= ?`,
      now - 7 * DAY,
    );
    const plays24h = count('SELECT COUNT(*) c FROM plays WHERE played_at >= ?', now - DAY);
    const failedRuns = count(
      `SELECT COUNT(*) c FROM playlist_runs WHERE status = 'failed' AND started_at >= ?`,
      now - 7 * DAY,
    );
    const lastIngest = Number(kvGet(db, 'last_ingest_at')) || null;
    const matchRate = total > 0 ? ((matched / total) * 100).toFixed(1) : '0.0';

    // Tracks matched per day, last 14 station-local days. Bucketing happens
    // in JS via the station timezone so SQL server-local dates can't skew it.
    const matchEpochs = db
      .prepare('SELECT matched_at FROM provider_matches WHERE matched_at >= ?')
      .all(now - 15 * DAY) as { matched_at: number }[];
    const byDay = new Map<string, number>();
    for (const m of matchEpochs) {
      const d = pacificDateString(m.matched_at, tz);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    const bars: { n: number; label: string }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new TZDate(now * 1000, tz);
      day.setDate(day.getDate() - i);
      const d = pacificDateString(Math.floor(day.getTime() / 1000), tz);
      bars.push({ n: byDay.get(d) ?? 0, label: d });
    }
    const barMax = Math.max(1, ...bars.map((b) => b.n));

    // Unresolved by cause, from retry-queue notes.
    const causeRows = db
      .prepare(
        `SELECT ma.last_error e, COUNT(*) c
         FROM match_attempts ma JOIN tracks t ON t.id = ma.track_id
         WHERE t.status IN ('unmatched','gave_up')
         GROUP BY ma.last_error`,
      )
      .all() as { e: string | null; c: number }[];
    const causes = new Map<string, number>();
    const bump = (k: string, n: number) => causes.set(k, (causes.get(k) ?? 0) + n);
    for (const r of causeRows) {
      const e = r.e ?? '';
      if (e.includes('no candidates')) bump('No Spotify result', r.c);
      else if (e.includes('near-miss')) bump('Near miss (review)', r.c);
      else if (e.includes('below floor')) bump('Low similarity', r.c);
      else bump('Other / pending', r.c);
    }
    const causeList = [...causes.entries()].sort((a, b) => b[1] - a[1]);
    const causeMax = Math.max(1, ...causeList.map(([, n]) => n));

    const recent = db
      .prepare(
        `SELECT p.track_id, p.played_at, p.raw_artist, p.raw_title, t.status
         FROM plays p JOIN tracks t ON t.id = p.track_id
         ORDER BY p.played_at DESC LIMIT 6`,
      )
      .all() as { track_id: number; played_at: number; raw_artist: string; raw_title: string; status: string }[];

    const body = html`
      <header class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="meta">last sync ${fmtAgo(lastIngest)} · ${plays24h} spins in 24h</p>
        </div>
        <div class="actions">
          <form method="post" action="/admin/retry-unmatched"><button class="btn">Retry unmatched</button></form>
          <form method="post" action="/admin/rebuild?kind=all"><button class="btn btn-primary">Rebuild playlists</button></form>
        </div>
      </header>

      <section class="tiles">
        <div class="tile">
          <div class="label">Tracks matched</div>
          <div class="num">${fmtNum(matched)}</div>
          <div class="delta up">+${fmtNum(matchedWeek)} this week</div>
        </div>
        <div class="tile">
          <div class="label">Match rate</div>
          <div class="num">${matchRate}%</div>
          <div class="delta">${fmtNum(unresolved)} unresolved</div>
        </div>
        <div class="tile">
          <div class="label">Plays</div>
          <div class="num">${fmtNum(nav.counts.plays)}</div>
          <div class="delta up">+${fmtNum(plays24h)} last 24h</div>
        </div>
        <div class="tile">
          <div class="label">Failed runs · 7d</div>
          <div class="num">${fmtNum(failedRuns)}</div>
          <div class="delta ${failedRuns > 0 ? 'warn' : ''}">
            ${failedRuns > 0 ? 'needs attention' : 'all in sync'}
          </div>
        </div>
      </section>

      <section class="grid2">
        <div class="card">
          <div class="card-head">
            <h2>Tracks matched</h2>
            <span class="tag">14D</span>
          </div>
          <div class="bars">
            ${raw(
              bars
                .map(
                  (b) =>
                    `<div class="bar" style="height:${Math.round((b.n / barMax) * 100)}%" title="${esc(`${b.n} matched · ${b.label}`)}"></div>`,
                )
                .join(''),
            )}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Unresolved by cause</h2></div>
          <div class="causes">
            ${raw(
              causeList.length === 0
                ? '<span class="tag">nothing unresolved</span>'
                : causeList
                    .map(
                      ([name, n]) => html`<div class="cause">
                        <span class="name">${name}</span>
                        <span class="track"><span class="fill" style="width:${Math.round((n / causeMax) * 100)}%"></span></span>
                        <span class="n">${n}</span>
                      </div>`,
                    )
                    .join(''),
            )}
          </div>
        </div>
      </section>

      <section class="tcard">
        <div class="card-bar">
          <h2>Recent spins</h2>
          <a class="more" href="/tracks">all tracks →</a>
        </div>
        <div class="overflow"><table>
          <tbody>
            ${raw(
              recent
                .map(
                  (r) => html`<tr class="click" data-href="/tracks/${r.track_id}">
                    <td class="strong">${r.raw_artist}</td>
                    <td>${r.raw_title}</td>
                    <td class="mono">${fmtEpoch(r.played_at, tz)}</td>
                    <td>${badge(r.status)}</td>
                  </tr>`,
                )
                .join(''),
            )}
          </tbody>
        </table></div>
      </section>
    `;
    return reply.type('text/html').send(layout('Overview', body, nav));
  });

  app.get<{ Querystring: TrackFilters }>('/tracks', async (req, reply) => {
    const nav = navCtx(db, registry, config, 'tracks');
    const q = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.q) {
      where.push('(t.artist LIKE ? OR t.title LIKE ?)');
      args.push(`%${q.q}%`, `%${q.q}%`);
    }
    if (q.artist) {
      where.push('t.artist LIKE ?');
      args.push(`%${q.artist}%`);
    }
    if (q.year && /^\d{4}$/.test(q.year)) {
      where.push('t.year = ?');
      args.push(Number(q.year));
    }
    if (q.status && ['matched', 'unmatched', 'gave_up'].includes(q.status)) {
      where.push('t.status = ?');
      args.push(q.status);
    }
    if (q.added_after) {
      where.push('t.date_added >= ?');
      args.push(Math.floor(new Date(q.added_after).getTime() / 1000));
    }
    if (q.added_before) {
      where.push('t.date_added < ?');
      args.push(Math.floor(new Date(q.added_before).getTime() / 1000) + DAY);
    }
    if (q.min_selected && /^\d+$/.test(q.min_selected)) {
      where.push('t.times_selected >= ?');
      args.push(Number(q.min_selected));
    }

    const sortCols: Record<string, string> = {
      artist: 't.artist',
      title: 't.title',
      year: 't.year',
      added: 't.date_added',
      picks: 't.times_selected',
      last_picked: 't.last_selected_at',
      status: 't.status',
    };
    const sortKey = sortCols[q.sort ?? ''] ? q.sort! : 'added';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const orderBy = `${sortCols[sortKey]} ${dir}${dir === 'DESC' ? ' NULLS LAST' : ''}`;
    const page = Math.max(1, Number(q.page) || 1);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db.prepare(`SELECT COUNT(*) c FROM tracks t ${whereSql}`).get(...args) as { c: number }
    ).c;
    const rows = db
      .prepare(
        `SELECT t.*, pm.provider_id AS spotify_id
         FROM tracks t
         LEFT JOIN provider_matches pm ON pm.track_id = t.id AND pm.provider = 'spotify'
         ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[];

    const qs = (overrides: Record<string, string>) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...q, ...overrides })) {
        if (v) params.set(k, String(v));
      }
      const s = params.toString();
      return s ? `/tracks?${s}` : '/tracks';
    };
    const sortLink = (key: string, label: string) => {
      const on = sortKey === key;
      const nextDir = on && dir === 'DESC' ? 'asc' : 'desc';
      const arrow = on ? (dir === 'ASC' ? ' ↑' : ' ↓') : '';
      return raw(
        `<a class="${on ? 'on' : ''}" href="${esc(qs({ sort: key, dir: nextDir, page: '' }))}">${esc(label + arrow)}</a>`,
      );
    };
    const chips: { key: string; label: string }[] = [
      { key: '', label: 'all' },
      { key: 'matched', label: 'matched' },
      { key: 'unmatched', label: 'unmatched' },
      { key: 'gave_up', label: 'gave up' },
    ];
    const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, page * PAGE_SIZE);

    const body = html`
      <header class="page-head">
        <div>
          <h1>Tracks</h1>
          <p class="meta">${fmtNum(total)} records · ${q.status ? q.status.replace('_', ' ') : 'all statuses'}</p>
        </div>
      </header>

      <div class="toolbar">
        <form class="search" method="get" action="/tracks">
          <input type="search" name="q" value="${q.q ?? ''}" placeholder="Search artist or title…" />
          <input type="text" name="year" value="${q.year ?? ''}" placeholder="Year" style="flex:none;width:70px" />
          <input type="text" name="min_selected" value="${q.min_selected ?? ''}" placeholder="Min picks" style="flex:none;width:86px" />
          <input type="date" name="added_after" value="${q.added_after ?? ''}" title="First heard after" style="flex:none" />
          <input type="date" name="added_before" value="${q.added_before ?? ''}" title="First heard before" style="flex:none" />
          <button class="btn" style="margin-left:6px">Filter</button>
          ${q.status ? raw(`<input type="hidden" name="status" value="${esc(q.status)}">`) : ''}
          ${q.sort ? raw(`<input type="hidden" name="sort" value="${esc(q.sort)}">`) : ''}
          ${q.dir ? raw(`<input type="hidden" name="dir" value="${esc(q.dir)}">`) : ''}
          ${q.artist ? raw(`<input type="hidden" name="artist" value="${esc(q.artist)}">`) : ''}
        </form>
        <div class="chips">
          ${raw(
            chips
              .map(
                (c) =>
                  `<a class="chip ${(q.status ?? '') === c.key ? 'on' : ''}" href="${esc(qs({ status: c.key, page: '' }))}">${esc(c.label)}</a>`,
              )
              .join(''),
          )}
        </div>
      </div>

      <section class="tcard" style="margin-top:0">
        <div class="overflow"><table>
          <thead>
            <tr>
              <th>${sortLink('artist', 'Artist')}</th>
              <th>${sortLink('title', 'Title')}</th>
              <th>${sortLink('year', 'Year')}</th>
              <th>${sortLink('added', 'First heard')}</th>
              <th>${sortLink('picks', 'Picks')}</th>
              <th>${sortLink('last_picked', 'Last picked')}</th>
              <th>${sortLink('status', 'Match')}</th>
            </tr>
          </thead>
          <tbody>
            ${raw(
              rows
                .map(
                  (t) => html`<tr class="click" data-href="/tracks/${t.id}">
                    <td class="strong">${t.artist}</td>
                    <td>${t.title}</td>
                    <td class="mono">${t.year ?? '—'}</td>
                    <td class="mono">${fmtEpoch(t.date_added as number, tz)}</td>
                    <td class="mono">${t.times_selected}</td>
                    <td class="mono">${fmtEpoch(t.last_selected_at as number | null, tz)}</td>
                    <td>${badge(t.status as string)}</td>
                  </tr>`,
                )
                .join(''),
            )}
          </tbody>
        </table></div>
        ${pagerFoot({
          from,
          to,
          total,
          prevHref: page > 1 ? qs({ page: String(page - 1) }) : null,
          nextHref: to < total ? qs({ page: String(page + 1) }) : null,
        })}
      </section>
    `;
    return reply.type('text/html').send(layout('Tracks', body, nav));
  });

  app.get<{ Params: { id: string } }>('/tracks/:id', async (req, reply) => {
    const nav = navCtx(db, registry, config, 'tracks');
    const track = db
      .prepare('SELECT * FROM tracks WHERE id = ?')
      .get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!track) return reply.code(404).send('track not found');
    const match = db
      .prepare(
        `SELECT * FROM provider_matches WHERE track_id = ? AND provider = 'spotify'`,
      )
      .get(track.id) as Record<string, unknown> | undefined;
    const attempt = db
      .prepare('SELECT * FROM match_attempts WHERE track_id = ?')
      .get(track.id) as Record<string, unknown> | undefined;
    const playCount = (
      db.prepare('SELECT COUNT(*) c FROM plays WHERE track_id = ?').get(track.id) as {
        c: number;
      }
    ).c;

    const fields: [string, string][] = [
      ['artist', String(track.artist)],
      ['year', track.year ? String(track.year) : '—'],
      ['status', String(track.status).replace('_', ' ')],
      ['first heard', fmtEpoch(track.date_added as number, tz)],
      ['spins', String(playCount)],
      ['picks', String(track.times_selected)],
      ['last picked', fmtEpoch(track.last_selected_at as number | null, tz)],
      [
        'confidence',
        match?.confidence != null ? `${Math.round(Number(match.confidence) * 100)}%` : '—',
      ],
      ['match note', attempt?.last_error ? String(attempt.last_error) : '—'],
      ['spotify uri', match?.uri ? String(match.uri) : '—'],
    ];

    const body = html`
      <div class="detail">
        <div class="eyebrow">Spin record</div>
        <h2>${track.title}</h2>
        <div class="artist">${track.artist}</div>
        <div class="fields">
          ${raw(
            fields
              .map(
                ([k, v]) =>
                  html`<div class="field"><span class="k">${k}</span><span class="v">${v}</span></div>`,
              )
              .join(''),
          )}
        </div>
        <div class="actions" style="margin-top:18px">
          <form method="post" action="/admin/retry-unmatched/${track.id}">
            <button class="btn btn-primary">Re-match</button>
          </form>
          ${match
            ? raw(
                `<a class="btn" href="https://open.spotify.com/track/${esc(match.provider_id)}">Open in Spotify</a>`,
              )
            : ''}
          <a class="btn" href="/tracks">Back to tracks</a>
        </div>
      </div>
    `;
    return reply.type('text/html').send(layout(String(track.title), body, nav));
  });

  app.get<{ Querystring: { page?: string } }>('/plays', async (req, reply) => {
    const nav = navCtx(db, registry, config, 'plays');
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = db
      .prepare(
        `SELECT p.track_id, p.played_at, p.raw_artist, p.raw_title, t.status
         FROM plays p JOIN tracks t ON t.id = p.track_id
         ORDER BY p.played_at DESC LIMIT ? OFFSET ?`,
      )
      .all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[];
    const total = nav.counts.plays;
    const from = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const to = (page - 1) * PAGE_SIZE + rows.length;

    const body = html`
      <header class="page-head">
        <div>
          <h1>Plays</h1>
          <p class="meta">${fmtNum(nav.counts.plays)} spins captured</p>
        </div>
      </header>
      <section class="tcard" style="margin-top:0">
        <div class="overflow"><table>
          <thead>
            <tr><th>Aired</th><th>Artist</th><th>Title (raw)</th><th>Match</th></tr>
          </thead>
          <tbody>
            ${raw(
              rows
                .map(
                  (p) => html`<tr class="click" data-href="/tracks/${p.track_id}">
                    <td class="mono">${fmtEpoch(p.played_at as number, tz)}</td>
                    <td class="strong">${p.raw_artist}</td>
                    <td>${p.raw_title}</td>
                    <td>${badge(p.status as string)}</td>
                  </tr>`,
                )
                .join(''),
            )}
          </tbody>
        </table></div>
        ${pagerFoot({
          from,
          to,
          total,
          prevHref: page > 1 ? `/plays?page=${page - 1}` : null,
          nextHref: to < total ? `/plays?page=${page + 1}` : null,
        })}
      </section>
    `;
    return reply.type('text/html').send(layout('Plays', body, nav));
  });

  app.get('/runs', async (_req, reply) => {
    const nav = navCtx(db, registry, config, 'runs');
    const rows = db
      .prepare('SELECT * FROM playlist_runs ORDER BY started_at DESC LIMIT 100')
      .all() as Record<string, unknown>[];
    const body = html`
      <header class="page-head">
        <div>
          <h1>Sync runs</h1>
          <p class="meta">last 100 playlist builds</p>
        </div>
      </header>
      <section class="tcard" style="margin-top:0">
        <div class="overflow"><table>
          <thead>
            <tr><th>Run</th><th>Playlist</th><th>Date</th><th>Status</th><th>Trigger</th><th>Tracks</th><th>Notes</th><th>Started</th></tr>
          </thead>
          <tbody>
            ${raw(
              rows
                .map(
                  (r) => html`<tr class="click" data-href="/runs/${r.id}">
                    <td class="mono">#${r.id}</td>
                    <td class="strong">${r.kind}</td>
                    <td class="mono">${r.run_date}</td>
                    <td>${badge(r.status as string)}</td>
                    <td class="mono">${r.trigger}</td>
                    <td class="mono">${r.track_count ?? '—'}</td>
                    <td class="dim">${r.notes ?? r.error ?? ''}</td>
                    <td class="mono">${fmtEpoch(r.started_at as number, tz)}</td>
                  </tr>`,
                )
                .join(''),
            )}
          </tbody>
        </table></div>
      </section>
    `;
    return reply.type('text/html').send(layout('Sync runs', body, nav));
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const nav = navCtx(db, registry, config, 'runs');
    const run = db
      .prepare('SELECT * FROM playlist_runs WHERE id = ?')
      .get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!run) return reply.code(404).send('run not found');
    const entries = db
      .prepare(
        `SELECT pe.position, pe.track_id, t.title, t.artist, t.year
         FROM playlist_entries pe JOIN tracks t ON t.id = pe.track_id
         WHERE pe.run_id = ? ORDER BY pe.position`,
      )
      .all(run.id) as Record<string, unknown>[];

    const body = html`
      <header class="page-head">
        <div>
          <h1>Run #${run.id} · ${run.kind}</h1>
          <p class="meta">
            ${run.run_date} · ${run.trigger} · ${run.track_count ?? 0} tracks
            ${run.notes ? ` · ${run.notes}` : ''}${run.error ? ` · ${run.error}` : ''}
          </p>
        </div>
        <div class="actions">${badge(run.status as string)}</div>
      </header>
      <section class="tcard" style="margin-top:0">
        <div class="overflow"><table>
          <thead><tr><th>#</th><th>Artist</th><th>Title</th><th>Year</th></tr></thead>
          <tbody>
            ${raw(
              entries
                .map(
                  (e) => html`<tr class="click" data-href="/tracks/${e.track_id}">
                    <td class="mono">${(e.position as number) + 1}</td>
                    <td class="strong">${e.artist}</td>
                    <td>${e.title}</td>
                    <td class="mono">${e.year ?? '—'}</td>
                  </tr>`,
                )
                .join(''),
            )}
          </tbody>
        </table></div>
      </section>
    `;
    return reply.type('text/html').send(layout(`Run #${run.id}`, body, nav));
  });
}
