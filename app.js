// app.js — simulation loop + rendering. The only file that touches the DOM.

import { makePatients, stepPatients } from './patients.js';
import { ENGINES } from './engines.js';
import { rankPatients } from './priora.js';

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

const TICK_MS = 1000;

// Collapse-transition timing. One eased breath: priority tiles bloom, the
// rest go quiet, then fold into the watchlist strip.
const EXHALE_MS = 480;
// PriorA surfaces the two highest-ranked patients as PRIORITY; everyone else
// is watchlist. Two is a deliberate ceiling — L4 will widen it per nurse on
// shift, but the base reveal always names exactly the top pair.
const PRIORITY_COUNT = 2;

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
      setBadge(tile, rankByBed.get(bed));
      card.dataset.prioraRole = 'priority';
    } else {
      clearBadge(tile);
      card.classList.remove('tile--priority');
      card.classList.add('tile--quiet');
      card.dataset.prioraRole = 'watch';
    }
  }
}

function setBadge(tile, rank) {
  let badge = tile.card.querySelector('.rank-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'rank-badge';
    tile.card.append(badge);
  }
  badge.textContent = `#${rank}`;
}

function clearBadge(tile) {
  const badge = tile.card.querySelector('.rank-badge');
  if (badge) badge.remove();
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

function pickTop(ranking) {
  return ranking.slice(0, PRIORITY_COUNT);
}

// The brand reveal. Not a data update — an exhale. Priority tiles bloom,
// the rest go quiet, then fold into the strip; the hero metric resolves
// from "25" to "25 -> 2".
function activatePriora() {
  if (prioraActive) return;
  prioraActive = true;
  prioraBtn.disabled = true;
  prioraBtn.textContent = 'PriorA Active';

  const ranking = rankPatients(patients, currentScores());
  const topRows = pickTop(ranking);
  const topBeds = topRows.map((r) => r.bed);

  wallEl.classList.add('wall--priora');

  // Next frame, so the transition we just enabled actually animates.
  requestAnimationFrame(() => {
    applyRoles(topRows);
    orderPriorityFirst(topBeds);
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
    requestAnimationFrame(() => watchlistEl.classList.add('is-visible'));
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
  const ranking = rankPatients(patients, currentScores());
  const topRows = pickTop(ranking);
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

  renderWall(); // rebuilds tiles fresh — no priora classes, badges, or hidden
  clockEl.textContent = 'tick 0';
}

pauseBtn.addEventListener('click', () => {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
});

resetBtn.addEventListener('click', resetSim);

prioraBtn.addEventListener('click', activatePriora);

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
