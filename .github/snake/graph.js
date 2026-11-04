// Draws my contribution graph in glossy pink and gold tiles, with a glossy pink snake with thin gold
// scales eating it, and my three counts underneath, all in one gold-edged box. The months run along
// the top, Mon/Wed/Fri down the side. The tiles in tiles/ are two ElevenLabs renders (a pink jelly
// tile and a gold one), cut out and tinted into five levels outside this repo; only the finished
// PNGs live here. Runs in the Snake workflow after snk.
//
//   node .github/snake/graph.js <dist dir> [<last good dir>]
//   env: GITHUB_USER, GITHUB_REPOSITORY, GITHUB_TOKEN (for the counts), SNK_DIR (where snk wrote
//        snake-light.svg and snake-dark.svg; default <dist dir>), LAST_OK ("true" when the
//        workflow's checkout of the output branch into <last good dir> worked)
//
// The snake keeps snk's own time: snk works out its path and writes, for every square, the moment
// the snake reaches it. This reads those moments and the snake's moves back out of snk's picture and
// puts them on the glossy tiles: when the snake reaches a square, that tile turns into the empty one,
// and when the loop starts again every tile comes back. Every number is read with a strict pattern
// and written out again from the number, so nothing else from snk's picture gets into this one.
//
// Every square comes from the contributions page, and checkPage() has to pass first (each day in the
// square its date says, each month label on its month's first week). If the page can't be read or
// drawn, the last good graphs are put back into dist (from the output branch the workflow checked out
// into <last good dir>, or fetched) and the step fails. If only the snake or the counts can't be had,
// the graph still goes up fresh without them (the still graph, or the year's total on its own line),
// and the step fails so the run goes red and someone looks. The box never goes blank. The graph is
// written before the counts are asked for, so a step that runs out of time during the searches
// still leaves a fresh graph.
'use strict';
const fs = require('fs');
const path = require('path');
const { checkPage, checkGrid, parseSnake, readPage, readStats, get, num, measure, labels, styles, chipRow, chipDefs, CHIP_H, annotate, THEMES, USER, PITCH } = require('./frame.js');

const CELL = 13;                          // tile size; the spacing is the snake's PITCH (16), so the tiles are a bit bigger than its 12
const PAD = 18, LEFT = 32, TOP = 22, FOOT = 34;
const LANE = 2 * PITCH;                   // snk lets the snake go up to two squares outside the grid on every side (its solver's isInsideLarge(grid, 2, x, y))
const REPO = process.env.GITHUB_REPOSITORY || `${USER}/${USER}`;
const FILES = ['light', 'dark'].map((theme) => ({ theme, name: `graph-${theme}.svg` }));

const PANEL = {   // the edge is the theme's own gold (THEMES[theme].edge), shared with the chips
  light: { top: '#FFFFFF', bottom: '#FFF0F7' },
  dark: { top: '#2A1726', bottom: '#1E0B1C' },
};

// The snake's glossy pink, top to bottom, and how strong its shine is. Its edge and scales are the
// theme's gold.
const SNAKE = {
  light: { top: '#FF8FCF', mid: '#E0218A', bottom: '#B3156F', shine: 0.75 },
  dark: { top: '#FFC2E4', mid: '#FF8FCF', bottom: '#E0559F', shine: 0.45 },
};

// The five tiles for each theme, read once: only the empty tile differs between light and dark.
function tileSets(dir) {
  const b64 = (n) => fs.readFileSync(path.join(dir, `graph-${n}.png`)).toString('base64');
  const shared = [b64('l1'), b64('l2'), b64('l3'), b64('l4')];
  return { light: [b64('l0-light'), ...shared], dark: [b64('l0-dark'), ...shared] };
}

// ---------- reading snk's picture ----------
const NUM = '-?\\d+(?:\\.\\d+)?';
const PCT = '\\d+(?:\\.\\d+)?%';

// The loop length, when each lit square is eaten, and the snake's pieces with their moves, out of
// the picture snk drew (its squares as frame.js parseSnake() reads them). Returns { problems, snk };
// anything not in the shape snk writes is a problem, never a guess.
function parseSnk(svg, grid = parseSnake(String(svg))) {
  svg = String(svg);
  const problems = [];
  const style = (String(svg).match(/<style>([\s\S]*?)<\/style>/) || [])[1];
  if (!style) return { problems: ['there is no <style> in snk’s picture'], snk: null };
  const cMs = style.match(/\.c\{[^}]*\banimation:none (\d+)ms linear infinite/);
  const sMs = style.match(/\.s\{[^}]*\banimation:none linear (\d+)ms infinite/);
  if (!cMs || !sMs) problems.push('snk’s picture has no loop length for the squares or for the snake');
  else if (cMs[1] !== sMs[1]) problems.push(`the squares loop every ${cMs[1]} ms but the snake every ${sMs[1]} ms`);
  const ms = cMs ? +cMs[1] : 0;
  if (cMs && !(ms >= 1000 && ms <= 600000)) problems.push(`a loop of ${ms} ms isn’t one snk would draw`);

  // When each square is eaten: its level's colour up to `at`, the empty colour from `gone`.
  const eatBy = new Map();
  for (const [, name, at, gone] of style.matchAll(/@keyframes (c[0-9a-z]+)\{(\d+(?:\.\d+)?)%\{fill:var\(--c[1-4]\)\}(\d+(?:\.\d+)?)%,100%\{fill:var\(--ce\)\}\}/g)) {
    if (!(+at < +gone && +gone <= 100)) problems.push(`square ${name} is eaten at ${at}% and gone at ${gone}%`);
    eatBy.set(name, { at: +at, gone: +gone });
  }
  const { cells } = grid;
  const noTime = cells.filter((c) => c.cls && !eatBy.has(c.cls));
  if (noTime.length) problems.push(`lit squares with no time to be eaten: ${noTime.slice(0, 5).map((c) => `${c.col},${c.row}`).join(' ')}`);

  // The snake: a few rounded squares, each with its own moves (translate only) and a starting place.
  // Every move has to stay on the grid or in snk's lane two squares round it, the room graph() leaves.
  const cols = cells.length ? Math.max(...cells.map((c) => c.col)) + 1 : 0;
  const inLane = (x, y) => x >= -LANE && x <= (cols - 1) * PITCH + LANE && y >= -LANE && y <= 6 * PITCH + LANE;
  const segs = [];
  const segRe = new RegExp(`<rect class="s (s\\d+)" x="(${NUM})" y="(${NUM})" width="(${NUM})" height="(${NUM})" rx="(${NUM})" ry="(${NUM})"/>`, 'g');
  for (const [, name, x, y, w, h, rx] of svg.matchAll(segRe)) {
    const kf = style.match(new RegExp(`@keyframes ${name}\\{((?:${PCT}(?:,${PCT})*\\{transform:translate\\(${NUM}px,${NUM}px\\)\\})+)\\}`));
    const start = style.match(new RegExp(`\\.s\\.${name}\\{transform:translate\\((${NUM})px,(${NUM})px\\);animation-name:${name}\\}`));
    if (!kf || !start) { problems.push(`snake piece ${name} has no moves I can read`); continue; }
    const stops = [...kf[1].matchAll(new RegExp(`(${PCT}(?:,${PCT})*)\\{transform:translate\\((${NUM})px,(${NUM})px\\)\\}`, 'g'))]
      .map(([, at, tx, ty]) => ({ at: at.split(',').map((p) => +p.slice(0, -1)), x: +tx, y: +ty }));
    const seg = { x: +x, y: +y, w: +w, h: +h, r: +rx, start: [+start[1], +start[2]], stops };
    // Each piece sits inside its own square (snk draws them 0.8 to 3 px in), so its moves are where it is.
    const fits = [seg.w, seg.h].every((v) => v > 0) && seg.x >= 0 && seg.y >= 0 && seg.x + seg.w <= PITCH && seg.y + seg.h <= PITCH;
    if (stops.some((s) => s.at.some((p) => p > 100)) || !fits || !(seg.r >= 0 && seg.r <= seg.w / 2)) problems.push(`snake piece ${name} isn’t the size, place or timing snk draws`);
    if (![seg.start, ...stops.map((s) => [s.x, s.y])].every(([a, b]) => inLane(a, b))) problems.push(`snake piece ${name} goes outside the grid and its lane`);
    segs.push(seg);
  }
  if (!segs.length) problems.push('snk’s picture has no snake in it');
  return { problems, snk: problems.length ? null : { ms, eatBy, cells, segs } };
}

// The snake for this page (already through checkPage()): snk's picture read, and its grid matching
// the page cell for cell (frame.js checkGrid()). `eat` maps a lit square ("col,row") to its slot in
// `times`; squares eaten at the same moment share a slot. A square lit on the page but not yet in
// snk's grid (a contribution made between the two reads, which checkGrid() allows in the newest week)
// simply isn't eaten.
function snakeFor(page, svg) {
  const grid = parseSnake(String(svg));
  const { problems, snk } = parseSnk(svg, grid);
  problems.push(...checkGrid(page, grid));
  if (problems.length) return { problems, snake: null };
  const lit = new Set(page.cells.filter((c) => c.lvl > 0).map((c) => `${c.col},${c.row}`));
  const times = [], slot = new Map(), eat = new Map();
  for (const c of snk.cells) {
    const k = `${c.col},${c.row}`;
    if (!c.cls || !lit.has(k)) continue;
    if (!slot.has(c.cls)) { slot.set(c.cls, times.length); times.push(snk.eatBy.get(c.cls)); }
    eat.set(k, slot.get(c.cls));
  }
  return { problems: [], snake: { ms: snk.ms, times, eat, segs: snk.segs } };
}

// ---------- drawing ----------
const pct = (list) => list.map((p) => `${p}%`).join(',');

// The snake's CSS: each eaten tile fades out at snk's moment, and each piece moves the way snk moves
// it. Written from the numbers alone. Still for anyone who asks their system for less motion.
function snakeCss(snake) {
  return `.e{animation:none ${snake.ms}ms linear infinite}`
    + snake.times.map((t, i) => `@keyframes e${i}{0%,${t.at}%{opacity:1}${t.gone}%,100%{opacity:0}}.e.e${i}{animation-name:e${i}}`).join('')
    + `.s{animation:none linear ${snake.ms}ms infinite}`
    + snake.segs.map((s, i) => `@keyframes s${i}{${s.stops.map((k) => `${pct(k.at)}{transform:translate(${k.x}px,${k.y}px)}`).join('')}}`
      + `.s.s${i}{transform:translate(${s.start[0]}px,${s.start[1]}px);animation-name:s${i}}`).join('')
    + '@media (prefers-reduced-motion:reduce){.e,.s{animation:none!important}}';   // !important: the per-tile and per-piece rules are more specific
}

function snakeDefs(theme, edge) {
  const S = SNAKE[theme];
  return `<linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${S.top}"/><stop offset=".55" stop-color="${S.mid}"/><stop offset="1" stop-color="${S.bottom}"/></linearGradient>`
    + `<linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="${S.shine}"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>`
    // Scales: rows of small arcs, every other row shifted half a scale, in a very thin gold line.
    + `<pattern id="sc" width="4" height="3" patternUnits="userSpaceOnUse"><path d="M0 3a2 2 0 0 1 4 0M-2 1.5a2 2 0 0 1 4 0M2 1.5a2 2 0 0 1 4 0" fill="none" stroke="${edge}" stroke-width=".35" stroke-opacity=".9"/></pattern>`;
}

// One piece of the snake: glossy pink, gold scales, a shine on top, and a thin gold edge.
function snakePiece(s, i, edge) {
  const box = `x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" ry="${s.r}"`;
  const sx = +(s.x + s.w * 0.18).toFixed(2), sy = +(s.y + s.h * 0.1).toFixed(2), sw = +(s.w * 0.64).toFixed(2), sh = +(s.h * 0.38).toFixed(2);
  return `<g class="s s${i}"><rect ${box} fill="url(#sk)"/><rect ${box} fill="url(#sc)"/>`
    + `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${+(sh / 2).toFixed(2)}" fill="url(#sg)"/>`
    + `<rect ${box} fill="none" stroke="${edge}" stroke-width=".8"/></g>`;
}

// The picture. With no snake it's the still graph; with no stats, the year's total sits on its own
// line beside the key instead of the three chips.
function graph(page, theme, tiles, fontB64, { snake = null, stats = null } = {}) {
  const T = THEMES[theme], P = { ...PANEL[theme], edge: T.edge };
  const lane = snake ? LANE : 0;
  const cols = Math.max(...page.cells.map((c) => c.col)) + 1;
  const gx = PAD + LEFT + lane, gy = PAD + TOP + lane;
  const gw = (cols - 1) * PITCH + CELL, gh = 6 * PITCH + CELL;
  const right = gx + gw;
  const fy = gy + gh + lane + 22;           // the footer's baseline, below the snake's bottom lane
  const W = right + lane + PAD;
  const H = stats ? fy + 14 + CHIP_H + PAD : gy + gh + lane + FOOT + PAD - 10;
  const at = (col, row) => [gx + col * PITCH, gy + row * PITCH];

  const defs = tiles.map((t, i) => `<symbol id="t${i}" viewBox="0 0 48 48"><image href="data:image/png;base64,${t}" width="48" height="48"/></symbol>`).join('');
  const eat = snake ? snake.eat : new Map();
  const cells = page.cells.map((c) => {
    const [x, y] = at(c.col, c.row);
    const tile = (lvl, cls = '') => `<use${cls} href="#t${lvl}" x="${x}" y="${y}" width="${CELL}" height="${CELL}"/>`;
    const slot = c.lvl > 0 ? eat.get(`${c.col},${c.row}`) : undefined;
    return slot === undefined ? tile(c.lvl) : tile(0) + tile(c.lvl, ` class="e e${slot}"`);   // the empty tile waits underneath
  }).join('');
  // Months above the snake's lane, days left of it.
  const names = labels(page, { monthX: (col) => at(col, 0)[0], monthY: gy - 8 - lane, dayX: gx - 6 - lane, dayY: (r) => at(0, r)[1] + 10 });

  // snk puts a piece's centre at 8 + 16 * col; a tile's centre is gx + 6.5 + 16 * col.
  const snakeArt = snake ? `<g transform="translate(${gx + CELL / 2 - 8} ${gy + CELL / 2 - 8})">${snake.segs.map((s, i) => snakePiece(s, i, T.edge)).join('')}</g>` : '';

  // Footer: the key on the right, ending where the grid ends ("More" measured with the shipped
  // font's own widths). Then either the three chips underneath, or the year's total on the left.
  const keyEnd = right - Math.ceil(measure('More', 10)) - 6;   // the last key tile's right edge
  const keyX = keyEnd - (4 * PITCH + CELL);
  const key = [0, 1, 2, 3, 4].map((l) => `<use href="#t${l}" x="${keyX + l * PITCH}" y="${fy - 11}" width="${CELL}" height="${CELL}"/>`).join('')
    + `<text class="lb" x="${keyX - 6}" y="${fy}" text-anchor="end">Less</text>`
    + `<text class="lb" x="${right}" y="${fy}" text-anchor="end">More</text>`;
  const counts = stats
    ? chipRow(stats, T, { x: gx, y: fy + 14, width: gw })
    : `<text x="${gx}" y="${fy + 1}"><tspan class="n">${num(page.total)}</tspan><tspan class="t" dx="6">contributions in the last year</tspan></text>`;

  const title = `My contribution graph for the last year: ${num(page.total)} contributions${snake ? ', with a glossy pink snake eating it' : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="gt">`
    + `<title id="gt">${title}</title>`
    + `<defs>${styles(T, fontB64, stats ? { n: 20, t: 11.5 } : { n: 15, t: 11 })}`
    + (snake ? `<style>${snakeCss(snake)}</style>${snakeDefs(theme, T.edge)}` : '')
    + (stats ? chipDefs(T) : '')
    + `<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.top}"/><stop offset="1" stop-color="${P.bottom}"/></linearGradient>`
    + `${defs}</defs>`
    + `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="url(#panel)" stroke="${P.edge}" stroke-width="1.5"/>`
    + `<g>${names}</g><g>${cells}</g>${snakeArt}<g>${key}${counts}</g></svg>\n`;
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

// Puts both pictures into dist together. Each is written whole under a temporary name beside dist
// (never inside it, since the deploy publishes everything in dist), then both are renamed into
// place, so a step killed mid-write never leaves a cut-off graph for the fallback to swap out. If
// a rename fails partway, the pictures that were there before go back, so dist never holds one new
// picture and one old one.
function writeBoth(dist, out) {
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(dist)), '.graph-'));
  try {
    for (const [name, svg] of out) fs.writeFileSync(path.join(tmp, name), svg);
    const moved = [];
    try {
      for (const [name] of out) {
        const to = path.join(dist, name);
        if (fs.existsSync(to)) fs.renameSync(to, path.join(tmp, `${name}.old`));
        fs.renameSync(path.join(tmp, name), to);
        moved.push(name);
      }
    } catch (e) {
      for (const [name] of out) {
        const old = path.join(tmp, `${name}.old`), to = path.join(dist, name);
        if (fs.existsSync(old)) fs.renameSync(old, to);
        else if (moved.includes(name)) fs.rmSync(to, { force: true });
      }
      throw e;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Draws both pictures and returns what it had to leave out (empty when nothing). Throws only when
// the graph itself couldn't be drawn, after putting the last good ones back. The graph goes into
// dist before the counts are asked for, and again with the chips once they're in, so searches that
// take too long (rate limits) can't hold up a fresh graph.
async function main(dist = process.argv[2], last = process.argv[3]) {
  if (!dist) throw new Error('usage: node graph.js <dist dir> [<last good dir>]');
  const snkDir = process.env.SNK_DIR || dist;
  fs.mkdirSync(dist, { recursive: true });   // snk writes to its own folder, so this step may be the first to make dist
  const left = [];
  let page, snakes, draw;
  try {
    page = await readPage();
    const problems = checkPage(page);
    if (problems.length) throw new Error(`graph not drawn:\n  - ${problems.join('\n  - ')}`);
    const font = fs.readFileSync(path.join(__dirname, 'fredoka-latin.woff2')).toString('base64');
    const tiles = tileSets(path.join(__dirname, 'tiles'));
    snakes = FILES.map(({ theme }) => {
      const file = `snake-${theme}.svg`;
      try {
        const r = snakeFor(page, fs.readFileSync(path.join(snkDir, file), 'utf8'));
        if (!r.problems.length) return r.snake;
        left.push(`${file}: the snake is left out:\n    - ${r.problems.join('\n    - ')}`);
      } catch (e) { left.push(`${file} not read, so the snake is left out: ${e.message}`); }
      return null;
    });
    // Light and dark stay alike (same size, same snake): if either snake can't be had, neither has one.
    if (snakes.includes(null) && snakes.some(Boolean)) {
      left.push('so the snake is left out of the other picture too, to keep light and dark alike');
      snakes = snakes.map(() => null);
    }
    draw = (stats) => writeBoth(dist, FILES.map(({ theme, name }, i) => [name, graph(page, theme, tiles[theme], font, { snake: snakes[i], stats })]));
    draw(null);
  } catch (e) {
    const kept = await keepLastGood(dist, last);
    e.message += `\n(last good graphs put back: ${kept.length ? kept.join(', ') : 'none'})`;
    throw e;
  }
  let stats = null;
  try { stats = await readStats(page, process.env.GITHUB_TOKEN); } catch (e) { left.push(`counts not read, so the year's total goes up on its own: ${e.message}`); }
  if (stats) {
    try { draw(stats); } catch (e) { stats = null; left.push(`the chips couldn't be drawn, so the year's total goes up on its own: ${e.message}`); }
  }
  console.log(`graph drawn: ${page.cells.length} days, ${page.total} contributions, ${page.cells.filter((c) => c.lvl > 0).length} active days; snake in ${snakes.filter(Boolean).length} of 2`
    + (stats ? `; since ${stats.since}: ${stats.prs} pull requests to ${stats.prRepos} projects, ${stats.merged} merged` : ''));
  return left;
}

// --keep <dist> <last>: the workflow's fallback after a graph step that didn't finish. Puts back only
// what's missing, says what it kept, and never fails the job itself (the run's last step reports it).
async function keepMode(dist = process.argv[3], last = process.argv[4]) {
  fs.mkdirSync(dist, { recursive: true });
  const kept = await keepLastGood(dist, last, { onlyMissing: true });
  console.log(`last good graphs put back: ${kept.length ? kept.join(', ') : 'none'}`);
}

if (require.main === module) {
  if (process.argv[2] === '--keep') keepMode().catch((e) => console.error(`::warning::${annotate(e.message)}`));
  else {
    main().then((left) => {
      if (left.length) { console.error(`::error::${annotate(`graph drawn, but without:\n  - ${left.join('\n  - ')}`)}`); process.exitCode = 1; }
    }).catch((e) => { console.error(`::error::${annotate(e.message)}`); process.exit(1); });
  }
}

module.exports = { graph, tileSets, parseSnk, snakeFor, snakeCss, writeBoth, keepLastGood, keepMode, isGraph, main };
