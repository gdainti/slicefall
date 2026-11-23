// The /stats page: every statistic the database holds on one server-rendered page, for the
// site's owner. Not linked from the game, and behind a password (app.ts). Charts are plain SVG with
// <title> tooltips, so the page needs no script (the Content-Security-Policy allows no inline ones).

import type { ScoreDb } from './db.ts';
import { weekStart } from './scores.ts';

const DAYS = 60;
const PLAYERS_MAX = 1000;
const GAMES_MAX = 300;
const MATCHES_MAX = 150;
const BOARD_MAX = 50;

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const time = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '–');
const playTime = (ms: number) => {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
};
const secs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const short = (id: unknown, n = 8) => (typeof id === 'string' ? id.slice(0, n) : '–');

/** A round step for an axis or histogram near `raw`: 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  if (raw <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

interface Bar {
  label: string;
  value: number;
  /** Hover text */
  tip: string;
}

/** A single-series bar chart: thin bars on a baseline, a few recessive gridlines, hover titles. */
function barChart(title: string, bars: Bar[], every = 1): string {
  const W = 640;
  const H = 180;
  const left = 44;
  const right = 8;
  const top = 10;
  const bottom = 24;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const step = niceStep(max / 4);
  const top_ = Math.ceil(max / step) * step;
  const y = (v: number) => top + plotH - (v / top_) * plotH;

  const grid: string[] = [];
  for (let v = 0; v <= top_; v += step) {
    grid.push(
      `<line class="grid${v === 0 ? ' base' : ''}" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>` +
        `<text class="tick" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`,
    );
  }
  const slot = plotW / Math.max(1, bars.length);
  const gap = Math.min(2, slot * 0.2);
  const bw = Math.max(1, slot - gap);
  const marks = bars.map((b, i) => {
    const x = left + i * slot + gap / 2;
    const h = (b.value / top_) * plotH;
    const r = Math.min(4, bw / 2, h);
    const yb = top + plotH;
    // Rounded at the data end only; the bar stays square on the baseline.
    const path =
      h > 0
        ? `<path class="bar" d="M${x},${yb} V${yb - h + r} Q${x},${yb - h} ${x + r},${yb - h} H${x + bw - r} Q${x + bw},${yb - h} ${x + bw},${yb - h + r} V${yb} Z"/>`
        : '';
    const label = i % every === 0 ? `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>` : '';
    // The hit area is the whole column, not just the bar.
    return `<g class="col"><title>${esc(b.tip)}</title><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/>${path}</g>${label}`;
  });
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid.join('')}${marks.join('')}</svg></figure>`;
}

function table(head: string[], rows: unknown[][], numeric: boolean[] = []): string {
  if (!rows.length) return '<p class="empty">Nothing yet.</p>';
  const th = head.map((h, i) => `<th${numeric[i] ? ' class="n"' : ''}>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric[i] ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const tile = (label: string, value: string, sub = '') =>
  `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;

export function statsPage(db: ScoreDb, now: Date): string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const week = weekStart(now);
  const periods: [string, Date | null][] = [
    ['Today', today],
    ['This week', week],
    ['All time', null],
  ];
  const all = db.gameTotals(null);
  const allBoard = db.boardStats('cut', null);
  const allMatch = db.matchTotals(null);

  // Every day of the window, with zeros for days nobody played.
  const since = new Date(today.getTime() - (DAYS - 1) * 86_400_000);
  const byDay = new Map(db.activityByDay(since).map((d) => [d.day, d]));
  const days = Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(day) ?? { day, started: 0, devices: 0, finished: 0, named: 0, best: 0, minutes: 0 };
  });
  const dayBars = (value: (d: (typeof days)[number]) => number, unit: string) =>
    days.map((d) => ({ label: d.day.slice(5), value: value(d), tip: `${d.day}: ${num(value(d))} ${unit}` }));

  const hours = new Map(db.startsByHour().map((h) => [h.hour, h.started]));
  const hourBars = Array.from({ length: 24 }, (_, h) => ({
    label: String(h),
    value: hours.get(h) ?? 0,
    tip: `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 UTC: ${num(hours.get(h) ?? 0)} games started`,
  }));

  const scores = db.allScores();
  const width = niceStep(Math.max(1, ...scores) / 20);
  const buckets = new Map<number, number>();
  for (const s of scores) buckets.set(Math.floor(s / width), (buckets.get(Math.floor(s / width)) ?? 0) + 1);
  const lastBucket = Math.max(0, ...buckets.keys());
  const scoreBars = Array.from({ length: lastBucket + 1 }, (_, b) => ({
    label: num(b * width),
    value: buckets.get(b) ?? 0,
    tip: `${num(b * width)}–${num((b + 1) * width - 1)} points: ${num(buckets.get(b) ?? 0)} games`,
  }));

  const totals = table(
    ['', 'Started', 'Finished', 'Abandoned', 'Scored', 'Players', 'Devices', 'Lines', 'Pieces', 'Played', 'Avg score', 'Best'],
    periods.map(([label, from]) => {
      const t = db.gameTotals(from);
      const { started, names } = db.boardStats('cut', from);
      return [label, num(started), num(t.games), num(Math.max(0, started - t.games)), num(t.named), num(names), num(t.devices), num(t.lines), num(t.pieces), playTime(t.playMs), num(t.avgScore), num(t.best)];
    }),
    [false, true, true, true, true, true, true, true, true, true, true, true],
  );
  const online = table(
    ['', 'Rounds', 'Finished', 'Left early', 'Rooms', 'Rematches', 'Devices', 'Played'],
    periods.map(([label, from]) => {
      const m = db.matchTotals(from);
      return [label, num(m.rounds), num(m.finished), num(m.left), num(m.rooms), num(m.rematches), num(m.devices), playTime(m.playMs)];
    }),
    [false, true, true, true, true, true, true, true],
  );

  const perDay = table(
    ['Day (UTC)', 'Started', 'Finished', 'Scored', 'Devices', 'Minutes', 'Best'],
    [...days].reverse().filter((d) => d.started || d.finished).map((d) => [d.day, num(d.started), num(d.finished), num(d.named), num(d.devices), num(d.minutes), num(d.best)]),
    [false, true, true, true, true, true, true],
  );

  const boardTable = (from: Date | null) =>
    table(
      ['#', 'Name', 'Score', 'Lines', 'Level', 'Pieces', 'Set (UTC)'],
      db.board('cut', from, BOARD_MAX).map((e) => [e.rank, e.name, num(e.score), e.lines, e.level, e.pieces, time(Date.parse(e.at))]),
      [true, false, true, true, true, true, false],
    );

  const names = db.names();
  const namesTable = table(
    ['Name', 'Best', 'Scores', 'Devices', 'First (UTC)', 'Last (UTC)'],
    names.map((n) => [n.name, num(n.best), num(n.scores), num(n.devices), time(n.first_at), time(n.last_at)]),
    [false, true, true, true, false, false],
  );

  const players = db.players(PLAYERS_MAX);
  const playersTable = table(
    ['Player id', 'Names', 'Started', 'Finished', 'Scored', 'Online', 'Best', 'Played', 'First seen (UTC)', 'Last seen (UTC)'],
    players.map((p) => [short(p.player), p.names ?? '–', num(p.started), num(p.finished), num(p.scored), num(p.online), num(p.best), playTime(p.play_ms), time(p.first_at), time(p.last_at)]),
    [false, false, true, true, true, true, true, true, false, false],
  );

  const games = db.recentGames(GAMES_MAX) as Record<string, number | string | null>[];
  const gamesTable = table(
    ['#', 'Ended (UTC)', 'Player', 'Name', 'Score', 'Lines', 'Level', 'Pieces', 'Cuts', 'Best cut', 'T-spins', 'Time'],
    games.map((g) => [g.id, time(g.created_at as number), short(g.player), g.name ?? '–', num(g.score as number), g.lines, g.level, g.pieces, g.cuts, g.best_cut, g.t_spins, secs(g.duration_ms as number)]),
    [true, false, false, false, true, true, true, true, true, true, true, true],
  );

  const matches = db.recentMatches(MATCHES_MAX) as Record<string, number | string | null>[];
  const matchesTable = table(
    ['#', 'Ended (UTC)', 'Room', 'Round', 'Host', 'Guest', 'Host score', 'Guest score', 'Winner', 'Ended by', 'Time'],
    matches.map((m) => [m.id, time(m.created_at as number), short(m.room, 6), m.round, short(m.host), short(m.guest), m.host_score ?? '–', m.guest_score ?? '–', m.winner ?? '–', m.ended, secs(m.duration_ms as number)]),
    [true, false, false, true, false, false, true, true, false, false, true],
  );

  const section = (id: string, title: string, body: string, note = '') =>
    `<section id="${id}"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}</section>`;
  const nav = [
    ['totals', 'Totals'],
    ['charts', 'Charts'],
    ['days', 'Per day'],
    ['boards', 'Leaderboards'],
    ['names', 'Names'],
    ['players', 'Players'],
    ['games', 'Games'],
    ['online', 'Online'],
  ]
    .map(([id, t]) => `<a href="#${id}">${t}</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Slicefall stats</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Slicefall stats</h1>
  <p class="note">Generated ${esc(time(now.getTime()))} UTC · weeks start Monday 00:00 UTC · reload for fresh numbers</p>
  <nav>${nav}</nav>
</header>
<main>
<div class="tiles">
  ${tile('Games started', num(allBoard.started), `${num(all.games)} finished`)}
  ${tile('Players', num(allBoard.names), 'names on the board')}
  ${tile('Devices', num(db.deviceCount()), 'browser ids seen')}
  ${tile('Time played', playTime(all.playMs), `${num(all.lines)} lines`)}
  ${tile('Best score', num(all.best), `avg ${num(all.avgScore)}`)}
  ${tile('Online rounds', num(allMatch.rounds), `${num(allMatch.rooms)} rooms`)}
</div>
${section('totals', 'Totals', `${totals}<h3>Online Versus</h3>${online}`, 'Abandoned = started but never logged (quit, closed the tab, or still playing).')}
${section(
  'charts',
  'Charts',
  `<div class="charts">
    ${barChart(`Games started per day, last ${DAYS} days`, dayBars((d) => d.started, 'games started'), 7)}
    ${barChart(`Devices playing per day, last ${DAYS} days`, dayBars((d) => d.devices, 'devices'), 7)}
    ${barChart(`Minutes played per day, last ${DAYS} days`, dayBars((d) => d.minutes, 'minutes'), 7)}
    ${barChart('Games started by hour of day (UTC), all time', hourBars, 3)}
    ${barChart('Score distribution, all finished games', scoreBars, Math.max(1, Math.ceil(scoreBars.length / 8)))}
  </div>`,
  'Hover a bar for its value.',
)}
${section('days', `Per day, last ${DAYS} days`, perDay)}
${section('boards', 'Leaderboards', `<div class="two"><div><h3>This week</h3>${boardTable(week)}</div><div><h3>All time</h3>${boardTable(null)}</div></div>`, `Best score per name, top ${BOARD_MAX}.`)}
${section('names', `Names (${num(names.length)})`, namesTable, 'Every name that has submitted a score. Devices = different browser ids it came from.')}
${section('players', `Players by device (${num(players.length)})`, playersTable, `Each browser keeps a random id; most recently active first${players.length >= PLAYERS_MAX ? `, first ${PLAYERS_MAX}` : ''}.`)}
${section('games', `Latest ${GAMES_MAX} games`, gamesTable)}
${section('online', `Latest ${MATCHES_MAX} online rounds`, matchesTable)}
</main>
</body>
</html>`;
}

const CSS = `
:root {
  color-scheme: light;
  --surface: #fcfcfb; --surface-2: #f3f2ef; --line: #e3e2dd;
  --text: #0b0b0b; --text-2: #52514e; --muted: #7a7974;
  --series: #2a78d6; --series-hover: #1c5cab;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #1a1a19; --surface-2: #232322; --line: #353533;
    --text: #f0efec; --text-2: #c3c2b7; --muted: #8f8e86;
    --series: #3987e5; --series-hover: #6da7ec;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 20px 24px 8px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface); z-index: 1; }
h1 { margin: 0; font-size: 22px; }
h2 { margin: 32px 0 6px; font-size: 18px; }
h3 { margin: 16px 0 6px; font-size: 14px; color: var(--text-2); }
nav { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; }
nav a { color: var(--text-2); text-decoration: none; font-weight: 600; }
nav a:hover { color: var(--text); text-decoration: underline; }
main { padding: 8px 24px 48px; max-width: 1400px; }
.note { margin: 2px 0 8px; color: var(--muted); font-size: 12.5px; }
.empty { color: var(--muted); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-top: 16px; }
.tile { background: var(--surface-2); border-radius: 10px; padding: 12px 14px; }
.tile .label { color: var(--text-2); font-size: 12px; font-weight: 600; }
.tile .value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tile .sub { color: var(--muted); font-size: 12px; }
.charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap: 20px; }
.chart { margin: 0; }
.chart figcaption { font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
.chart svg { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .grid.base { stroke: var(--muted); }
.chart .tick { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.chart .bar { fill: var(--series); }
.chart .hit { fill: transparent; }
.chart .col:hover .hit { fill: var(--surface-2); }
.chart .col:hover .bar { fill: var(--series-hover); }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 24px; }
.scroll { overflow: auto; max-height: 560px; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { padding: 5px 10px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { position: sticky; top: 0; background: var(--surface-2); color: var(--text-2); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--surface-2); }
`;
