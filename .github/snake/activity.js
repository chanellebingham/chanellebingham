// Draws my activity overview, the cross GitHub draws on my profile with commits, pull requests,
// issues and code review on its arms, as a sparkly picture in my colours (light and dark). Then one
// small card per organisation in ORGS, each in its own colour with that organisation's own cross
// and counts; the README links each card to my pull requests there. Runs in the Snake workflow.
//
//   node .github/snake/activity.js <dist dir> [<last good dir>]
//   env: GITHUB_TOKEN, GITHUB_USER, GITHUB_REPOSITORY,
//        LAST_OK ("true" when the workflow's checkout of the output branch into <last good dir> worked)
//
// The big cross uses the percentages GitHub itself puts on my contributions page, so it says what
// GitHub's own cross says. The cards use GitHub's API (contributionsCollection, the last year, the
// same window), added up per organisation. The two halves are drawn on their own: if one goes wrong,
// its last good pictures are put back into dist, the other half still updates, and the step fails so
// the run goes red. The snake and the graph never wait on this.
'use strict';
const fs = require('fs');
const path = require('path');
const { get, esc, num, measure, THEMES, USER } = require('./frame.js');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');   // for text inside an attribute

const REPO = process.env.GITHUB_REPOSITORY || `${USER}/${USER}`;
const KINDS = [   // GitHub's names on the page, my arm for each, and its colour
  { key: 'Code review', arm: 'up', colour: '#B07CFF' },
  { key: 'Issues', arm: 'right', colour: '#4FB8E8' },
  { key: 'Pull requests', arm: 'down', colour: '#E0218A' },
  { key: 'Commits', arm: 'left', colour: '#E0A82E' },
];
const DIR = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

// The organisations with a card, in the README's order, each with its own colour. The cards are
// drawn by login; one with no contributions in the window still gets a card, with zeros.
const ORGS = [
  { login: 'WesternFriend', name: 'Western Friend', colour: '#E0218A' },
  { login: 'gohugoio', name: 'Hugo', colour: '#FF6F91' },
  { login: 'jupyterlab', name: 'JupyterLab', colour: '#F28C38' },
  { login: 'quarto-dev', name: 'Quarto', colour: '#4A7BE0' },
  { login: 'mui', name: 'MUI', colour: '#8A5CF5' },
  { login: 'home-assistant', name: 'Home Assistant', colour: '#1FA9C9' },
  // mozmeao is Mozilla's marketing engineering, where springfield lives: its counts go on the Mozilla
  // card (the shape stays mozilla's own page; GitHub has no page for the two together).
  { login: 'mozilla', also: ['mozmeao'], name: 'Mozilla', colour: '#2FA77A' },
  { login: 'readthedocs', name: 'Read the Docs', colour: '#C9961F' },
];

const OVERVIEW = ['light', 'dark'].map((theme) => ({ theme, name: `activity-${theme}.svg` }));
const cardName = (login) => `orgs/${login}.svg`;
const FILES = [...OVERVIEW.map((f) => f.name), ...ORGS.map((o) => cardName(o.login))];

// ---------- reading ----------

// GitHub's own percentages from the contributions page: data-percentages on the activity overview.
// Returns null if the page has none (the overview is off in my settings, or GitHub changed the page).
function parseOverview(html) {
  const m = html.match(/data-percentages="([^"]+)"/);
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; }
  for (const { key } of KINDS) if (!Number.isFinite(p[key]) || p[key] < 0 || p[key] > 100) return null;
  return Object.fromEntries(KINDS.map(({ key }) => [key, p[key]]));
}

const QUERY = `query($login: String!) { user(login: $login) { contributionsCollection {
  commitContributionsByRepository(maxRepositories: 100) { repository { owner { login } } contributions { totalCount } }
  issueContributionsByRepository(maxRepositories: 100) { repository { owner { login } } contributions { totalCount } }
  pullRequestReviewContributionsByRepository(maxRepositories: 100) { repository { owner { login } } contributions { totalCount } }
  pullRequestContributionsByRepository(maxRepositories: 100) { repository { owner { login } } contributions(first: 100) { totalCount nodes { pullRequest { merged } } } }
} } }`;

// The API's per-repository lists, added up per organisation (owner login, compared ignoring case).
// Each list stops at 100 repositories, busiest first; a full one could have left a card's
// organisation out, so it's refused rather than read as zeros.
const CARDED = new Set(ORGS.flatMap((o) => [o.login, ...(o.also || [])]).map((l) => l.toLowerCase()));
function orgTotals(collection) {
  const out = {};
  for (const k of ['commitContributionsByRepository', 'issueContributionsByRepository', 'pullRequestReviewContributionsByRepository', 'pullRequestContributionsByRepository']) {
    if (collection[k].length >= 100) throw new Error(`${k} came back with 100 repositories, its limit; a card could read short`);
  }
  const at = (login) => (out[login.toLowerCase()] ??= { commits: 0, prs: 0, merged: 0, issues: 0, reviews: 0 });
  for (const r of collection.commitContributionsByRepository) at(r.repository.owner.login).commits += r.contributions.totalCount;
  for (const r of collection.issueContributionsByRepository) at(r.repository.owner.login).issues += r.contributions.totalCount;
  for (const r of collection.pullRequestReviewContributionsByRepository) at(r.repository.owner.login).reviews += r.contributions.totalCount;
  for (const r of collection.pullRequestContributionsByRepository) {
    const o = at(r.repository.owner.login);
    o.prs += r.contributions.totalCount;
    // Only the first 100 per repository come back; more than that and a card's merged count would be
    // short. Organisations without a card aren't drawn, so they never stop the run.
    if (r.contributions.nodes.length < r.contributions.totalCount && CARDED.has(r.repository.owner.login.toLowerCase())) throw new Error(`more than ${r.contributions.nodes.length} pull requests in one repository; the merged count would be short`);
    o.merged += r.contributions.nodes.filter((n) => n.pullRequest && n.pullRequest.merged).length;
  }
  return out;
}

async function readCollection(token) {
  if (!token) throw new Error('no GITHUB_TOKEN: the organisation cards need the API');
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': `${USER}-profile-snake` },
    body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`the API answered ${r.status}`);
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(`the API said: ${j.errors.map((e) => e.message).join('; ')}`);
  return j.data.user.contributionsCollection;
}

// ---------- drawing ----------

// Small deterministic random, so the sparkles sit in the same places every run.
function rand(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const f1 = (n) => +n.toFixed(1);

// Where each arm's point sits: the biggest share reaches 90% of the arm, the rest in proportion, and
// none closer to the middle than `min`, so a 0% arm still shows a point and the shape never folds flat.
function points(pcts, cx, cy, arm, min) {
  const top = Math.max(1, ...KINDS.map(({ key }) => pcts[key]));
  return KINDS.map(({ key, arm: a }) => {
    const d = Math.max(min, (arm * 0.9 * pcts[key]) / top);
    return [f1(cx + DIR[a][0] * d), f1(cy + DIR[a][1] * d)];
  });
}

const sparkle = (x, y, s, fill, cls) => `<path class="${cls}" d="M${f1(x)} ${f1(y - s)}Q${f1(x + s * 0.18)} ${f1(y - s * 0.18)} ${f1(x + s)} ${f1(y)}Q${f1(x + s * 0.18)} ${f1(y + s * 0.18)} ${f1(x)} ${f1(y + s)}Q${f1(x - s * 0.18)} ${f1(y + s * 0.18)} ${f1(x - s)} ${f1(y)}Q${f1(x - s * 0.18)} ${f1(y - s * 0.18)} ${f1(x)} ${f1(y - s)}Z" fill="${fill}"/>`;

const twinkleCss = '.sp{transform-box:fill-box;transform-origin:center;animation:tw 3.2s ease-in-out infinite}'
  + '@keyframes tw{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.5)}}'
  + '@media (prefers-reduced-motion:reduce){.sp{animation:none}}';
const delays = (n) => Array.from({ length: n }, (_, i) => `.s${i}{animation-delay:-${(i * 0.53).toFixed(2)}s;animation-duration:${(2.6 + (i % 4) * 0.45).toFixed(2)}s}`).join('');

const fontFace = (fontB64) => `@font-face{font-family:'Fred';src:url(data:font/woff2;base64,${fontB64}) format('woff2');font-weight:600}`;
const font = (px) => `font:600 ${px}px 'Fred',-apple-system,'Segoe UI',sans-serif`;

const PANEL = {
  light: { top: '#FFFFFF', bottom: '#FFF0F7', grid: '#F4C6DD', shape: ['#FF8FCF', '#E0218A'], shapeOpacity: 0.5, dot: '#FFFFFF', spark: '#FF5FB0' },
  dark: { top: '#2A1726', bottom: '#1E0B1C', grid: '#5C2A4A', shape: ['#FF8FCF', '#C21875'], shapeOpacity: 0.55, dot: '#FBE9F2', spark: '#FFFFFF' },
};

// The big cross, for one theme. `art` holds the base64 sprites: glint (a sparkle) and cap (the emoji).
function overview(pcts, theme, fontB64, art) {
  const T = THEMES[theme], P = PANEL[theme];
  const W = 880, H = 320, cx = 200, cy = 162, arm = 104;
  const pts = points(pcts, cx, cy, arm, 7);
  const sr = rand(theme === 'light' ? 41 : 43);

  const axes = KINDS.map(({ arm: a }) => `<line x1="${cx}" y1="${cy}" x2="${cx + DIR[a][0] * arm}" y2="${cy + DIR[a][1] * arm}" stroke="${P.grid}" stroke-width="2" stroke-linecap="round"/>`).join('');
  const rings = [0.33, 0.66, 1].map((k) => `<path d="M${cx} ${f1(cy - arm * k)}L${f1(cx + arm * k)} ${cy}L${cx} ${f1(cy + arm * k)}L${f1(cx - arm * k)} ${cy}Z" fill="none" stroke="${P.grid}" stroke-width="1" stroke-dasharray="2 5" stroke-linecap="round"/>`).join('');
  const shape = `<path d="M${pts.map((p) => p.join(' ')).join('L')}Z" fill="url(#shape)" fill-opacity="${P.shapeOpacity}" stroke="${T.edge}" stroke-width="2.5" stroke-linejoin="round"/>`;
  // As on the cards: a dot only where the share isn't 0, so a bare corner never looks like activity.
  const dots = pts.map(([x, y], i) => (pcts[KINDS[i].key] > 0 ? `<circle cx="${x}" cy="${y}" r="7" fill="${KINDS[i].colour}" stroke="${P.dot}" stroke-width="2.5"/><circle cx="${f1(x - 2)}" cy="${f1(y - 2.2)}" r="2" fill="#FFFFFF" fill-opacity=".85"/>` : '')).join('');

  // Labels at the arm ends: the share big, the name under (or beside) it.
  const lab = {
    up: [cx, cy - arm - 30, 'middle'], down: [cx, cy + arm + 22, 'middle'],
    left: [cx - arm - 16, cy - 6, 'end'], right: [cx + arm + 16, cy - 6, 'start'],
  };
  const labels = KINDS.map(({ key, arm: a }) => {
    const [x, y, anchor] = lab[a];
    return `<text x="${x}" y="${y}" text-anchor="${anchor}"><tspan class="pc">${pcts[key]}%</tspan><tspan class="kd" x="${x}" dy="15">${esc(key)}</tspan></text>`;
  }).join('');

  // The right side: what the picture is, then each kind as a glossy bar with its share.
  const rx = 430, bw = 380;
  const rows = KINDS.map(({ key, colour }, i) => {
    const y = 138 + i * 38;
    const w = f1((bw * pcts[key]) / 100);
    return `<circle cx="${rx + 7}" cy="${y - 5}" r="7" fill="${colour}"/>`
      + `<text class="kd2" x="${rx + 22}" y="${y}">${esc(key)}</text>`
      + `<text class="pc2" x="${rx + bw}" y="${y}" text-anchor="end">${pcts[key]}%</text>`
      + `<rect x="${rx}" y="${y + 7}" width="${bw}" height="9" rx="4.5" fill="${P.grid}" fill-opacity=".55"/>`
      + (w > 0 ? `<rect x="${rx}" y="${y + 7}" width="${Math.max(9, w)}" height="9" rx="4.5" fill="${colour}"/>` : '')   // 0% draws no fill; a sliver shows as a dot
      + (w > 6 ? `<rect x="${rx + 3}" y="${y + 8.5}" width="${f1(w - 6)}" height="2.5" rx="1.25" fill="#FFFFFF" fill-opacity=".55"/>` : '');
  }).join('');
  const head = `<text class="hd" x="${rx}" y="70">What I do on GitHub</text>`
    + `<text class="sub" x="${rx}" y="94">My last year, the way GitHub counts it</text>`;
  const cap = art.cap ? `<image href="data:image/png;base64,${art.cap}" x="${rx + bw - 58}" y="30" width="58" height="58"/>` : '';

  // Sparkles: one on each point, and a few about the panel (kept off the text on the right).
  // The loose ones keep clear of the four labels (a box around each), so no sparkle sits on a word.
  const clear = [[cx - 50, cy - arm - 52, cx + 50, cy - arm - 8], [cx - 55, cy + arm + 4, cx + 55, cy + arm + 44],
    [cx - arm - 82, cy - 28, cx - arm - 8, cy + 16], [cx + arm + 8, cy - 28, cx + arm + 82, cy + 16]];
  const loose = [];
  for (let tries = 0; loose.length < 7 && tries < 200; tries++) {
    const [x, y, s] = [f1(30 + sr() * 340), f1(34 + sr() * 262), f1(3.5 + sr() * 4)];
    if (!clear.some(([x0, y0, x1, y1]) => x > x0 - s && x < x1 + s && y > y0 - s && y < y1 + s)) loose.push([x, y, s]);
  }
  // A sparkle beside each point that has something to show (like the dots, none on a 0% arm).
  const spots = [...pts.filter((_, i) => pcts[KINDS[i].key] > 0).map(([x, y]) => [x + 10, y - 10, 6]), ...loose];
  const sparks = spots.map(([x, y, s], i) => sparkle(x, y, s, i % 3 ? '#F2C14E' : P.spark, `sp s${i}`)).join('');

  // The pink numbers are text: on the light panel's pinkest edge the theme's pink is just under 4.5:1,
  // so it is darkened there (same hue). The dark panel already reads well above it.
  const numInk = theme === 'light' ? ink(T.num, P.bottom) : T.num;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="at" data-activity="1">`
    + `<title id="at">What I do on GitHub, my last year the way GitHub counts it: ${KINDS.map(({ key }) => `${key.toLowerCase()} ${pcts[key]}%`).join(', ')}</title>`
    + `<defs><style>${fontFace(fontB64)}`
    + `.pc{${font(19)};fill:${numInk}}.kd{${font(11)};fill:${T.label}}.kd2{${font(14)};fill:${T.text}}.pc2{${font(15)};fill:${numInk}}`
    + `.hd{${font(26)};fill:${numInk}}.sub{${font(12)};fill:${T.label}}${twinkleCss}${delays(spots.length)}</style>`
    + `<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.top}"/><stop offset="1" stop-color="${P.bottom}"/></linearGradient>`
    + `<linearGradient id="shape" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P.shape[0]}"/><stop offset="1" stop-color="${P.shape[1]}"/></linearGradient></defs>`
    + `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="url(#panel)" stroke="${T.edge}" stroke-width="1.5"/>`
    + `<g>${rings}${axes}${shape}${dots}${labels}</g><g>${head}${cap}${rows}</g><g>${sparks}</g></svg>\n`;
}

// The API's counts as shares, for a card whose organisation page had no percentages. The API's
// review list came back empty for me (4 Nov) while GitHub's pages show code review, so this shape
// can lack that arm; it is only the fallback, and GitHub's own page is preferred.
function sharesFromCounts(t) {
  const total = t.commits + t.prs + t.issues + t.reviews;
  const share = { 'Code review': t.reviews, Issues: t.issues, 'Pull requests': t.prs, Commits: t.commits };
  return Object.fromEntries(KINDS.map(({ key }) => [key, total ? Math.round((100 * share[key]) / total) : 0]));
}

// WCAG contrast. The card's numbers are text, so each colour is darkened (same hue) until it reads
// at 4.5:1 or better on the card's pinkest background; the border and the shape keep the bright one.
const CARD_BG = '#FFE3F0';
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function ink(hex, bg = CARD_BG, min = 4.5) {
  let c = hex;
  for (let k = 1; contrast(c, bg) < min && k > 0; k -= 0.02) {
    c = '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return c;
}

// One organisation's card: works on GitHub's light and dark pages alike (its own glass background).
// The shape is that organisation's own cross (pcts, from GitHub's page for it, like clicking the
// organisation on my profile); the numbers are the API's counts.
function orgCard(org, t, fontB64, pcts = sharesFromCounts(t)) {
  const W = 220, H = 150, cx = 52, cy = 86, arm = 34;
  const any = KINDS.some(({ key }) => pcts[key] > 0);
  const pts = points(pcts, cx, cy, arm, 4);
  const axes = KINDS.map(({ arm: a }) => `<line x1="${cx}" y1="${cy}" x2="${cx + DIR[a][0] * arm}" y2="${cy + DIR[a][1] * arm}" stroke="#F4C6DD" stroke-width="1.5" stroke-linecap="round"/>`).join('');
  const shape = any ? `<path d="M${pts.map((p) => p.join(' ')).join('L')}Z" fill="${org.colour}" fill-opacity=".45" stroke="${org.colour}" stroke-width="2" stroke-linejoin="round"/>` : '';
  // A dot only where there is something to show: a kind at 0% stays a bare corner of the shape.
  const dots = pts.map(([x, y], i) => (pcts[KINDS[i].key] > 0 ? `<circle cx="${x}" cy="${y}" r="3.5" fill="${KINDS[i].colour}" stroke="#FFFFFF" stroke-width="1.5"/>` : '')).join('');
  // Each line fits between x 104 and the border (room 100): a long count shrinks the line, never spills.
  const line = (y, n, word, cls) => {
    const k = Math.min(1, 100 / (measure(num(n), 17) + 5 + measure(word, 11.5)));
    const sized = k < 1 ? ` style="font-size:${f1(17 * k)}px"` : '';
    return `<text x="104" y="${y}"><tspan class="${cls}"${sized}>${num(n)}</tspan><tspan class="w"${k < 1 ? ` style="font-size:${f1(11.5 * k)}px"` : ''} dx="${f1(5 * k)}">${word}</tspan></text>`;
  };
  const plural = (n, one, many) => (n === 1 ? one : many);
  const lines = line(76, t.prs, plural(t.prs, 'pull request', 'pull requests'), 'n')
    + line(100, t.merged, 'merged', 'g')
    + line(124, t.commits, plural(t.commits, 'commit', 'commits'), 'c');
  const r = rand([...org.login].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  const sparks = [[W - 22, 24, 6], [f1(110 + r() * 80), f1(132 + r() * 8), 4], [f1(18 + r() * 20), f1(130 + r() * 8), 3.5]]
      .map(([x, y, s], i) => sparkle(x, y, s, i ? '#F2C14E' : '#FF5FB0', `sp s${i}`)).join('');
  const label = `${org.name}: ${num(t.prs)} ${plural(t.prs, 'pull request', 'pull requests')}, ${num(t.merged)} merged, ${num(t.commits)} ${plural(t.commits, 'commit', 'commits')} in the last year`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escAttr(label)}" data-org-card="1">`
    + `<defs><style>${fontFace(fontB64)}.o{${font(18)};fill:#4A0830}.n{${font(17)};fill:${ink(org.colour)}}.g{${font(17)};fill:${ink('#B8860B')}}.c{${font(17)};fill:#6B0F45}.w{${font(11.5)};fill:#6B0F45}${twinkleCss}${delays(3)}</style>`
    + `<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFE3F0"/></linearGradient></defs>`
    + `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="22" fill="url(#g)" stroke="${org.colour}" stroke-width="3"/>`
    + `<rect x="10" y="8" width="${W - 20}" height="10" rx="5" fill="#FFFFFF" fill-opacity=".8"/>`
    + `<text class="o" x="18" y="38">${esc(org.name)}</text>`
    + `<g>${axes}${shape}${dots}</g><g>${lines}</g><g>${sparks}</g></svg>\n`;
}

// ---------- keeping the last good pictures ----------

const whole = (mark) => (text) => /^<svg\b/.test(text) && text.includes(mark) && /<\/svg>\s*$/.test(text);
const isOverview = whole('data-activity="1"');
const isCard = whole('data-org-card="1"');
const looksRight = (name, text) => (name.startsWith('orgs/') ? isCard(text) : isOverview(text));

function lastIsTrusted(last) {
  return Boolean(last) && fs.existsSync(last) && (process.env.LAST_OK ? process.env.LAST_OK === 'true' : fs.existsSync(path.join(last, '.git')));
}

async function keepOne(name, dist, last) {
  try {
    const to = path.join(dist, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (lastIsTrusted(last)) {
      const from = path.join(last, name);
      if (fs.existsSync(from) && looksRight(name, fs.readFileSync(from, 'utf8'))) { fs.copyFileSync(from, to); return true; }
      return false;
    }
    const r = await get(`https://raw.githubusercontent.com/${REPO}/output/${name}`, { 'User-Agent': `${USER}-profile-snake` });
    const text = r.ok ? await r.text() : '';
    if (looksRight(name, text)) { fs.writeFileSync(to, text); return true; }
  } catch { /* reported by the caller as not kept */ }
  return false;
}

// All at once, so ten fetches (when the checkout failed) take one request's time, not ten.
async function keepLastGood(dist, last, { onlyMissing = false, names = FILES } = {}) {
  const todo = names.filter((name) => {
    const at = path.join(dist, name);
    return !(onlyMissing && fs.existsSync(at) && looksRight(name, fs.readFileSync(at, 'utf8')));
  });
  const done = await Promise.all(todo.map((name) => keepOne(name, dist, last)));
  return todo.filter((_, i) => done[i]);
}

// ---------- the run ----------

// My contributions page, or one organisation's view of it (what clicking that organisation on my
// profile shows). frame.js caches the parsed page, not its HTML, so this reads it again.
async function readPageHtml(org) {
  const r = await get(`https://github.com/users/${USER}/contributions${org ? `?org=${encodeURIComponent(org)}` : ''}`, { 'User-Agent': `${USER}-profile-snake` });
  if (!r.ok) throw new Error(`the contributions page${org ? ` for ${org}` : ''} answered ${r.status}`);
  return r.text();
}

// One organisation's own cross, or null if its page can't be read or has none (the card then falls
// back to the API's shares, and the run says so).
// A page that can't be READ (a throttle, a timeout) is tried once more and then fails the cards half,
// so the last good cards stay up rather than quietly losing their code-review arm. A page that reads
// but has no cross is a real answer (null), and that card falls back to the API's shares.
async function orgShares(login) {
  try { return parseOverview(await readPageHtml(login)); } catch {
    await new Promise((ok) => setTimeout(ok, PAGE_RETRY_MS));
    return parseOverview(await readPageHtml(login));
  }
}
const PAGE_RETRY_MS = Number(process.env.ACTIVITY_PAGE_RETRY_MS || 3000);   // tests set it to 0

// Two at a time, not all nine at once: github.com throttles bursts of pages without a token.
async function inPairs(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += 2) out.push(...(await Promise.all(items.slice(i, i + 2).map(fn))));
  return out;
}

// The two halves, each drawn whole or not at all: the cross (from the page) and the cards (from the API).
async function drawOverview(fontB64, art) {
  // The same one retry the organisation pages get.
  let html;
  try { html = await readPageHtml(); } catch { await new Promise((ok) => setTimeout(ok, PAGE_RETRY_MS)); html = await readPageHtml(); }
  const pcts = parseOverview(html);
  if (!pcts) throw new Error('no activity overview on the contributions page (is it turned on in my settings?)');
  return { files: OVERVIEW.map(({ theme, name }) => [name, overview(pcts, theme, fontB64, art)]), said: KINDS.map(({ key }) => `${key} ${pcts[key]}%`).join(', ') };
}

// A card's counts: its organisation's, plus any it takes in (`also`).
function cardTotals(org, totals) {
  const sum = { commits: 0, prs: 0, merged: 0, issues: 0, reviews: 0 };
  for (const login of [org.login, ...(org.also || [])]) {
    const t = totals[login.toLowerCase()];
    if (t) for (const k of Object.keys(sum)) sum[k] += t[k];
  }
  return sum;
}

async function drawCards(fontB64) {
  // The API's counts beside the organisations' own pages (those two at a time).
  const [collection, shares] = await Promise.all([readCollection(process.env.GITHUB_TOKEN), inPairs(ORGS, (o) => orgShares(o.login))]);
  const totals = orgTotals(collection);
  // GitHub's pages show activity but the API counted nothing for any card: the token can't see her
  // contributions, so every card would read 0. Refuse, and the last good cards stay up.
  const anyCount = ORGS.some((o) => { const t = cardTotals(o, totals); return t.commits + t.prs + t.issues + t.reviews > 0; });
  const anyPage = shares.some((p) => p && KINDS.some(({ key }) => p[key] > 0));
  if (anyPage && !anyCount) throw new Error('the API counted nothing for any organisation while GitHub’s pages show activity (can the token read my contributions?)');
  // An answer with no repositories in any list at all means the token saw none of my contributions
  // (a whole year with none would also read this way; the last good cards then stay up).
  const lists = ['commitContributionsByRepository', 'issueContributionsByRepository', 'pullRequestReviewContributionsByRepository', 'pullRequestContributionsByRepository'];
  if (lists.every((k) => collection[k].length === 0)) throw new Error('the API returned no contributions at all (can the token read my contributions?)');
  // A page with no cross, or one that's all 0% while the API counts something (say, all of Mozilla's
  // was in mozmeao), falls back to the API's shares, so a card with numbers never has an empty cross.
  const fellBack = [];
  const files = ORGS.map((org, i) => {
    const t = cardTotals(org, totals);
    const counted = t.commits + t.prs + t.issues + t.reviews > 0;
    const usable = shares[i] && (KINDS.some(({ key }) => shares[i][key] > 0) || !counted);
    if (!usable) fellBack.push(org.login);
    return [cardName(org.login), orgCard(org, t, fontB64, usable ? shares[i] : undefined)];
  });
  if (fellBack.length) console.log(`::warning::no usable cross on GitHub's page for ${fellBack.join(', ')}; ${fellBack.length === 1 ? 'that card is' : 'those cards are'} shaped from the API's counts`);
  return { files, said: `${ORGS.length} organisation cards` };
}

async function main(dist = process.argv[2], last = process.argv[3]) {
  if (!dist) throw new Error('usage: node activity.js <dist dir> [<last good dir>]');
  const fontB64 = fs.readFileSync(path.join(__dirname, 'fredoka-latin.woff2')).toString('base64');
  const capFile = path.join(__dirname, 'emoji-gradcap.png');
  const art = { cap: fs.existsSync(capFile) ? fs.readFileSync(capFile).toString('base64') : null };
  fs.mkdirSync(path.join(dist, 'orgs'), { recursive: true });
  const halves = [
    ['the cross', OVERVIEW.map((f) => f.name), () => drawOverview(fontB64, art)],
    ['the cards', ORGS.map((o) => cardName(o.login)), () => drawCards(fontB64)],
  ];
  // Side by side: they read different things, so neither waits on the other (or on its put-back).
  const results = await Promise.all(halves.map(async ([what, names, run]) => {
    try {
      const { files, said } = await run();
      for (const [name, svg] of files) fs.writeFileSync(path.join(dist, name), svg);   // the half is drawn whole before any of it is written
      return { said: `${what} drawn: ${said}` };
    } catch (e) {
      const kept = await keepLastGood(dist, last, { names });
      return { problem: `${what}: ${e.message} (last good put back: ${kept.length ? kept.join(', ') : 'none'})` };
    }
  }));
  for (const { said } of results) if (said) console.log(said);
  const problems = results.filter((r) => r.problem).map((r) => r.problem);
  if (problems.length) throw new Error(problems.join('\n'));
}

async function keepMode(dist = process.argv[3], last = process.argv[4]) {
  const kept = await keepLastGood(dist, last, { onlyMissing: true });
  console.log(`last good activity pictures put back: ${kept.length ? kept.join(', ') : 'none'}`);
}

if (require.main === module) {
  const { annotate } = require('./frame.js');
  if (process.argv[2] === '--keep') keepMode().catch((e) => console.error(`::warning::${annotate(e.message)}`));
  else main().catch((e) => { console.error(`::error::${annotate(e.message)}`); process.exit(1); });
}

module.exports = { parseOverview, orgTotals, cardTotals, overview, orgCard, points, ink, contrast, CARD_BG, keepLastGood, keepMode, isOverview, isCard, ORGS, KINDS, FILES, main };
