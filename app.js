// app.js — simulation loop + rendering. The only file that touches the DOM.

import { makePatients, stepPatients } from './patients.js';
import { ENGINES } from './engines.js';
import {
  rankPatients,
  buildExplanation,
  assignToNurses,
  nurseLabelForBed,
  safetyFloor,
  shouldReescalate,
} from './priora.js';

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
const watchlistNoteEl = document.getElementById('watchlistNote');
const toastStackEl = document.getElementById('toastStack');

const TICK_MS = 1000;

// Collapse-transition timing. One eased breath: priority tiles bloom, the
// rest go quiet, then fold into the watchlist strip.
const EXHALE_MS = 480;
// L4 staffing. Each nurse on shift can hold this many priority patients, so the
// number of PRIORITY tiles is nurseCount * CAPACITY_PER_NURSE — 2, 4, or 6.
// Everyone past that (or below L4's priority floor) is watchlist.
const CAPACITY_PER_NURSE = 2;

// L6. How many ticks of per-bed priority history to keep for re-escalation
// detection, and how long to hold a re-escalating patient's chip glowing in
// the watchlist before it migrates into the assigned queue.
const PRIORITY_TRAIL_CAP = 30;
const ESCALATE_HOLD_MS = 900;
// A patient has to have settled on the watchlist for at least this many ticks
// before a priority climb counts as a re-escalation — otherwise a crasher who
// merely passed through the strip for a tick or two at activation would fire
// the "worsening, escalated" beat on their way to a normal priority slot.
const REESCALATE_MIN_TENURE = 5;

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

// L6 state.
let priorityTrail = new Map();   // bed -> recent L3 priority samples
let forcedBeds = new Set();      // beds L6 pins into the assigned queue for good
let safetyBeds = new Set();      // beds tripping the absolute safety floor right now
let escalatePending = new Set(); // beds mid glow-then-migrate animation
let escalateToasted = new Set(); // beds already announced by a toast this shift
let enteringBeds = new Set();    // beds that should play the entrance animation next render
let prevWatchlistBeds = new Set(); // watchlist membership from the previous render
let watchTenure = new Map();      // bed -> consecutive renders spent on the watchlist

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
      const severe = safetyBeds.has(bed);
      card.hidden = false;
      card.classList.remove('tile--quiet', 'tile--collapsed');
      card.classList.add('tile--priority');
      card.classList.toggle('tile--critical', severe);
      if (enteringBeds.has(bed)) {
        enteringBeds.delete(bed);
        card.classList.remove('tile--enter'); // restart if mid-animation
        void card.offsetWidth;
        card.classList.add('tile--enter');
        card.addEventListener(
          'animationend',
          () => card.classList.remove('tile--enter'),
          { once: true }
        );
      }
      setBadge(tile, rankByBed.get(bed), bedNurse.get(bed), severe);
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
      card.classList.remove('tile--priority', 'tile--expanded', 'tile--critical');
      card.classList.add('tile--quiet');
      card.dataset.prioraRole = 'watch';
    }
  }
}

function setBadge(tile, rank, nurse, severe) {
  let badge = tile.card.querySelector('.rank-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'rank-badge';
    tile.card.append(badge);
  }
  // L6 safety-floor patients get the solid-black badge — categorically
  // distinct from the yellow priority pill.
  badge.classList.toggle('rank-badge--critical', !!severe);
  if (severe) {
    badge.textContent = nurse ? `CRITICAL · Nurse ${nurse}` : 'CRITICAL';
  } else {
    badge.textContent = nurse ? `#${rank} · Nurse ${nurse}` : `#${rank}`;
  }
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
    chip.dataset.bed = row.bed;
    chip.textContent = row.bed;
    // Keep the glow on a chip whose owner is mid re-escalation.
    if (escalatePending.has(row.bed)) chip.classList.add('chip--escalating');
    watchlistEl.append(chip);
  }
}

// L4 + L6: rank the whole unit, split that ranked list across the nurses on
// shift, then let L6 override — safety-floor patients and re-escalated patients
// are pinned into the assigned queue no matter what the ranking said. Returns
// the full ranking, the assigned rows in global rank order, and a bed -> nurse
// map for the priority-tile badges. Also refreshes the module-level
// `safetyBeds` set the badge renderer reads.
function computeAssignment() {
  const ranking = rankPatients(patients, currentScores());

  // Keep a short priority trail per bed for L6 re-escalation detection.
  for (const r of ranking) {
    const trail = priorityTrail.get(r.bed) || [];
    trail.push(r.priority);
    if (trail.length > PRIORITY_TRAIL_CAP) trail.shift();
    priorityTrail.set(r.bed, trail);
  }

  const { assignments } = assignToNurses(ranking, nurseCount, CAPACITY_PER_NURSE);
  const map = new Map();
  const assigned = [];
  for (const a of assignments) {
    for (const row of a.patients) {
      map.set(row.bed, a.nurse);
      assigned.push(row);
    }
  }

  // L6a — absolute safety floor: assigned this tick, ahead of the ranking.
  safetyBeds = new Set();
  for (const r of ranking) {
    if (!safetyFloor(r.patient)) continue;
    safetyBeds.add(r.bed);
    if (!map.has(r.bed)) {
      map.set(r.bed, nurseLabelForBed(r.bed, nurseCount));
      assigned.push(r);
    }
  }

  // L6b — re-escalation: a worsening watchlist patient stays pinned back in.
  for (const bed of forcedBeds) {
    if (map.has(bed)) continue;
    const r = ranking.find((x) => x.bed === bed);
    if (!r) continue;
    map.set(bed, nurseLabelForBed(bed, nurseCount));
    assigned.push(r);
  }

  assigned.sort((x, y) => x.rank - y.rank);
  return { ranking, assigned, bedNurse: map };
}

// "Capacity: 4 patients — 36 on watchlist", tracking the segmented control.
// The count reflects L4 capacity, but if L6 has pinned extra patients past
// that capacity the watchlist number shrinks to stay honest.
function renderAssignCaption(assignedCount) {
  if (!prioraActive) {
    assignCaptionEl.hidden = true;
    return;
  }
  const capacity = nurseCount * CAPACITY_PER_NURSE;
  const effective = Math.max(capacity, assignedCount || 0);
  const onWatch = patients.length - effective;
  assignCaptionEl.textContent =
    `Capacity: ${capacity} patients — ${onWatch} on watchlist`;
  assignCaptionEl.hidden = false;
}

// L6b — scan for a settled watchlist patient whose L3 priority trail has
// turned sharply upward, and give them the re-escalation beat. Runs BEFORE the
// watchlist is rebuilt so the bed can be held out of the queue for one render
// and the chip is there to glow.
function detectEscalations(ranking) {
  for (const r of ranking) {
    const bed = r.bed;
    if (
      forcedBeds.has(bed) ||
      escalatePending.has(bed) ||
      escalateToasted.has(bed)
    ) {
      continue;
    }
    if (!prevWatchlistBeds.has(bed)) continue;
    if ((watchTenure.get(bed) || 0) < REESCALATE_MIN_TENURE) continue;
    if (!shouldReescalate(r.patient, priorityTrail.get(bed))) continue;
    beginEscalation(bed);
  }
}

// The visible beat: for ESCALATE_HOLD_MS the bed stays on the watchlist with a
// glowing chip and a quiet toast fires; then it is pinned into the assigned
// queue for good (forcedBeds — never silently dropped again) and its tile
// plays the entrance animation.
function beginEscalation(bed) {
  escalatePending.add(bed);
  escalateToasted.add(bed);
  showToast(`BED ${bed} — condition worsening, escalated`);
  // buildWatchlist paints .chip--escalating for any bed still in escalatePending.

  window.setTimeout(() => {
    escalatePending.delete(bed);
    forcedBeds.add(bed);
    enteringBeds.add(bed);
    if (prioraActive) renderPrioraState();
  }, ESCALATE_HOLD_MS);
}

// Quiet inline toast: white card, hairline border, small icon, one line.
// Auto-dismisses; never blocks anything.
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';

  const ico = document.createElement('span');
  ico.className = 'toast-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = '▲';

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;

  toast.append(ico, msg);
  toastStackEl.append(toast);

  requestAnimationFrame(() => toast.classList.add('is-visible'));
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 320);
  }, 6000);
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

  // Seed L6 tenure tracking so re-escalation starts measuring from here.
  prevWatchlistBeds = new Set(
    ranking.map((r) => r.bed).filter((b) => !topBeds.includes(b))
  );

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
    watchlistNoteEl.hidden = false;
    renderAssignCaption(topBeds.length);
    renderCompare(ranking);
    requestAnimationFrame(() => {
      watchlistEl.classList.add('is-visible');
      watchlistNoteEl.classList.add('is-visible');
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

  // L6b runs first: it may move a worsening bed into escalatePending, which
  // holds it on the watchlist (glowing) for one beat before it migrates.
  detectEscalations(ranking);

  const topRows = assigned.filter((r) => !escalatePending.has(r.bed));
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
  renderAssignCaption(topBeds.length);
  renderCompare(ranking);
  heroToEl.textContent = topBeds.length;
  watchlistNoteEl.hidden = false;

  // Update watchlist tenure for the next render's re-escalation check.
  const watchNow = new Set(
    ranking.map((r) => r.bed).filter((b) => !topBeds.includes(b))
  );
  for (const b of watchNow) watchTenure.set(b, (watchTenure.get(b) || 0) + 1);
  for (const b of topBeds) watchTenure.set(b, 0);
  prevWatchlistBeds = watchNow;
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
  watchlistNoteEl.hidden = true;
  watchlistNoteEl.classList.remove('is-visible');
  assignCaptionEl.hidden = true;
  assignCaptionEl.textContent = '';

  // L6 state back to zero.
  priorityTrail = new Map();
  forcedBeds = new Set();
  safetyBeds = new Set();
  escalatePending = new Set();
  escalateToasted = new Set();
  enteringBeds = new Set();
  prevWatchlistBeds = new Set();
  watchTenure = new Map();
  toastStackEl.textContent = '';
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
  // A new scorer rescales every priority; wipe the trail so the discontinuity
  // isn't mistaken for a patient deteriorating.
  priorityTrail = new Map();
  evaluateAlerts();
  if (prioraActive) renderPrioraState();
  else paintAlerts();
});

renderWall();
startLoop();
