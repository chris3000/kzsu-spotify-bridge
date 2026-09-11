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

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · KZSU Bridge</title>
<style>
:root { color-scheme: light dark; --accent: #8c1515; --muted: #777; --border: #ccc3; }
* { box-sizing: border-box; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 0 1rem 3rem; max-width: 1100px; margin-inline: auto; }
nav { display: flex; gap: 1.2rem; align-items: baseline; padding: 0.8rem 0; border-bottom: 1px solid var(--border); margin-bottom: 1.2rem; flex-wrap: wrap; }
nav .brand { font-weight: 700; color: var(--accent); }
nav a { text-decoration: none; }
h1 { font-size: 1.3rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.wrap { white-space: normal; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.8rem; margin: 1rem 0; }
.tile { border: 1px solid var(--border); border-radius: 8px; padding: 0.7rem 0.9rem; }
.tile .num { font-size: 1.6rem; font-weight: 700; }
.tile .label { color: var(--muted); font-size: 0.85rem; }
.banner { padding: 0.6rem 0.9rem; border-radius: 8px; margin: 0.8rem 0; }
.banner.warn { background: #b3261e22; border: 1px solid #b3261e66; }
.banner.ok { background: #1e7d3222; border: 1px solid #1e7d3266; }
form.filters { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin: 0.8rem 0; }
form.filters label { display: flex; flex-direction: column; font-size: 0.8rem; color: var(--muted); }
input, select, button { font: inherit; padding: 0.25rem 0.5rem; }
button { cursor: pointer; }
.muted { color: var(--muted); }
.pager { display: flex; gap: 1rem; margin: 1rem 0; }
.overflow { overflow-x: auto; }
.status-matched { color: #1e7d32; }
.status-unmatched { color: #b3261e; }
.status-gave_up { color: var(--muted); }
</style>
</head>
<body>
<nav>
  <span class="brand">KZSU Bridge</span>
  <a href="/">Dashboard</a>
  <a href="/tracks">Tracks</a>
  <a href="/plays">Plays</a>
  <a href="/runs">Playlist runs</a>
  <a href="/logout">Log out</a>
</nav>
${body}
</body>
</html>`;
}

export function fmtEpoch(epoch: number | null | undefined, timeZone: string): string {
  if (epoch == null) return '—';
  return new Date(epoch * 1000).toLocaleString('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
