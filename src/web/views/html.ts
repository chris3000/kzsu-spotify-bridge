const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Tagged template that escapes interpolations unless wrapped in raw(). */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Raw) out += v.value;
      else if (Array.isArray(v))
        out += v.map((x) => (x instanceof Raw ? x.value : esc(x))).join('');
      else out += esc(v);
    }
  });
  return out;
}

class Raw {
  constructor(readonly value: string) {}
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export interface NavCtx {
  active: 'overview' | 'tracks' | 'plays' | 'runs';
  counts: { tracks: number; plays: number; runs: number };
  spotifyReady: boolean;
  nextRunLabel: string;
}

/** Design system: "Console" direction from the KZSU-Bridge Claude Design project. */
const CSS = `
:root {
  --bg: #0b0c0e; --surface: #0e1013; --surface2: #101317;
  --hover: #12151a; --btn: #14171b; --btn-hover: #191c21; --active: #191c21;
  --border: #1e2126; --border2: #24272c; --row-border: #1a1d22;
  --text: #e8eaed; --text2: #c7ccd3; --text3: #9aa2ad; --muted: #6b7280;
  --accent: oklch(0.82 0.11 185); --accent-hover: oklch(0.88 0.11 185);
  --accent-ink: #04100f; --accent-dim: oklch(0.55 0.08 185);
  --badge-ok-bg: oklch(0.32 0.05 185); --badge-ok-fg: oklch(0.88 0.11 185);
  --badge-warn-bg: oklch(0.34 0.07 40); --badge-warn-fg: oklch(0.88 0.12 60);
  --chip-on-border: oklch(0.45 0.07 185);
  --warn: oklch(0.72 0.14 40); --bar: oklch(0.72 0.1 300);
  --sans: 'Space Grotesk', Helvetica, sans-serif;
  --mono: 'IBM Plex Mono', monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; }
a { color: var(--text); text-decoration: none; }
a:hover { color: var(--accent); }
input::placeholder { color: var(--muted); }

.shell { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 210px) minmax(0, 1fr); }
@media (max-width: 720px) { .shell { grid-template-columns: minmax(0, 1fr); } .side { display: none; } }
.side { background: var(--surface); border-right: 1px solid var(--border); padding: 22px 16px; display: flex; flex-direction: column; gap: 28px; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand .mark { width: 26px; height: 26px; border-radius: 4px; background: var(--accent); flex: none; }
.brand .name { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
.brand .sub { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.nav { display: flex; flex-direction: column; gap: 2px; font-size: 14px; }
.nav a { padding: 8px 10px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; color: var(--text3); }
.nav a:hover { background: var(--btn); color: var(--text); }
.nav a.on { background: var(--active); color: #fff; }
.nav .count { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.status-panel { margin-top: auto; border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-family: var(--mono); font-size: 10px; line-height: 1.8; color: var(--muted); }
.status-panel .online { display: flex; align-items: center; gap: 7px; color: var(--accent); }
.status-panel .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); display: inline-block; }
.status-panel a { color: var(--warn); }

main { padding: 26px 30px 56px; min-width: 0; }
.page-head { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; justify-content: space-between; margin-bottom: 26px; }
.page-head h1 { font-size: 24px; font-weight: 600; margin: 0; letter-spacing: -0.02em; }
.page-head .meta { margin: 5px 0 0; font-size: 13px; color: var(--text3); font-family: var(--mono); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions form { display: inline; }

.btn { font-family: var(--sans); font-size: 13px; background: var(--btn); color: var(--text); border: 1px solid var(--border2); padding: 9px 14px; border-radius: 7px; cursor: pointer; display: inline-block; }
.btn:hover { background: var(--btn-hover); color: var(--text); }
.btn-primary { font-weight: 500; background: var(--accent); color: var(--accent-ink); border: 0; padding: 9px 16px; }
.btn-primary:hover { background: var(--accent-hover); color: var(--accent-ink); }
.btn-sm { font-family: var(--mono); font-size: 11px; padding: 6px 11px; border-radius: 6px; color: var(--text2); }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.tile .label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.tile .num { font-size: 30px; font-weight: 500; letter-spacing: -0.03em; margin-top: 8px; }
.tile .delta { font-size: 12px; font-family: var(--mono); margin-top: 2px; color: var(--muted); }
.tile .delta.up { color: var(--accent); }
.tile .delta.warn { color: var(--warn); }

.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
.card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 18px; }
.card h2 { font-size: 13px; font-weight: 500; margin: 0; }
.card .tag { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.card a.more { font-family: var(--mono); font-size: 11px; color: var(--accent); }

.bars { display: flex; align-items: flex-end; gap: 5px; height: 132px; }
.bars .bar { flex: 1; background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dim) 100%); border-radius: 3px 3px 0 0; min-height: 4px; }

.causes { display: flex; flex-direction: column; gap: 13px; }
.cause { display: grid; grid-template-columns: minmax(0, 150px) minmax(0, 1fr) auto; gap: 12px; align-items: center; font-size: 13px; }
.cause .name { color: var(--text2); }
.cause .track { height: 6px; border-radius: 3px; background: var(--border); display: block; }
.cause .fill { display: block; height: 6px; border-radius: 3px; background: var(--bar); }
.cause .fill.accent { background: var(--accent); }
.cause .n { font-family: var(--mono); font-size: 12px; color: var(--text3); }

.tcard { margin-top: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.tcard .card-bar { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid var(--border); }
.tcard h2 { font-size: 13px; font-weight: 500; margin: 0; }
.tcard .overflow { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 400; padding: 11px 18px; background: var(--surface2); white-space: nowrap; text-align: left; color: var(--muted); }
th a { color: var(--muted); display: block; }
th a:hover, th a.on { color: var(--text); }
td { padding: 12px 18px; color: var(--text2); }
tbody tr { border-top: 1px solid var(--row-border); }
tbody tr.click { cursor: pointer; }
tbody tr.click:hover { background: var(--hover); }
td.strong { color: #fff; }
td.dim { color: var(--text3); }
td.mono { font-family: var(--mono); font-size: 12px; color: var(--text3); white-space: nowrap; }

.badge { font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 8px; border-radius: 5px; white-space: nowrap; }
.badge.matched, .badge.success { background: var(--badge-ok-bg); color: var(--badge-ok-fg); }
.badge.unmatched, .badge.failed { background: var(--badge-warn-bg); color: var(--badge-warn-fg); }
.badge.gave_up, .badge.running, .badge.neutral { background: var(--border); color: var(--text3); }

.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.toolbar form.search { flex: 1; min-width: 200px; display: flex; }
.toolbar input[type=text], .toolbar input[type=search] { flex: 1; font-family: var(--sans); font-size: 13px; background: var(--surface); border: 1px solid var(--border2); color: var(--text); padding: 9px 12px; border-radius: 7px; outline: none; }
.toolbar input:focus { border-color: var(--accent); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; padding: 8px 11px; border-radius: 7px; cursor: pointer; background: var(--surface); color: var(--text3); border: 1px solid var(--border2); display: inline-block; }
.chip:hover { color: var(--text); }
.chip.on { background: var(--badge-ok-bg); color: var(--badge-ok-fg); border-color: var(--chip-on-border); }

.foot { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 11px; color: var(--muted); }
.foot .pager { display: flex; gap: 6px; }

.detail { max-width: 560px; }
.detail .eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.detail h2 { font-size: 20px; font-weight: 600; margin: 8px 0 2px; letter-spacing: -0.02em; }
.detail .artist { font-size: 14px; color: var(--text3); }
.fields { display: flex; flex-direction: column; gap: 1px; margin-top: 24px; background: var(--row-border); border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.field { display: grid; grid-template-columns: minmax(0, 120px) minmax(0, 1fr); gap: 12px; background: var(--surface); padding: 12px 14px; font-size: 13px; }
.field .k { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.field .v { color: var(--text); word-break: break-word; }

.login-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.login-card { width: min(360px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 28px; }
.login-card input { width: 100%; font-family: var(--sans); font-size: 13px; background: var(--bg); border: 1px solid var(--border2); color: var(--text); padding: 10px 12px; border-radius: 7px; outline: none; margin: 16px 0; }
.login-card input:focus { border-color: var(--accent); }
.banner-warn { background: var(--badge-warn-bg); color: var(--badge-warn-fg); border-radius: 7px; padding: 8px 12px; font-size: 12px; font-family: var(--mono); margin-top: 14px; }
`;

const FONTS = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const ROW_CLICK_JS = `<script>
document.addEventListener('click', function (e) {
  var tr = e.target.closest('tr[data-href]');
  if (tr && !e.target.closest('a, button, form')) window.location = tr.dataset.href;
});
</script>`;

function shell(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Bridge</title>
${FONTS}
<style>${CSS}</style>
</head>
<body>
${inner}
${ROW_CLICK_JS}
</body>
</html>`;
}

export function layout(title: string, body: string, nav: NavCtx): string {
  const items: { key: NavCtx['active']; href: string; label: string; count: string }[] = [
    { key: 'overview', href: '/', label: 'Overview', count: '' },
    { key: 'tracks', href: '/tracks', label: 'Tracks', count: fmtCount(nav.counts.tracks) },
    { key: 'plays', href: '/plays', label: 'Plays', count: fmtCount(nav.counts.plays) },
    { key: 'runs', href: '/runs', label: 'Sync runs', count: fmtCount(nav.counts.runs) },
  ];
  const inner = html`
    <div class="shell">
      <aside class="side">
        <div class="brand">
          <div class="mark"></div>
          <div>
            <div class="name">Bridge</div>
            <div class="sub">kzsu → spotify</div>
          </div>
        </div>
        <nav class="nav">
          ${raw(
            items
              .map(
                (i) =>
                  html`<a href="${i.href}" class="${i.key === nav.active ? 'on' : ''}">
                    <span>${i.label}</span><span class="count">${i.count}</span>
                  </a>`,
              )
              .join(''),
          )}
          <a href="/logout"><span>Log out</span></a>
        </nav>
        <div class="status-panel">
          <div class="online"><span class="dot"></span> ONLINE</div>
          <div>next run ${nav.nextRunLabel}</div>
          ${nav.spotifyReady
            ? raw('<div>spotify · linked</div>')
            : raw('<div><a href="/auth/spotify">spotify · connect →</a></div>')}
        </div>
      </aside>
      <main>${raw(body)}</main>
    </div>`;
  return shell(title, inner);
}

/** Bare centered shell (login page). */
export function bareLayout(title: string, body: string): string {
  return shell(title, `<div class="login-shell">${body}</div>`);
}

function fmtCount(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n > 0 ? String(n) : '';
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtEpoch(epoch: number | null | undefined, timeZone: string): string {
  if (epoch == null) return '—';
  return new Date(epoch * 1000).toLocaleString('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function fmtAgo(epoch: number | null): string {
  if (epoch == null) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Shared list-page pagination footer; handles the empty state. */
export function pagerFoot(opts: {
  from: number;
  to: number;
  total: number;
  prevHref?: string | null;
  nextHref?: string | null;
}): Raw {
  const label =
    opts.total === 0 ? 'no results' : `${opts.from}–${opts.to} of ${fmtNum(opts.total)}`;
  const prev = opts.prevHref
    ? `<a class="btn btn-sm" href="${esc(opts.prevHref)}">prev</a>`
    : '';
  const next = opts.nextHref
    ? `<a class="btn btn-sm" href="${esc(opts.nextHref)}">next</a>`
    : '';
  return raw(
    `<div class="foot"><span>${esc(label)}</span><span class="pager">${prev}${next}</span></div>`,
  );
}

export function badge(status: string): Raw {
  const cls = ['matched', 'unmatched', 'gave_up', 'success', 'failed', 'running'].includes(status)
    ? status
    : 'neutral';
  const label = status === 'gave_up' ? 'gave up' : status;
  return raw(`<span class="badge ${cls}">${esc(label)}</span>`);
}
