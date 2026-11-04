// Frames the snake that Platane/snk draws, so it reads like GitHub's own graph: the month names
// along the top, Mon / Wed / Fri down the side, and a strip of counts underneath.
// Runs in the Snake workflow after snk and before the pictures go to the "output" branch.
//
//   node .github/snake/frame.js <dist dir>      env: GITHUB_USER (default chanellebingham), GITHUB_TOKEN
//
// It refuses rather than guess. The months come from the same contributions page the snake is
// drawn from, and that page has to match the snake's grid cell for cell. If anything doesn't line
// up, nothing is written and the step fails: the workflow then publishes snk's plain snake (fresh,
// but without the frame) and goes red, so a broken frame never leaves old counts up for good.
//
// The page is read with patterns, not an HTML parser: Node has none built in, and a package in a
// profile workflow is a supply-chain risk for a picture. Each tag's attributes are read in any
// order, and every value read is checked against the snake's own grid and the dates, so a bad read
// refuses instead of drawing.
'use strict';
const fs = require('fs');
const path = require('path');

const USER = process.env.GITHUB_USER || 'chanellebingham';
const PITCH = 16;  // snk puts day (col, row) at x = 2 + 16 * col, y = 2 + 16 * row; row 0 is Sunday
const OFF = 2;
const MARK = 'data-framed="1"';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const THEMES = {
  light: { label: '#6B0F45', chipTop: '#FFF0F7', chipBottom: '#FFC9E3', edge: '#F2C14E', num: '#E0218A', text: '#6B0F45', gloss: 0.9 },
  dark: { label: '#F9C3DD', chipTop: '#4A1F3E', chipBottom: '#2A1726', edge: '#F2C14E', num: '#FF8FCF', text: '#FBE9F2', gloss: 0.22 },
};

// ---------- reading ----------
// One tag's attributes, whatever order they come in.
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
const hasClass = (a, name) => (a.class || '').split(/\s+/).includes(name);

function parsePage(html) {
  const cells = [];
  for (const [tag] of html.matchAll(/<td\b[^>]*>/g)) {
    const a = attrs(tag);
    const id = (a.id || '').match(/^contribution-day-component-(\d)-(\d+)$/);
    if (!id || !/^\d{4}-\d\d-\d\d$/.test(a['data-date'] || '') || !/^\d$/.test(a['data-level'] || '')) continue;
    cells.push({ date: a['data-date'], row: +id[1], col: +id[2], lvl: +a['data-level'] });
  }
  // Month cells are in the table head (the body's day names share their class). Every month cell
  // moves the column on by its colspan (1 if it has none), named or not.
  const head = (html.match(/<thead\b[\s\S]*?<\/thead>/) || [''])[0];
  const months = [];
  let at = 0;
  for (const [, tag, inner] of head.matchAll(/(<td\b[^>]*>)([\s\S]*?)<\/td>/g)) {
    const a = attrs(tag);
    if (!hasClass(a, 'ContributionCalendar-label')) continue;
    const name = (inner.match(/<span\b[^>]*\baria-hidden="true"[^>]*>([^<]*)</) || [])[1];
    if (name && name.trim()) months.push({ col: at, name: name.trim() });
    at += a.colspan ? +a.colspan : 1;
  }
  const t = html.match(/([\d,]+)\s+contributions?\s+in the last year/);
  return { cells, months, total: t ? +t[1].replace(/,/g, '') : null };
}

function parseSnake(svg) {
  const m = svg.match(/^<svg viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
  const cells = [...svg.matchAll(/<rect class="c( c[0-9a-z]+)?" x="(-?\d+)" y="(-?\d+)"/g)]
    .map(([, cls, x, y]) => ({ lit: Boolean(cls), col: (+x - OFF) / PITCH, row: (+y - OFF) / PITCH }));
  return { viewBox: m ? m.slice(1, 5).map(Number) : null, cells, framed: svg.includes(MARK) };
}

// Everything that has to be true before a label goes on. Returns the problems; empty means go.
function check(page, snake) {
  const p = [];
  if (!snake.viewBox) p.push('the snake picture does not open with the viewBox and size I expect');
  if (snake.framed) p.push('this snake picture is already framed');
  if (page.cells.length < 300) p.push(`only ${page.cells.length} days on the contributions page`);
  if (page.total == null) p.push('no "contributions in the last year" total on the page');
  if (!page.months.length) p.push('no month labels on the page');
  const key = (c) => `${c.col},${c.row}`;
  const missing = (a, b) => [...a].filter((k) => !b.has(k));
  const pageAll = new Set(page.cells.map(key));
  const snakeAll = new Set(snake.cells.map(key));
  const pageLit = new Set(page.cells.filter((c) => c.lvl > 0).map(key));
  const snakeLit = new Set(snake.cells.filter((c) => c.lit).map(key));
  // snk reads the grid a little before this script does, so a contribution made in between can
  // light one more day. A difference in the newest week is let through; anything older means the
  // two grids don't line up. Any shift by a day changes which days exist at all, and that fails.
  const dateOf = new Map(page.cells.map((c) => [key(c), c.date]));
  const newest = page.cells.reduce((a, c) => (c.date > a ? c.date : a), '');
  const weekAgo = new Date(Date.parse(newest) - 6 * 864e5).toISOString().slice(0, 10);
  const old = (list) => list.filter((k) => !(dateOf.get(k) >= weekAgo));
  const sets = [
    ['days on the page but not in the snake', missing(pageAll, snakeAll)],
    ['days in the snake but not on the page', missing(snakeAll, pageAll)],
    ['active days on the page but empty in the snake', old(missing(pageLit, snakeLit))],
    ['active days in the snake but empty on the page', old(missing(snakeLit, pageLit))],
  ];
  for (const [what, list] of sets) if (list.length) p.push(`${what}: ${list.slice(0, 5).join(' ')}`);
  // Each month label must sit on the FIRST week that starts in that month. (Only "a week in that
  // month" let a label shifted by one week through, since most months span four or five.)
  const firstOf = new Map();
  for (const c of page.cells) if (!firstOf.has(c.col) || c.row < firstOf.get(c.col).row) firstOf.set(c.col, c);
  const monthOf = (col) => (firstOf.has(col) ? MON[+firstOf.get(col).date.slice(5, 7) - 1] : 'nothing');
  for (const m of page.months) {
    const got = monthOf(m.col);
    if (got !== m.name) p.push(`month label ${m.name} sits on column ${m.col}, which starts in ${got}`);
    else if (m.col > 0 && monthOf(m.col - 1) === m.name) p.push(`month label ${m.name} sits on column ${m.col}, but ${m.name} starts a column earlier`);
  }
  return p;
}

// ---------- counts ----------
// The counts cover the same year as the graph above them, from its first day. Search reads that
// date in UTC and the page may use her own timezone, so the window's edge can differ by some hours.
// "-user:" leaves out pull requests on repos under her own account.
const queries = (since) => ({
  prs: `author:${USER} is:pr -user:${USER} created:>=${since}`,
  merged: `author:${USER} is:pr -user:${USER} merged:>=${since}`,
});

// How long GitHub asks us to wait, in seconds, if this answer is a rate limit; null if it isn't one.
// GitHub's secondary limit can come as a bare 403 whose body says so; its docs say wait a minute.
function rateLimitWait(r, body = '', now = Date.now()) {
  if (r.status !== 403 && r.status !== 429) return null;
  const after = Number(r.headers.get('retry-after'));
  if (after > 0) return after;
  if (r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    return reset ? Math.max(1, Math.ceil(reset - now / 1000)) : 60;
  }
  if (r.status === 429 || /rate limit/i.test(body)) return 60;
  return null;
}

// The time one run may spend WAITING on rate limits, shared by every search. Each request also
// has its own time limit (REQUEST_S). Neither bounds the run on its own; the workflow's 2-minute
// step timeout does, and the plain snake still goes up if the frame step runs out of it.
const newBudget = (seconds = 75) => ({ left: seconds });
const REQUEST_S = 20;
const realSleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));
const get = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_S * 1000) });

async function searchPage(q, perPage, page, token, { sleep = realSleep, budget = newBudget() } = {}) {
  // Oldest first, so a pull request opened between two page reads can't push one across a page.
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=asc&per_page=${perPage}&page=${page}`;
  const ask = (auth) => get(url, { Accept: 'application/vnd.github+json', 'User-Agent': `${USER}-profile-snake`, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) });
  // The workflow's own token is meant for this repo; if search refuses it outright, carry on without
  // one, for the retries too.
  let auth = token;
  let r = await ask(auth);
  if (auth && (r.status === 401 || r.status === 422)) { auth = null; r = await ask(auth); }
  // One retry of each kind, counted separately: a rate-limit wait doesn't use up the incomplete retry.
  let waited = false, reasked = false;
  for (;;) {
    if (r.ok) {
      const j = await r.json();
      if (!j.incomplete_results) return j;
      if (reasked) throw new Error(`search "${q}" came back incomplete twice`);
      reasked = true;
      r = await ask(auth);   // GitHub's search timed out on its side; once more usually clears it
      continue;
    }
    const body = await r.text().catch(() => '');
    const wait = rateLimitWait(r, body);
    if (wait != null && !waited && wait <= budget.left) { waited = true; budget.left -= wait; await sleep(wait); r = await ask(auth); continue; }
    const why = wait != null ? `a rate limit (it asked for ${wait} s; ${budget.left} s of waiting left)` : r.status === 403 ? 'refused, not a rate limit' : 'an error';
    throw new Error(`search "${q}" answered ${r.status}: ${why}`);
  }
}

async function count(q, token, opts) {
  return (await searchPage(q, 1, 1, token, opts)).total_count;
}

async function projects(q, token, opts) {
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const j = await searchPage(q, 100, page, token, opts);
    if (j.total_count > 1000) throw new Error(`search "${q}" has ${j.total_count} results; it only lists 1000, so the project count would be short`);
    for (const it of j.items) seen.add(it.repository_url);
    if (page * 100 >= j.total_count) return { total: j.total_count, repos: seen.size };
  }
  throw new Error(`search "${q}" didn't finish in 10 pages`);
}

// ---------- drawing ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const num = (n) => Number(n).toLocaleString('en-US');  // 1,234, the way GitHub writes it

// Advance widths (em) of the characters the chips use, read from the shipped fredoka-latin.woff2
// (its hmtx table over unitsPerEm), so a chip's text can be measured before it's drawn.
const WIDTH = { 0: 0.572, 1: 0.383, 2: 0.577, 3: 0.572, 4: 0.549, 5: 0.501, 6: 0.526, 7: 0.533, 8: 0.547, 9: 0.526, ' ': 0.241, ',': 0.224, I: 0.232, a: 0.563, b: 0.563, c: 0.505, d: 0.565, e: 0.537, g: 0.552, h: 0.554, i: 0.242, j: 0.236, l: 0.301, m: 0.803, n: 0.563, o: 0.559, p: 0.552, q: 0.551, r: 0.423, s: 0.458, t: 0.411, u: 0.56, v: 0.564, y: 0.559, '’': 0.199 };
const measure = (s, px) => [...s].reduce((a, c) => a + (WIDTH[c] ?? 0.8), 0) * px;  // unknown characters count wide

// Font sizes for one chip: the usual 20 / 11.5 px, shrunk together if the line wouldn't fit.
function chipSizes(n, label, room) {
  const at = (k) => measure(n, 20 * k) + 7 * k + measure(label, 11.5 * k);
  const k = Math.min(1, room / at(1));
  return { n: +(20 * k).toFixed(2), t: +(11.5 * k).toFixed(2), dx: +(7 * k).toFixed(2), width: at(k) };
}

function frame(svg, snake, page, stats, theme, fontB64) {
  const T = THEMES[theme];
  const [x0, y0, w, h] = snake.viewBox;
  const LEFT = 30;   // room for the day names
  const STRIP = 72;  // room for the counts
  const nx = x0 - LEFT, nw = w + LEFT, nh = h + STRIP;
  const open = `<svg viewBox="${nx} ${y0} ${nw} ${nh}" width="${nw}" height="${nh}" ${MARK}`;

  // snk keeps a one-cell lane round the grid for the snake (x from -16, y from -16). The names sit
  // outside it: months above, days to the left. A month label that would sit one column from the
  // next one is left out, so the two never run into each other.
  const months = page.months
    .filter((m, i, a) => !a[i + 1] || a[i + 1].col - m.col >= 2)
    .map((m) => `<text class="lb" x="${OFF + m.col * PITCH}" y="-20">${esc(m.name)}</text>`).join('');
  const days = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]
    .map(([r, d]) => `<text class="lb" x="${x0 - 4}" y="${OFF + r * PITCH + 10}" text-anchor="end">${d}</text>`).join('');

  // Three glossy chips under the bar, as wide as the grid between them.
  const cols = Math.max(...page.cells.map((c) => c.col)) + 1;
  const gridW = (cols - 1) * PITCH + 12;
  const gap = 18, cw = (gridW - 2 * gap) / 3, ch = 46, cy = y0 + h + 14;
  const chips = [
    [stats.total, 'contributions in the last year'],
    [stats.prRepos, 'projects I’ve sent pull requests to'],
    [stats.merged, 'pull requests merged'],
  ].map(([n, label], i) => {
    const x = OFF + i * (cw + gap);
    const s = chipSizes(num(n), label, cw - ch);  // half a chip-height of room at each rounded end
    return `<g transform="translate(${x.toFixed(1)} ${cy})">`
      + `<rect width="${cw.toFixed(1)}" height="${ch}" rx="${ch / 2}" fill="url(#chip)" stroke="${T.edge}" stroke-width="1.5"/>`
      + `<rect x="10" y="3" width="${(cw - 20).toFixed(1)}" height="${ch / 2 - 3}" rx="${ch / 4}" fill="url(#gloss)"/>`
      + `<text x="${(cw / 2).toFixed(1)}" y="30" text-anchor="middle"><tspan class="n" style="font-size:${s.n}px">${num(n)}</tspan><tspan class="t" style="font-size:${s.t}px" dx="${s.dx}">${esc(label)}</tspan></text>`
      + '</g>';
  }).join('');

  const extra = `<defs><style>@font-face{font-family:'Fred';src:url(data:font/woff2;base64,${fontB64}) format('woff2');font-weight:600}`
    + `.lb{font:600 10px 'Fred',-apple-system,'Segoe UI',sans-serif;fill:${T.label}}`
    + `.n{font:600 20px 'Fred',-apple-system,'Segoe UI',sans-serif;fill:${T.num}}`
    + `.t{font:600 11.5px 'Fred',-apple-system,'Segoe UI',sans-serif;fill:${T.text}}</style>`
    + `<linearGradient id="chip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.chipTop}"/><stop offset="1" stop-color="${T.chipBottom}"/></linearGradient>`
    + `<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="${T.gloss}"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient></defs>`
    + `<g>${months}${days}</g><g>${chips}</g>`;

  // Replacer functions, so a "$" anywhere in the inserted text is never read as a pattern.
  return svg
    .replace(/^<svg viewBox="[^"]*" width="[^"]*" height="[^"]*"/, () => open)
    .replace(/<\/svg>\s*$/, () => `${extra}</svg>`);
}

// ---------- run ----------
async function readPage() {
  const r = await get(`https://github.com/users/${USER}/contributions`, { 'User-Agent': `${USER}-profile-snake` });
  if (!r.ok) throw new Error(`the contributions page answered ${r.status}`);
  return parsePage(await r.text());
}

async function main() {
  const dist = process.argv[2];
  if (!dist) throw new Error('usage: node frame.js <dist dir>');
  const token = process.env.GITHUB_TOKEN;
  // The page first, so snk's read and this one are as close together as they can be. The two
  // searches one after the other, to stay clear of GitHub's limit on bursts.
  const page = await readPage();
  if (!page.cells.length) throw new Error('no days on the contributions page');
  const since = page.cells.reduce((a, c) => (c.date < a ? c.date : a), page.cells[0].date);
  const q = queries(since);
  const opts = { budget: newBudget() };
  const prs = await projects(q.prs, token, opts);
  const merged = await count(q.merged, token, opts);
  const stats = { total: page.total, prRepos: prs.repos, merged };
  const font = fs.readFileSync(path.join(__dirname, 'fredoka-latin.woff2')).toString('base64');

  const files = ['light', 'dark'].map((theme) => ({ theme, file: path.join(dist, `snake-${theme}.svg`) }));
  const out = [];
  for (const { theme, file } of files) {
    const svg = fs.readFileSync(file, 'utf8');
    const snake = parseSnake(svg);
    const problems = check(page, snake);
    if (problems.length) throw new Error(`snake-${theme}.svg not framed:\n  - ${problems.join('\n  - ')}`);
    out.push([file, frame(svg, snake, page, stats, theme, font)]);
  }
  for (const [file, svg] of out) fs.writeFileSync(file, svg);  // only once both have passed
  console.log(`framed, since ${since}: ${stats.total} contributions, ${prs.total} pull requests to ${stats.prRepos} projects, ${stats.merged} merged`);
}

// GitHub's annotation format wants %, CR and LF escaped, in that order.
const annotate = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

if (require.main === module) {
  main().catch((e) => { console.error(`::error::${annotate(e.message)}`); process.exit(1); });
}

module.exports = { parsePage, parseSnake, check, frame, annotate, chipSizes, rateLimitWait, searchPage, queries, newBudget, THEMES };
