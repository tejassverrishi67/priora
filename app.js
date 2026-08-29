// app.js — simulation loop + rendering. The only file that touches the DOM.

import { makePatients, stepPatients } from './patients.js';

const wallEl = document.getElementById('wall');
const clockEl = document.getElementById('clock');
const heroNumEl = document.getElementById('heroNum');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');

const TICK_MS = 1000;

const VITALS = [
  { key: 'hr', label: 'HR' },
  { key: 'rr', label: 'RR' },
  { key: 'sbp', label: 'SBP' },
  { key: 'spo2', label: 'SpO₂' },
  { key: 'temp', label: 'Temp' },
];

let patients = makePatients();
let tiles = new Map(); // bed -> { card, valueEls }
let running = true;
let timer = null;

function fmtVital(key, value) {
  return key === 'temp' ? value.toFixed(1) : String(value);
}

function buildTile(p) {
  const card = document.createElement('article');
  card.className = 'tile';

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

  card.append(head, vitals);
  return { card, valueEls };
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

  heroNumEl.textContent = patients.length;
  paintVitals();
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

function tick() {
  stepPatients(patients);
  paintVitals();
  clockEl.textContent = `tick ${patients[0].tick}`;
}

function startLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (running) tick();
  }, TICK_MS);
}

pauseBtn.addEventListener('click', () => {
  running = !running;
  pauseBtn.textContent = running ? 'Pause' : 'Resume';
});

resetBtn.addEventListener('click', () => {
  patients = makePatients();
  renderWall();
  clockEl.textContent = 'tick 0';
});

renderWall();
startLoop();
