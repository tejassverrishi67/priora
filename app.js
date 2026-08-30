// app.js — simulation loop + rendering. The only file that touches the DOM.

import { makePatients, stepPatients } from './patients.js';
import { ENGINES } from './engines.js';
import { rankPatients, buildExplanation, assignToNurses } from './priora.js';

const wallEl = document.getElementById('wall');
const watchlistEl = document.getElementById('watchlist');
const clockEl = document.getElementById('clock');
const heroEl = document.getElementById('hero');
const heroFromEl = document.getElementById('heroFrom');
const heroToEl = document.getElementById('heroTo');
const heroLabelEl = document.getElementById('heroLabel');
const prioraBtn = document.getElementById('prioraBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const engineSel = document.getElementById('engineSel');
const compareEl = document.getElementById('compare');
const nurseSegEl = document.getElementById('nurseSeg');
const assignCaptionEl = document.getElementById('assignCaption');

const TICK_MS = 1000;

// Collapse-transition timing. One eased breath: priority tiles bloom, the
// rest go quiet, then fold into the watchlist strip.
const EXHALE_MS = 480;
// L4 staffing. Each nurse on shift can hold this many priority patients, so the
// number of PRIORITY tiles is nurseCount * CAPACITY_PER_NURSE — 2, 4, or 6.
// Everyone past that (or below L4's priority floor) is watchlist.
const CAPACITY_PER_NURSE = 2;

// The legacy layer counts alerts from the start of the shift, not just the
// ones lit right now. Seeded so the hero metric opens on a number that already
// feels like a problem the unit has been living with.
const SHIFT_ALERTS_SEED = 25;

const VITALS = [
  { key: 'hr', label: 'HR' },
  { key: 'rr', label: 'RR' },
  { key: 'sbp', label: 'SBP' },
  { key: 'spo2', label: 'SpO₂' },
  { key: 'temp', label: 'Temp' },
];

let patients = makePatients();
let tiles = new Map(); // bed -> { card, valueEls, meta }
let alerts = new Map(); // bed -> { alerting, sinceTick }
let alertsThisShift = SHIFT_ALERTS_SEED;
let selectedEngine = 'epic';
let primed = false; // once true, new alert episodes bump the shift counter
let running = true;
let timer = null;
let prioraActive = false; // flipped by "Activate PriorA"; owns the wall once set
let nurseCount = 1; // L4: nurses on shift, set by the header segmented control
let bedNurse = new Map(); // bed -> nurse letter, from the last L4 assignment

function fmtVital(key, value) {
  return key === 'temp' ? value.toFixed(1) : String(value);
}

function buildTile(p) {
  const card = document.createElement('article');
  card.className = 'tile';

  const dot = document.createElement('span');
  dot.className = 'alert-dot';
  dot.setAttribute('aria-hidden', 'true');

  const head = document.createElement('div');
  head.className = 'tile-head';

  const bed = document.createElement('span');
  bed.className = 'bed';
  bed.textContent = p.bed;

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = p.name;

  head.append(bed, name);

  const vitals = document.createElement('div');
  vitals.className = 'vitals';

  const valueEls = {};
  for (const v of VITALS) {
    const row = document.createElement('div');
    row.className = 'v-row';

    const label = document.createElement('span');
    label.className = 'v-label';
    label.textContent = v.label;

    const val = document.createElement('span');
    val.className = 'v-val';

    row.append(label, val);
    vitals.append(row);
    valueEls[v.key] = val;
  }

  const meta = document.createElement('div');
  meta.className = 'alert-meta';

  card.append(dot, head, vitals, meta);
  return { card, valueEls, meta };
}

function renderWall() {
  wallEl.innerHTML = '';
  tiles = new Map();

  const frag = document.createDocumentFragment();
  for (const p of patients) {
    const tile = buildTile(p);
    tiles.set(p.bed, tile);
    frag.append(tile.card);
  }
  wallEl.append(frag);

  paintVitals();
  evaluateAlerts();
  paintAlerts();
}

function paintVitals() {
  for (const p of patients) {
    const tile = tiles.get(p.bed);
    if (!tile) continue;
    for (const v of VITALS) {
      tile.valueEls[v.key].textContent = fmtVital(v.key, p[v.key]);
    }
  }
}

// Run the selected legacy engine over every patient and fold the result into
// the per-bed alert state. A fresh not-alerting -> alerting transition counts
// as a new alert for the shift, but only once we've primed off the opening
// census (otherwise every chronic bed would inflate the seed on load).
function evaluateAlerts() {
  const score = ENGINES[selectedEngine].score;
  for (const p of patients) {
    const isAlerting = score(p) > 0.5;
    const prev = alerts.get(p.bed);
    if (isAlerting && !(prev && prev.alerting)) {
      // Prime chronic/opening alerts with a plausible age so the meta line
      // doesn't read "0 min" for patients who've been flagged all shift.
      const sinceTick = primed ? p.tick : p.tick - (3 + (p.bed * 5) % 15);
      alerts.set(p.bed, { alerting: true, sinceTick });
      if (primed) alertsThisShift += 1;
    } else if (!isAlerting && prev && prev.alerting) {
      alerts.set(p.bed, { alerting: false, sinceTick: 0 });
    }
  }
  primed = true;
}

function paintAlerts() {
  for (const p of patients) {
    const tile = tiles.get(p.bed);
    if (!tile) continue;
    const a = alerts.get(p.bed);
    const on = !!(a && a.alerting);
    tile.card.classList.toggle('tile--alert', on);
    if (on) {
      const mins = Math.max(1, p.tick - a.sinceTick);
      tile.meta.textContent = `Elevated · ${mins} min`;
    }
  }
  heroFromEl.textContent = alertsThisShift;
}

// ---- PriorA: L3 ranking -> priority tiles + watchlist strip -------------

function currentScores() {
  const score = ENGINES[selectedEngine].score;
  const scores = new Map();
  for (const p of patients) scores.set(p.bed, score(p));
  return scores;
}

// Assign each tile its PriorA role for this ranking. Pure class/badge work —
// no timing, so it's safe to call every tick as the ranking shifts.
function applyRoles(topRows) {
  const rankByBed = new Map(topRows.map((r, i) => [r.bed, i + 1]));
  for (const [bed, tile] of tiles) {
    const card = tile.card;
    card.classList.remove('tile--alert'); // PriorA owns the styling now
    if (rankByBed.has(bed)) {
      card.hidden = false;
      card.classList.remove('tile--quiet', 'tile--collapsed');
      card.classList.add('tile--priority');
      setBadge(tile, rankByBed.get(bed), bedNurse.get(bed));
      setReviewBtn(tile, bed);
      setHandoff(tile, bed);
      bindExpand(tile);
      // Keep the footer controls in a stable order even for a tile that has
      // cycled watch -> priority (its handoff/hint were appended on an earlier
      // pass, so a re-created review button would otherwise land last).
      for (const sel of ['.review-btn', '.handoff', '.expand-hint']) {
        const el = card.querySelector(sel);
        if (el) card.append(el);
      }
      card.dataset.prioraRole = 'priority';
    } else {
      clearBadge(tile);
      clearReviewBtn(tile);
      card.classList.remove('tile--priority', 'tile--expanded');
      card.classList.add('tile--quiet');
      card.dataset.prioraRole = 'watch';
    }
  }
}

function setBadge(tile, rank, nurse) {
  let badge = tile.card.querySelector('.rank-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'rank-badge';
    tile.card.append(badge);
  }
  badge.textContent = nurse ? `#${rank} · Nurse ${nurse}` : `#${rank}`;
}

function clearBadge(tile) {
  const badge = tile.card.querySelector('.rank-badge');
  if (badge) badge.remove();
}

// A minimal "Mark as reviewed" control, rendered only on priority tiles. It
// sets patient.treated = true (the flag rankPatients applies TREATED_DAMPEN to)
// and re-renders, so the dampening is observable rather than dead code.
function setReviewBtn(tile, bed) {
  let btn = tile.card.querySelector('.review-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'review-btn';
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = patients.find((x) => x.bed === bed);
      if (p) {
        const before = rankPatients(patients, currentScores());
        p.treated = true;
        const after = rankPatients(patients, currentScores());
        renderPrioraState();
        const b = before.find((r) => r.bed === bed);
        const a = after.find((r) => r.bed === bed);
        console.log(
          `[PriorA] bed ${bed} marked treated — priority ${b.priority.toFixed(3)} (#${b.rank}) -> ${a.priority.toFixed(3)} (#${a.rank}); new #1 is bed ${after[0].bed}`
        );
      }
    });
    tile.card.append(btn);
  }
  const p = patients.find((x) => x.bed === bed);
  const treated = !!(p && p.treated);
  btn.textContent = treated ? 'Reviewed' : 'Mark as reviewed';
  btn.disabled = treated;
}

function clearReviewBtn(tile) {
  const btn = tile.card.querySelector('.review-btn');
  if (btn) btn.remove();
}

// ---- L5: the handoff -------------------------------------------------------

// Render one buildExplanation() result into `container` as a headline plus a
// stack of tabular change lines. Shared by the priority tiles and the
// side-by-side comparison card so they never drift apart.
function renderHandoff(container, patient) {
  const { headline, lines } = buildExplanation(patient);
  container.textContent = '';

  const h = document.createElement('div');
  h.className = 'handoff-headline';
  h.textContent = headline;
  container.append(h);

  const body = document.createElement('div');
  body.className = 'handoff-body';
  lines.forEach((ln, i) => {
    const row = document.createElement('div');
    row.className =
      'handoff-line' + (i === lines.length - 1 ? ' handoff-line--context' : '');
    row.textContent = ln;
    body.append(row);
  });
  container.append(body);
}

// The collapsible handoff living inside a priority tile. Rebuilt every render
// so the numbers track the sim while the tile stays open.
function setHandoff(tile, bed) {
  const p = patients.find((x) => x.bed === bed);
  if (!p) return;
  let box = tile.card.querySelector('.handoff');
  if (!box) {
    box = document.createElement('div');
    box.className = 'handoff';
    tile.card.append(box);
  }
  renderHandoff(box, p);

  let hint = tile.card.querySelector('.expand-hint');
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'expand-hint';
    tile.card.append(hint);
  }
  hint.textContent = 'Why this order';
}

// One click handler per tile, wired once. Only priority tiles react.
function bindExpand(tile) {
  if (tile.card.dataset.expandBound) return;
  tile.card.dataset.expandBound = '1';
  tile.card.addEventListener('click', () => {
    if (!tile.card.classList.contains('tile--priority')) return;
    tile.card.classList.toggle('tile--expanded');
  });
}

// The teaching card: the legacy one-liner beside PriorA's full handoff for
// whoever is ranked #1 right now.
function renderCompare(ranking) {
  const top = ranking && ranking[0];
  if (!prioraActive || !top) {
    compareEl.hidden = true;
    compareEl.textContent = '';
    return;
  }
  compareEl.hidden = false;
  compareEl.textContent = '';

  const legacyCol = document.createElement('div');
  legacyCol.className = 'compare-col compare-col--legacy';
  const legacyTag = document.createElement('div');
  legacyTag.className = 'compare-tag';
  legacyTag.textContent = 'What most systems show';
  const legacyVal = document.createElement('div');
  legacyVal.className = 'compare-legacy';
  legacyVal.textContent = `Bed ${top.bed} — Risk: ${top.engineScore.toFixed(2)}`;
  legacyCol.append(legacyTag, legacyVal);

  const prioraCol = document.createElement('div');
  prioraCol.className = 'compare-col compare-col--priora';
  const prioraTag = document.createElement('div');
  prioraTag.className = 'compare-tag';
  prioraTag.textContent = 'What PriorA shows';
  const handoff = document.createElement('div');
  handoff.className = 'handoff handoff--static';
  renderHandoff(handoff, top.patient);
  prioraCol.append(prioraTag, handoff);

  compareEl.append(legacyCol, prioraCol);
}

// Put the priority tiles first in the grid so they sit top-left.
function orderPriorityFirst(topBeds) {
  for (let i = topBeds.length - 1; i >= 0; i--) {
    const tile = tiles.get(topBeds[i]);
    if (tile) wallEl.prepend(tile.card);
  }
}

function buildWatchlist(ranking, topBeds) {
  const top = new Set(topBeds);
  watchlistEl.textContent = '';
  const label = document.createElement('span');
  label.className = 'watchlist-label';
  label.textContent = 'Watchlist';
  watchlistEl.append(label);
  for (const row of ranking) {
    if (top.has(row.bed)) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = row.bed;
    watchlistEl.append(chip);
  }
}

// L4: rank the whole unit, then split that ranked list across the nurses on
// shift. Returns the full ranking, the assigned rows in global rank order, and
// a bed -> nurse map for the priority-tile badges.
function computeAssignment() {
  const ranking = rankPatients(patients, currentScores());
  const { assignments } = assignToNurses(ranking, nurseCount, CAPACITY_PER_NURSE);
  const map = new Map();
  const assigned = [];
  for (const a of assignments) {
    for (const row of a.patients) {
      map.set(row.bed, a.nurse);
      assigned.push(row);
    }
  }
  assigned.sort((x, y) => x.rank - y.rank);
  return { ranking, assigned, bedNurse: map };
}

// "Capacity: 4 patients — 36 on watchlist", tracking the segmented control.
function renderAssignCaption() {
  if (!prioraActive) {
    assignCaptionEl.hidden = true;
    return;
  }
  const capacity = nurseCount * CAPACITY_PER_NURSE;
  const onWatch = patients.length - capacity;
  assignCaptionEl.textContent =
    `Capacity: ${capacity} patients — ${onWatch} on watchlist`;
  assignCaptionEl.hidden = false;
}

// The brand reveal. Not a data update — an exhale. Priority tiles bloom,
// the rest go quiet, then fold into the strip; the hero metric resolves
// from "25" to "25 -> 2".
function activatePriora() {
  if (prioraActive) return;
  prioraActive = true;
  prioraBtn.disabled = true;
  prioraBtn.textContent = 'PriorA Active';

  const { ranking, assigned, bedNurse: map } = computeAssignment();
  bedNurse = map;
  const topRows = assigned;
  const topBeds = topRows.map((r) => r.bed);

  wallEl.classList.add('wall--priora');

  // Next frame, so the transition we just enabled actually animates.
  requestAnimationFrame(() => {
    applyRoles(topRows);
    orderPriorityFirst(topBeds);
    renderCompare(ranking); // same snapshot as the tiles, so they agree on #1
  });

  // Hero: reveal the "-> 2" suffix, then swap the label under it.
  heroToEl.textContent = topBeds.length;
  requestAnimationFrame(() => heroEl.classList.add('hero--priora'));
  window.setTimeout(() => {
    heroLabelEl.textContent = 'Alerts · Priorities';
  }, 200);

  // A beat later, the quiet tiles fold and the watchlist breathes in.
  window.setTimeout(() => {
    for (const [bed, tile] of tiles) {
      if (!topBeds.includes(bed)) tile.card.classList.add('tile--collapsed');
    }
    buildWatchlist(ranking, topBeds);
    watchlistEl.hidden = false;
    renderAssignCaption();
    renderCompare(ranking);
    requestAnimationFrame(() => {
      watchlistEl.classList.add('is-visible');
      compareEl.classList.add('is-visible');
    });
  }, 200);

  // Once folded, drop them from layout so the grid closes up cleanly.
  window.setTimeout(() => {
    for (const [bed, tile] of tiles) {
      if (!topBeds.includes(bed)) tile.card.hidden = true;
    }
  }, 200 + EXHALE_MS + 40);
}

// Steady-state re-render once PriorA is live: re-rank and reconcile roles
// without replaying the reveal animation.
function renderPrioraState() {
  const { ranking, assigned, bedNurse: map } = computeAssignment();
  bedNurse = map;
  const topRows = assigned;
  const topBeds = topRows.map((r) => r.bed);

  applyRoles(topRows);
  for (const [bed, tile] of tiles) {
    if (!topBeds.includes(bed)) {
      tile.card.classList.add('tile--collapsed');
      tile.card.hidden = true;
    }
  }
  orderPriorityFirst(topBeds);
  buildWatchlist(ranking, topBeds);
  renderAssignCaption();
  renderCompare(ranking);
  heroToEl.textContent = topBeds.length;
}

function tick() {
  stepPatients(patients);
  evaluateAlerts();
  paintVitals();
  if (prioraActive) renderPrioraState();
  else paintAlerts();
  clockEl.textContent = `tick ${patients[0].tick}`;
}

function startLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (running) tick();
  }, TICK_MS);
}

function resetSim() {
  patients = makePatients();
  alerts = new Map();
  alertsThisShift = SHIFT_ALERTS_SEED;
  primed = false;

  // Tear down PriorA: back to the raw legacy wall.
  prioraActive = false;
  prioraBtn.disabled = false;
  prioraBtn.textContent = 'Activate PriorA';
  wallEl.classList.remove('wall--priora');
  heroEl.classList.remove('hero--priora');
  heroLabelEl.textContent = 'Alerts This Shift';
  heroToEl.textContent = '2';
  watchlistEl.hidden = true;
  watchlistEl.classList.remove('is-visible');
  watchlistEl.textContent = '';
  assignCaptionEl.hidden = true;
  assignCaptionEl.textContent = '';
  compareEl.hidden = true;
  compareEl.classList.remove('is-visible');
  compareEl.textContent = '';

  renderWall(); // rebuilds tiles fresh — no priora classes, badges, or hidden
  clockEl.textContent = 'tick 0';
}

pauseBtn.addEventListener('click', () => {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
});

resetBtn.addEventListener('click', resetSim);

prioraBtn.addEventListener('click', activatePriora);

// L4: nurses-on-shift segmented control. Changing it re-runs assignment and
// re-renders immediately (only visible once PriorA is active).
nurseSegEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.nurse-opt');
  if (!btn) return;
  const n = Number(btn.dataset.n);
  if (!n || n === nurseCount) return;
  nurseCount = n;
  for (const b of nurseSegEl.querySelectorAll('.nurse-opt')) {
    b.classList.toggle('is-active', Number(b.dataset.n) === n);
  }
  if (prioraActive) renderPrioraState();
});

engineSel.addEventListener('change', () => {
  selectedEngine = engineSel.value;
  // Re-baseline against the new engine's opening set instead of counting the
  // churn from swapping scorers as a flood of fresh alerts.
  alerts = new Map();
  primed = false;
  evaluateAlerts();
  if (prioraActive) renderPrioraState();
  else paintAlerts();
});

renderWall();
startLoop();
