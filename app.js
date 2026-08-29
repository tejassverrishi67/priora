// app.js — simulation loop + rendering. The only file that touches the DOM.

import { makePatients, stepPatients } from './patients.js';
import { ENGINES } from './engines.js';

const wallEl = document.getElementById('wall');
const clockEl = document.getElementById('clock');
const heroNumEl = document.getElementById('heroNum');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const engineSel = document.getElementById('engineSel');

const TICK_MS = 1000;

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
  heroNumEl.textContent = alertsThisShift;
}

function tick() {
  stepPatients(patients);
  evaluateAlerts();
  paintVitals();
  paintAlerts();
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
  renderWall();
  clockEl.textContent = 'tick 0';
}

pauseBtn.addEventListener('click', () => {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
});

resetBtn.addEventListener('click', resetSim);

engineSel.addEventListener('change', () => {
  selectedEngine = engineSel.value;
  // Re-baseline against the new engine's opening set instead of counting the
  // churn from swapping scorers as a flood of fresh alerts.
  alerts = new Map();
  primed = false;
  evaluateAlerts();
  paintAlerts();
});

renderWall();
startLoop();
