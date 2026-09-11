import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { kvGet, type DB } from '../../db/client.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { esc, fmtEpoch, html, layout, raw } from '../views/html.js';

const PAGE_SIZE = 50;

interface TrackFilters {
  artist?: string;
  year?: string;
  status?: string;
  added_after?: string;
  added_before?: string;
  min_selected?: string;
  sort?: string;
  page?: string;
}

export function registerDashboard(
  app: FastifyInstance,
  db: DB,
  registry: ProviderRegistry,
  config: Config,
): void {
  const tz = config.TZ_STATION;

  app.get('/', async (_req, reply) => {
    const count = (sql: string, ...args: unknown[]): number =>
      (db.prepare(sql).get(...args) as { c: number }).c;

    const total = count('SELECT COUNT(*) c FROM tracks');
    const matched = count(`SELECT COUNT(*) c FROM tracks WHERE status = 'matched'`);
    const unmatched = count(`SELECT COUNT(*) c FROM tracks WHERE status = 'unmatched'`);
    const gaveUp = count(`SELECT COUNT(*) c FROM tracks WHERE status = 'gave_up'`);
    const plays = count('SELECT COUNT(*) c FROM plays');
    const now = Math.floor(Date.now() / 1000);
    const plays24h = count('SELECT COUNT(*) c FROM plays WHERE played_at >= ?', now - 86400);
    const lastIngest = Number(kvGet(db, 'last_ingest_at')) || null;

    const lastRuns = db
      .prepare(
        `SELECT kind, run_date, status, track_count, notes, error, started_at
         FROM playlist_runs pr
         WHERE started_at = (SELECT MAX(started_at) FROM playlist_runs WHERE kind = pr.kind)
         ORDER BY kind`,
      )
      .all() as {
      kind: string;
      run_date: string;
      status: string;
      track_count: number | null;
      notes: string | null;
      error: string | null;
      started_at: number;
    }[];

    const spotifyReady = await registry.providers[0]!.isReady();

    const body = html`
      <h1>Dashboard</h1>
      ${spotifyReady
        ? raw('<div class="banner ok">Spotify: authorized ✓</div>')
        : raw(
            '<div class="banner warn">Spotify is not authorized — playlists cannot be updated. <a href="/auth/spotify">Connect Spotify</a></div>',
          )}
      <div class="tiles">
        <div class="tile"><div class="num">${total}</div><div class="label">tracks in database</div></div>
        <div class="tile"><div class="num">${matched}</div><div class="label">matched</div></div>
        <div class="tile"><div class="num">${unmatched}</div><div class="label">unmatched</div></div>
        <div class="tile"><div class="num">${gaveUp}</div><div class="label">gave up</div></div>
        <div class="tile"><div class="num">${plays}</div><div class="label">plays recorded</div></div>
        <div class="tile"><div class="num">${plays24h}</div><div class="label">plays last 24h</div></div>
      </div>
      <p class="muted">Last ingest: ${fmtEpoch(lastIngest, tz)}</p>
      <h2>Latest playlist runs</h2>
      <div class="overflow"><table>
        <tr><th>Playlist</th><th>Run date</th><th>Status</th><th>Tracks</th><th>Notes</th><th>At</th></tr>
        ${raw(
          lastRuns
            .map(
              (r) => html`<tr>
                <td>${r.kind}</td><td>${r.run_date}</td><td>${r.status}</td>
                <td>${r.track_count ?? '—'}</td>
                <td class="wrap">${r.notes ?? r.error ?? ''}</td>
                <td>${fmtEpoch(r.started_at, tz)}</td>
              </tr>`,
            )
            .join(''),
        )}
      </table></div>
      <h2>Actions</h2>
      <form method="post" action="/admin/rebuild?kind=dynamic" style="display:inline">
        <button>Rebuild dynamic playlist now</button>
      </form>
      <form method="post" action="/admin/rebuild?kind=yesterday" style="display:inline">
        <button>Rebuild yesterday playlist now</button>
      </form>
      <form method="post" action="/admin/retry-unmatched" style="display:inline">
        <button>Retry all unmatched now</button>
      </form>
    `;
    return reply.type('text/html').send(layout('Dashboard', body));
  });

  app.get<{ Querystring: TrackFilters }>('/tracks', async (req, reply) => {
    const q = req.query;
    const where: string[] = [];
    const args: unknown[] = [];
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
      args.push(Math.floor(new Date(q.added_before).getTime() / 1000) + 86400);
    }
    if (q.min_selected && /^\d+$/.test(q.min_selected)) {
      where.push('t.times_selected >= ?');
      args.push(Number(q.min_selected));
    }
    const sorts: Record<string, string> = {
      added: 't.date_added DESC',
      artist: 't.artist ASC, t.title ASC',
      selected: 't.times_selected DESC',
      last_selected: 't.last_selected_at DESC NULLS LAST',
    };
    const orderBy = sorts[q.sort ?? ''] ?? sorts.added!;
    const page = Math.max(1, Number(q.page) || 1);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (
      db.prepare(`SELECT COUNT(*) c FROM tracks t ${whereSql}`).get(...args) as {
        c: number;
      }
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
      return `/tracks?${params}`;
    };

    const body = html`
      <h1>Tracks <span class="muted">(${total})</span></h1>
      <form class="filters" method="get" action="/tracks">
        <label>Artist <input name="artist" value="${q.artist ?? ''}" /></label>
        <label>Year <input name="year" value="${q.year ?? ''}" size="6" /></label>
        <label>Status
          <select name="status">
            <option value="">any</option>
            ${raw(
              ['matched', 'unmatched', 'gave_up']
                .map(
                  (s) =>
                    `<option value="${s}" ${q.status === s ? 'selected' : ''}>${s}</option>`,
                )
                .join(''),
            )}
          </select>
        </label>
        <label>Added after <input type="date" name="added_after" value="${q.added_after ?? ''}" /></label>
        <label>Added before <input type="date" name="added_before" value="${q.added_before ?? ''}" /></label>
        <label>Min picks <input name="min_selected" value="${q.min_selected ?? ''}" size="4" /></label>
        <label>Sort
          <select name="sort">
            ${raw(
              Object.keys(sorts)
                .map(
                  (s) =>
                    `<option value="${s}" ${q.sort === s ? 'selected' : ''}>${s}</option>`,
                )
                .join(''),
            )}
          </select>
        </label>
        <button>Filter</button>
      </form>
      <div class="overflow"><table>
        <tr><th>Title</th><th>Artist</th><th>Year</th><th>Status</th><th>Added</th><th>Picks</th><th>Last picked</th><th></th></tr>
        ${raw(
          rows
            .map(
              (t) => html`<tr>
                <td class="wrap">${t.title}</td>
                <td class="wrap">${t.artist}</td>
                <td>${t.year ?? ''}</td>
                <td class="status-${t.status}">${t.status}</td>
                <td>${fmtEpoch(t.date_added as number, tz)}</td>
                <td>${t.times_selected}</td>
                <td>${fmtEpoch(t.last_selected_at as number | null, tz)}</td>
                <td>
                  ${t.spotify_id
                    ? raw(
                        `<a href="https://open.spotify.com/track/${esc(t.spotify_id)}">spotify</a>`,
                      )
                    : raw(
                        `<form method="post" action="/admin/retry-unmatched/${esc(t.id)}"><button>retry match</button></form>`,
                      )}
                </td>
              </tr>`,
            )
            .join(''),
        )}
      </table></div>
      <div class="pager">
        ${page > 1 ? raw(`<a href="${esc(qs({ page: String(page - 1) }))}">← prev</a>`) : ''}
        <span class="muted">page ${page} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
        ${page * PAGE_SIZE < total
          ? raw(`<a href="${esc(qs({ page: String(page + 1) }))}">next →</a>`)
          : ''}
      </div>
    `;
    return reply.type('text/html').send(layout('Tracks', body));
  });

  app.get<{ Querystring: { page?: string } }>('/plays', async (req, reply) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const rows = db
      .prepare(
        `SELECT p.played_at, p.raw_artist, p.raw_title, t.status
         FROM plays p JOIN tracks t ON t.id = p.track_id
         ORDER BY p.played_at DESC LIMIT ? OFFSET ?`,
      )
      .all(PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[];
    const body = html`
      <h1>Recent plays</h1>
      <div class="overflow"><table>
        <tr><th>Aired</th><th>Artist</th><th>Title (raw)</th><th>Match status</th></tr>
        ${raw(
          rows
            .map(
              (p) => html`<tr>
                <td>${fmtEpoch(p.played_at as number, tz)}</td>
                <td class="wrap">${p.raw_artist}</td>
                <td class="wrap">${p.raw_title}</td>
                <td class="status-${p.status}">${p.status}</td>
              </tr>`,
            )
            .join(''),
        )}
      </table></div>
      <div class="pager">
        ${page > 1 ? raw(`<a href="/plays?page=${page - 1}">← prev</a>`) : ''}
        ${rows.length === PAGE_SIZE ? raw(`<a href="/plays?page=${page + 1}">next →</a>`) : ''}
      </div>
    `;
    return reply.type('text/html').send(layout('Plays', body));
  });

  app.get('/runs', async (_req, reply) => {
    const rows = db
      .prepare('SELECT * FROM playlist_runs ORDER BY started_at DESC LIMIT 100')
      .all() as Record<string, unknown>[];
    const body = html`
      <h1>Playlist runs</h1>
      <div class="overflow"><table>
        <tr><th>Id</th><th>Playlist</th><th>Run date</th><th>Status</th><th>Trigger</th><th>Tracks</th><th>Notes / error</th><th>Started</th></tr>
        ${raw(
          rows
            .map(
              (r) => html`<tr>
                <td><a href="/runs/${r.id}">#${r.id}</a></td>
                <td>${r.kind}</td>
                <td>${r.run_date}</td>
                <td>${r.status}</td>
                <td>${r.trigger}</td>
                <td>${r.track_count ?? '—'}</td>
                <td class="wrap">${r.notes ?? r.error ?? ''}</td>
                <td>${fmtEpoch(r.started_at as number, tz)}</td>
              </tr>`,
            )
            .join(''),
        )}
      </table></div>
    `;
    return reply.type('text/html').send(layout('Playlist runs', body));
  });

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = db
      .prepare('SELECT * FROM playlist_runs WHERE id = ?')
      .get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!run) return reply.code(404).send('run not found');
    const entries = db
      .prepare(
        `SELECT pe.position, t.title, t.artist, t.year
         FROM playlist_entries pe JOIN tracks t ON t.id = pe.track_id
         WHERE pe.run_id = ? ORDER BY pe.position`,
      )
      .all(run.id) as Record<string, unknown>[];
    const body = html`
      <h1>Run #${run.id} — ${run.kind} (${run.run_date})</h1>
      <p>
        Status: ${run.status} · trigger: ${run.trigger} ·
        ${run.track_count ?? 0} tracks
        ${run.notes ? html` · ${run.notes}` : ''}
        ${run.error ? html` · error: ${run.error}` : ''}
      </p>
      <div class="overflow"><table>
        <tr><th>#</th><th>Title</th><th>Artist</th><th>Year</th></tr>
        ${raw(
          entries
            .map(
              (e) => html`<tr>
                <td>${(e.position as number) + 1}</td>
                <td class="wrap">${e.title}</td>
                <td class="wrap">${e.artist}</td>
                <td>${e.year ?? ''}</td>
              </tr>`,
            )
            .join(''),
        )}
      </table></div>
    `;
    return reply.type('text/html').send(layout(`Run #${run.id}`, body));
  });
}
