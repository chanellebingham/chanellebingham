// Draws my contribution graph as a still picture in glossy pink and gold tiles: the months along
// the top, Mon/Wed/Fri down the side, the year's total, and a Less-to-More key. The tiles in tiles/
// are two ElevenLabs renders (a pink jelly tile and a gold one), cut out and tinted into five levels
// outside this repo; only the finished PNGs live here. Runs in the Snake workflow next to frame.js.
//
//   node .github/snake/graph.js <dist dir> [<last good dir>]
//   env: GITHUB_USER, GITHUB_REPOSITORY, PAGE_CACHE (the page frame.js already read, if any),
//        LAST_OK ("true" when the workflow's checkout of the output branch into <last good dir> worked)
//
// Every square comes from the contributions page, and checkPage() has to pass first (each day in
// the square its date says, each month label on its month's first week). If anything goes wrong,
// from reading the page to writing the files, the last good graphs are put back into dist (from the
// output branch the workflow checked out into <last good dir>, or fetched), and the step fails so the
// run goes red. The graph never holds up the snake: each picture goes up on its own.
'use strict';
const fs = require('fs');
const path = require('path');
const { checkPage, readPage, get, num, measure, labels, styles, annotate, THEMES, USER, PITCH } = require('./frame.js');

const CELL = 13;                          // tile size; the spacing is the snake's PITCH (16), so the tiles are a bit bigger than its 12
const PAD = 18, LEFT = 32, TOP = 22, FOOT = 34;
const REPO = process.env.GITHUB_REPOSITORY || `${USER}/${USER}`;
const FILES = ['light', 'dark'].map((theme) => ({ theme, name: `graph-${theme}.svg` }));

const PANEL = {   // the edge is the theme's own gold (THEMES[theme].edge), shared with the snake's chips
  light: { top: '#FFFFFF', bottom: '#FFF0F7' },
  dark: { top: '#2A1726', bottom: '#1E0B1C' },
};

// The five tiles for each theme, read once: only the empty tile differs between light and dark.
function tileSets(dir) {
  const b64 = (n) => fs.readFileSync(path.join(dir, `graph-${n}.png`)).toString('base64');
  const shared = [b64('l1'), b64('l2'), b64('l3'), b64('l4')];
  return { light: [b64('l0-light'), ...shared], dark: [b64('l0-dark'), ...shared] };
}

function graph(page, theme, tiles, fontB64) {
  const T = THEMES[theme], P = { ...PANEL[theme], edge: T.edge };
  const cols = Math.max(...page.cells.map((c) => c.col)) + 1;
  const gx = PAD + LEFT, gy = PAD + TOP;
  const gw = (cols - 1) * PITCH + CELL, gh = 6 * PITCH + CELL;
  const W = gx + gw + PAD, H = gy + gh + FOOT + PAD - 10;
  const at = (col, row) => [gx + col * PITCH, gy + row * PITCH];

  const defs = tiles.map((t, i) => `<symbol id="t${i}" viewBox="0 0 48 48"><image href="data:image/png;base64,${t}" width="48" height="48"/></symbol>`).join('');
  const cells = page.cells.map((c) => { const [x, y] = at(c.col, c.row); return `<use href="#t${c.lvl}" x="${x}" y="${y}" width="${CELL}" height="${CELL}"/>`; }).join('');
  const names = labels(page, { monthX: (col) => at(col, 0)[0], monthY: gy - 8, dayX: gx - 6, dayY: (r) => at(0, r)[1] + 10 });

  // Footer: the year's total on the left (the page's own figure), the key on the right, ending
  // where the grid ends ("More" measured with the shipped font's own widths).
  const fy = gy + gh + 22;
  const right = gx + gw;
  const keyEnd = right - Math.ceil(measure('More', 10)) - 6;   // the last key tile's right edge
  const keyX = keyEnd - (4 * PITCH + CELL);
  const key = [0, 1, 2, 3, 4].map((l) => `<use href="#t${l}" x="${keyX + l * PITCH}" y="${fy - 11}" width="${CELL}" height="${CELL}"/>`).join('')
    + `<text class="lb" x="${keyX - 6}" y="${fy}" text-anchor="end">Less</text>`
    + `<text class="lb" x="${right}" y="${fy}" text-anchor="end">More</text>`;
  const total = `<text x="${gx}" y="${fy + 1}"><tspan class="n">${num(page.total)}</tspan><tspan class="t" dx="6">contributions in the last year</tspan></text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="gt">`
    + `<title id="gt">My contribution graph for the last year: ${num(page.total)} contributions</title>`
    + `<defs>${styles(T, fontB64, { n: 15, t: 11 })}`
    + `<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.top}"/><stop offset="1" stop-color="${P.bottom}"/></linearGradient>`
    + `${defs}</defs>`
    + `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="url(#panel)" stroke="${P.edge}" stroke-width="1.5"/>`
    + `<g>${names}</g><g>${cells}</g><g>${total}${key}</g></svg>\n`;
}

// The deploy publishes exactly what is in dist, so a graph missing from it would vanish from the
// README. These put the last good one back: from the checkout of the output branch when the checkout
// worked and its copy is a real graph, otherwise fetched. A file counts as a graph only if it is one
// of these pictures: an SVG with the year's total in it. The only put-back path; the workflow's
// fallback step calls it too (--keep), so nothing reaches dist unchecked.
// Whole, too: it has to close, since the total comes near the end and a cut can land after it.
const isGraph = (text) => /^<svg\b/.test(text) && text.includes('contributions in the last year') && /<\/svg>\s*$/.test(text);

function lastIsTrusted(last) {
  // A folder alone doesn't prove the checkout worked (checkout makes it before it fetches): trust it
  // only when the workflow says the checkout succeeded, or, run by hand, when it holds a git checkout.
  return Boolean(last) && fs.existsSync(last) && (process.env.LAST_OK ? process.env.LAST_OK === 'true' : fs.existsSync(path.join(last, '.git')));
}

async function keepOne(name, dist, last) {
  try {
    const file = last && path.join(last, name);
    if (lastIsTrusted(last)) {
      // A good checkout is the published copy: if it's missing it was never published, and if it's
      // broken, raw.githubusercontent would only serve the same file. Either way, nothing to fetch.
      if (fs.existsSync(file) && isGraph(fs.readFileSync(file, 'utf8'))) { fs.copyFileSync(file, path.join(dist, name)); return true; }
      return false;
    }
    const r = await get(`https://raw.githubusercontent.com/${REPO}/output/${name}`, { 'User-Agent': `${USER}-profile-snake` });
    const text = r.ok ? await r.text() : '';
    if (isGraph(text)) { fs.writeFileSync(path.join(dist, name), text); return true; }
  } catch { /* reported by the caller as not kept */ }
  return false;
}

// After a failure: put back both. With onlyMissing (the workflow's fallback step): only the ones not in dist.
async function keepLastGood(dist, last, { onlyMissing = false } = {}) {
  const kept = [];
  for (const { name } of FILES) {
    // "Missing" includes a file that isn't a whole graph (say, cut off when the step was killed mid-write).
    if (onlyMissing && fs.existsSync(path.join(dist, name)) && isGraph(fs.readFileSync(path.join(dist, name), 'utf8'))) continue;
    if (await keepOne(name, dist, last)) kept.push(name);
  }
  return kept;
}

async function loadPage() {
  const cache = process.env.PAGE_CACHE;
  if (cache && fs.existsSync(cache)) {
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* half-written: read the page myself */ }
  }
  return readPage();
}

async function main(dist = process.argv[2], last = process.argv[3]) {
  if (!dist) throw new Error('usage: node graph.js <dist dir> [<last good dir>]');
  try {
    const page = await loadPage();
    const problems = checkPage(page);
    if (problems.length) throw new Error(`graph not drawn:\n  - ${problems.join('\n  - ')}`);
    const font = fs.readFileSync(path.join(__dirname, 'fredoka-latin.woff2')).toString('base64');
    const tiles = tileSets(path.join(__dirname, 'tiles'));
    const out = FILES.map(({ theme, name }) => [name, graph(page, theme, tiles[theme], font)]);
    for (const [name, svg] of out) fs.writeFileSync(path.join(dist, name), svg);   // both drawn before either is written
    console.log(`graph drawn: ${page.cells.length} days, ${page.total} contributions, ${page.cells.filter((c) => c.lvl > 0).length} active days`);
  } catch (e) {
    const kept = await keepLastGood(dist, last);
    e.message += `\n(last good graphs put back: ${kept.length ? kept.join(', ') : 'none'})`;
    throw e;
  }
}

// --keep <dist> <last>: the workflow's fallback after a graph step that didn't finish. Puts back only
// what's missing, says what it kept, and never fails the job itself (the run's last step reports it).
async function keepMode(dist = process.argv[3], last = process.argv[4]) {
  const kept = await keepLastGood(dist, last, { onlyMissing: true });
  console.log(`last good graphs put back: ${kept.length ? kept.join(', ') : 'none'}`);
}

if (require.main === module) {
  if (process.argv[2] === '--keep') keepMode().catch((e) => console.error(`::warning::${annotate(e.message)}`));
  else main().catch((e) => { console.error(`::error::${annotate(e.message)}`); process.exit(1); });
}

module.exports = { graph, tileSets, keepLastGood, keepMode, isGraph, loadPage, main };
