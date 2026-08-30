// priora.js — PriorA's decision layers. PURE FUNCTIONS ONLY.
//
// Nothing in this file may touch the DOM, read globals, import modules, or use
// randomness. Every export is a deterministic function of its arguments so the
// six layers can be reasoned about in isolation and swapped freely.
//
// Shipped so far:
//   L1  personalBaseline(patient)          — drift from the patient's OWN norm
//       velocity(patient)                  — how fast that patient is moving
//   L3  rankPatients(patients, scores)     — one ordering over the whole unit
//   L4  assignToNurses(ranked, nurseCount) — split the ranked list across shift
//   L5  buildExplanation(patient)          — the deltas as a spoken handoff
//   L6  safetyFloor(patient)               — absolute-emergency hard override
//       shouldReescalate(patient, trail)   — a worsening watchlist patient returns
//       isStaleCritical(patient, recent)   — a flat-critical, never-reviewed
//                                            watchlist patient returns

// ---------------------------------------------------------------------------
// Per-vital constants. These describe MEASUREMENT scale, never population
// reference ranges — this layer has no notion of a "normal" heart rate, only
// of how far a patient has moved relative to their own recent history.

// Smallest spread we treat as meaningful. Below this a vital is effectively
// flat, and we must not let a rounding-sized wobble divide its way into a huge
// deviation.
const VITAL_FLOORS = {
  hr: 2,
  rr: 1,
  sbp: 3,
  spo2: 1,
  temp: 0.2,
};

// How many of a patient's most recent history ticks L1 draws its median and
// spread from. The full history array is unbounded and, once a scripted crash
// ramp plateaus, more than half of a late-activated patient's samples can come
// from their POST-crash state — the rolling median then drifts to follow the
// crash and deviation collapses. Bounding L1 to a recent window keeps a
// genuine slow-onset baseline shift meaningful (a real drift still moves the
// window with it) while stopping a patient's own plateau from eventually
// erasing their deviation. Warmup (baselineEstablished) still counts absolute
// history length, not this slice.
const BASELINE_WINDOW = 30;

// Normalized velocity below this is just the sawtooth of integer-rounded
// vitals flipping between two adjacent values over the window — every patient
// carries roughly this much whether or not they are trending. Subtract it so
// a genuinely flat patient reads zero.
const VELOCITY_NOISE_BAND = 0.5;

// Change-per-tick that reads as a strong, unambiguous trend. Used only to put
// the five vitals onto one comparable velocity scale.
const VITAL_TREND_SCALE = {
  hr: 2.0,
  rr: 0.7,
  sbp: 1.2,
  spo2: 0.35,
  temp: 0.05,
};

const VITAL_KEYS = Object.keys(VITAL_FLOORS);

// Ticks of a patient's own history PriorA needs before it will rank them on
// personal evidence. Below this the rolling median and spread are estimated
// from too few samples to trust, and the ONLY term that can be non-zero
// without personal history is the engine score — precisely the raw signal
// PriorA exists to distrust. So an un-established patient is parked at the
// bottom of the order rather than promoted by an unchecked engine score.
// Every patient in the sim warms up together, so this only shapes the first
// few seconds after load; by the time any scripted crash develops, everyone
// is established and the ranking is the pure L3 formula.
const BASELINE_WARMUP_TICKS = 10;

// The first MAD-width of movement away from a patient's own median is that
// patient's ordinary minute-to-minute wobble, not deterioration. Only the
// excursion BEYOND it is signal. Without this dead-band a permanently
// abnormal but stable patient still reads ~0.5-1.0 deviation just from
// noise, and that is enough for a high engine score to float them into the
// priority slots — the exact false alarm PriorA is here to suppress.
const DEVIATION_NOISE_BAND = 1.0;

// ---- small robust-statistics helpers -----------------------------------

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Median absolute deviation: median(|x - median(x)|). A robust spread estimate
// that a single crashing sample cannot inflate the way variance would.
function medianAbsDev(nums, mid) {
  if (nums.length === 0) return 0;
  return median(nums.map((x) => Math.abs(x - mid)));
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// ---------------------------------------------------------------------------
// L1 — PERSONAL BASELINE
//
//   deviation(vital) = |current - own_median| / max(own_spread, floor)
//   personalBaseline = max deviation across all vitals
//
// CRITICAL: this reads patient.history DIRECTLY and is never handed an engine
// score. That independence is the entire point of the design — a chronically
// abnormal but *stable* patient sits right on their own median and scores ~0,
// while a patient sliding away from their own norm lights up even when the
// engine is blind or the population thresholds still call them "fine".
export function personalBaseline(patient) {
  const fullHistory = patient && patient.history ? patient.history : [];
  if (fullHistory.length < 2) return 0;

  // Median/spread come from a bounded recent window; `current` is still the
  // newest sample (the last element of that window).
  const history = fullHistory.slice(-BASELINE_WINDOW);
  const current = history[history.length - 1];
  let maxDeviation = 0;

  for (const key of VITAL_KEYS) {
    const series = history.map((h) => h[key]);
    const mid = median(series);
    const spread = medianAbsDev(series, mid);
    const denom = Math.max(spread, VITAL_FLOORS[key]);
    const raw = Math.abs(current[key] - mid) / denom;
    const deviation = Math.max(0, raw - DEVIATION_NOISE_BAND);
    if (deviation > maxDeviation) maxDeviation = deviation;
  }

  return maxDeviation;
}

// True once the patient has enough of their own history for L1's median and
// spread to mean something. Exported so L3 (and later layers) share one rule.
export function baselineEstablished(patient) {
  const history = patient && patient.history ? patient.history : [];
  return history.length >= BASELINE_WARMUP_TICKS;
}

// ---------------------------------------------------------------------------
// VELOCITY — rate of change over roughly the last `window` ticks, put on the
// same normalized scale for every vital and returned as the max magnitude
// across vitals. A steep move in ANY single vital is enough to raise the flag.
export function velocity(patient, window = 10) {
  const history = patient && patient.history ? patient.history : [];
  if (history.length < 2) return 0;

  const current = history[history.length - 1];
  const past = history[Math.max(0, history.length - 1 - window)];
  const span = current.tick - past.tick;
  if (span <= 0) return 0;

  let maxRate = 0;
  for (const key of VITAL_KEYS) {
    const perTick = Math.abs(current[key] - past[key]) / span;
    const rate = perTick / VITAL_TREND_SCALE[key];
    if (rate > maxRate) maxRate = rate;
  }
  return Math.max(0, maxRate - VELOCITY_NOISE_BAND);
}

// ---------------------------------------------------------------------------
// L3 — CROSS-PATIENT RANKING
//
// ONE ordering over the whole unit. Every patient is scored on the same three
// terms and sorted; NOTHING is dropped here. Cutting the list down to "the top
// N" is a rendering decision app.js makes later — the logic layer always hands
// back the full array so the watchlist underneath stays real.
//
//   priority = engineScore*0.30 + deviation*0.45 + velocity*0.25
//
// A patient already being treated is downweighted (*0.3) so a known, handled
// crash does not keep pinning the top slot away from the next person to see.
const W_ENGINE = 0.3;
const W_DEVIATION = 0.45;
const W_VELOCITY = 0.25;
const TREATED_DAMPEN = 0.3;

// The engine score is the one input that can be high for a patient whose own
// vitals have not moved — a chronically abnormal patient the population
// thresholds have flagged all shift. PriorA does not pass that straight
// through: the engine term only carries weight to the extent the patient's
// OWN history corroborates it. Full trust once deviation reaches ~0.75 or
// velocity ~0.5; near zero when neither has. This is the mechanism behind the
// invariant that beds 3/9/18/22/27/35 never reach the priority slots.
const DEVIATION_FULL_TRUST = 0.75;
const VELOCITY_FULL_TRUST = 0.5;

export function rankPatients(patients, engineScores) {
  const scoreFor = makeScoreLookup(engineScores);

  const rows = (patients || []).map((patient) => {
    const engineScore = clamp01(Number(scoreFor(patient)) || 0);
    const deviation = personalBaseline(patient);
    const vel = velocity(patient);
    const treated = !!patient.treated;
    const established = baselineEstablished(patient);

    const corroboration = clamp01(
      deviation / DEVIATION_FULL_TRUST + vel / VELOCITY_FULL_TRUST
    );

    let priority =
      engineScore * W_ENGINE * corroboration +
      deviation * W_DEVIATION +
      vel * W_VELOCITY;
    if (treated) priority *= TREATED_DAMPEN;
    // No personal baseline yet => not rankable on merit. Park below everyone
    // who is, so a lone engine score can never buy a top slot.
    if (!established) priority = -1;

    return {
      bed: patient.bed,
      patient,
      engineScore,
      deviation,
      velocity: vel,
      treated,
      established,
      priority,
      rank: 0,
    };
  });

  // Descending priority; bed number as a stable, deterministic tiebreak.
  rows.sort((a, b) => b.priority - a.priority || a.bed - b.bed);
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// L4 — STAFF ASSIGNMENT
//
// Take L3's single ordering and hand it to the nurses actually on shift. Each
// nurse owns a contiguous bed range; we walk the ranked list from the top and
// drop each patient on the nurse who covers their bed, until that nurse is
// full. Everyone left over — whether their nurse ran out of room or their
// priority never justified a visit — falls to one shared watchlist.
//
// The staffing dial changes DEPTH, never BREADTH: a second or third nurse lets
// PriorA reach further down the ranked list, but a low-priority patient is
// never promoted just because there is now a spare pair of hands. That gate is
// MEANINGFUL_PRIORITY below — without it, extra capacity would rope in the
// stable and chronically-abnormal patients that L3 has already flattened to a
// ~0 priority, which is exactly the false-alarm spread this layer must not do.

// Contiguous bed ranges [firstBed, lastBed] each nurse covers, keyed by how
// many nurses are on shift. Ranges tile the whole 40-bed unit with no gaps or
// overlap so every patient maps to exactly one nurse.
const BED_RANGES = {
  1: [[1, 40]],
  2: [[1, 20], [21, 40]],
  3: [[1, 13], [14, 27], [28, 40]],
};

const NURSE_LABELS = ['A', 'B', 'C'];

// L3 flattens stable and chronically-abnormal patients to a priority at or near
// zero. A genuinely deteriorating patient clears this comfortably (deviation
// and velocity both sit well above their noise bands by the time they matter).
// Anything below it is noise-floor and stays on the watchlist no matter how
// many nurses are free.
const MEANINGFUL_PRIORITY = 0.05;

// assignToNurses(rankedPatients, nurseCount, capacityPerNurse = 2)
//   -> { assignments: [{ nurse, patients: [] }], watchlist: [] }
//
// `rankedPatients` is the array rankPatients() returns (already sorted, each row
// carrying `.bed` and `.priority`). Rows are passed through untouched into
// either a nurse bucket or the watchlist, preserving rank order.
export function assignToNurses(rankedPatients, nurseCount, capacityPerNurse = 2) {
  const n = Math.max(1, Math.min(3, Math.round(Number(nurseCount) || 1)));
  const cap = Math.max(0, Math.round(Number(capacityPerNurse) || 0));
  const ranges = BED_RANGES[n];

  const assignments = ranges.map((range, i) => ({
    nurse: NURSE_LABELS[i],
    range,
    patients: [],
  }));
  const watchlist = [];

  const nurseForBed = (bed) => {
    for (const a of assignments) {
      if (bed >= a.range[0] && bed <= a.range[1]) return a;
    }
    return null;
  };

  for (const row of rankedPatients || []) {
    const worthAVisit = row && row.priority >= MEANINGFUL_PRIORITY;
    const nurse = worthAVisit ? nurseForBed(row.bed) : null;
    if (nurse && nurse.patients.length < cap) {
      nurse.patients.push(row);
    } else {
      watchlist.push(row);
    }
  }

  return {
    assignments: assignments.map((a) => ({ nurse: a.nurse, patients: a.patients })),
    watchlist,
  };
}

// Which nurse letter covers `bed` at a given staffing level. Exported so
// callers that inject a patient outside the normal L4 walk (an L6 safety
// override, a re-escalation) can still label the tile with the right nurse.
export function nurseLabelForBed(bed, nurseCount) {
  const n = Math.max(1, Math.min(3, Math.round(Number(nurseCount) || 1)));
  const ranges = BED_RANGES[n];
  for (let i = 0; i < ranges.length; i++) {
    if (bed >= ranges[i][0] && bed <= ranges[i][1]) return NURSE_LABELS[i];
  }
  return NURSE_LABELS[0];
}

// ---------------------------------------------------------------------------
// L6 — SAFETY
//
// The floor under the whole stack. L1–L4 are about ATTENTION ECONOMY — who is
// worth a nurse's scarce time. L6 is about the two or three numbers that mean
// "this person may be dead in minutes" no matter how the ranking math shook
// out. It does two things:
//
//   safetyFloor(patient)      — a hard population threshold. If a raw vital is
//                               past it, the patient is assigned THIS tick,
//                               ahead of the ranking, at the most severe
//                               visual treatment in the system. No
//                               personalization, no corroboration — that is
//                               the point of a floor.
//
//   shouldReescalate(p, trail) — a patient can be correctly watchlisted now and
//                               genuinely deteriorating. If their L3 priority
//                               has climbed sharply over the last several
//                               ticks, they are pulled back into the assigned
//                               queue automatically. Nothing is ever deleted;
//                               anyone who worsens returns.

// Absolute-emergency thresholds on RAW vitals. Crossing any one is sufficient.
// These are deliberately extreme — well past the engine's alert line — so the
// floor stays rare and unambiguous.
const SAFETY_SPO2_MIN = 88;
const SAFETY_SBP_MIN = 80;
const SAFETY_HR_MAX = 140;

export function safetyFloor(patient) {
  if (!patient) return false;
  // Read the freshest raw sample directly, exactly like L1 — never a score.
  const v =
    patient.history && patient.history.length
      ? patient.history[patient.history.length - 1]
      : patient;
  return (
    v.spo2 < SAFETY_SPO2_MIN || v.sbp < SAFETY_SBP_MIN || v.hr > SAFETY_HR_MAX
  );
}

// How many recent priority samples define "recent" for re-escalation, and how
// much total rise across that span counts as "sharp". REESCALATE_FLOOR keeps a
// patient still sitting in the noise (priority ~0) from re-escalating on a
// rounding wobble — the climb has to be heading somewhere real.
const REESCALATE_WINDOW = 10;
const REESCALATE_RISE = 0.15;
const REESCALATE_FLOOR = 0.05;

// priorityTrail is the caller's array of this patient's recent L3 priority
// values, oldest-to-newest (app.js keeps one per bed).
export function shouldReescalate(patient, priorityTrail) {
  const trail = Array.isArray(priorityTrail)
    ? priorityTrail.slice(-REESCALATE_WINDOW)
    : [];
  if (trail.length < 4) return false;

  const current = trail[trail.length - 1];
  const earliest = trail[0];
  if (current < REESCALATE_FLOOR) return false;
  return current - earliest >= REESCALATE_RISE;
}

// --- L6c — STALENESS ESCALATION -------------------------------------------
//
// shouldReescalate() catches a watchlist patient who is getting WORSE. This
// catches the opposite failure: a patient who was genuinely critical, never
// got better, never got seen, and whose L1 deviation has since decayed to ~0
// simply because their own plateau filled the trailing baseline window. By the
// time that happens their priority is gone, so there is nothing for L3/L4 or
// shouldReescalate() to hold onto — they just quietly fall off.
//
// The judgement here is deliberately NOT personalized: it compares the
// patient's CURRENT raw vitals against a coarse "this is not normal for
// anyone" population band, because L1's personal, trailing view is exactly
// what stopped tracking them. Crossing two or more bands is "still clearly
// critical". None of L1/L3's constants are touched — these are L6's own.
const STALE_HR_HIGH = 125;
const STALE_HR_LOW = 45;
const STALE_RR_HIGH = 28;
const STALE_SBP_LOW = 90;
const STALE_SPO2_LOW = 91;
const STALE_TEMP_HIGH = 38.6;
const STALE_BANDS_REQUIRED = 2;

function populationAbnormalBands(v) {
  let n = 0;
  if (v.hr > STALE_HR_HIGH || v.hr < STALE_HR_LOW) n += 1;
  if (v.rr > STALE_RR_HIGH) n += 1;
  if (v.sbp < STALE_SBP_LOW) n += 1;
  if (v.spo2 < STALE_SPO2_LOW) n += 1;
  if (v.temp > STALE_TEMP_HIGH) n += 1;
  return n;
}

// isStaleCritical(patient, wasAssignedRecently) — true when ALL of:
//   1. their CURRENT vitals still clearly breach a population "abnormal for
//      anyone" band (>= STALE_BANDS_REQUIRED bands), i.e. they were a real
//      critical patient and still are — not decayed-baseline noise;
//   2. patient.treated is not set — nobody has actually reviewed them;
//   3. they have NOT been assigned recently — the caller passes
//      wasAssignedRecently=false once the patient has sat on the watchlist
//      past its grace/tenure threshold. While they were assigned (or only
//      just dropped) this stays true and the check is suppressed.
export function isStaleCritical(patient, wasAssignedRecently) {
  if (!patient || wasAssignedRecently) return false;
  if (patient.treated) return false;
  const v =
    patient.history && patient.history.length
      ? patient.history[patient.history.length - 1]
      : patient;
  return populationAbnormalBands(v) >= STALE_BANDS_REQUIRED;
}

// ---------------------------------------------------------------------------
// L5 — EXPLANATION
//
// Turn the deltas L1 already computed into a colleague-style handoff: which
// vitals moved, from what to what, over how long, and whether that is new for
// THIS patient. This layer emits sentences, never a score — the number is
// exactly what the nurse has already learned to ignore.

// The sim ticks once a second, but a nurse reasons about a vitals feed on the
// order of minutes. Three clinical minutes per tick puts Bed 12's ~30-tick
// slide at a familiar "over 90 min".
const MIN_PER_TICK = 3;

// Per-vital deviation (in units of that vital's own spread) above which a
// vital earns a line in the handoff. Deliberately higher than L1's
// DEVIATION_NOISE_BAND: L1 needs a hair-trigger to rank, but the note should
// only name the vitals that actually carry the story.
const EXPLAIN_DEVIATION_GATE = 2.0;

// How the five vital keys read in prose.
const VITAL_LABELS = {
  hr: 'Heart rate',
  rr: 'Respiratory rate',
  sbp: 'Systolic BP',
  spo2: 'SpO2',
  temp: 'Temp',
};

// Column widths for the tabular layout of a change line. Chosen so the arrow
// and the numbers stack vertically the way a financial statement aligns.
const LABEL_COL = 21;
const CHANGE_COL = 11;

function fmtVital(key, value) {
  return key === 'temp' ? Number(value).toFixed(1) : String(Math.round(value));
}

// The patient's own earliest, pre-event stretch of history. L1 deliberately
// rides a TRAILING window so a long plateau eventually stops reading as an
// event; the handoff does the opposite — it always narrates the move away
// from where this patient actually started, however long ago that was.
const EXPLAIN_BASELINE_TICKS = 12;

// "Respiratory rate     16 → 31    over 90 min"
// Uses the real U+2192 arrow, and always frames the number as a movement —
// never a bare current reading.
function explanationLine(key, from, to, duration) {
  const label = (VITAL_LABELS[key] || key).padEnd(LABEL_COL);
  let change = `${fmtVital(key, from)} → ${fmtVital(key, to)}`;
  if (duration) change = change.padEnd(CHANGE_COL) + '   ' + duration;
  return label + change;
}

// Round a tick span to a plausible clinical duration, phrased in minutes.
function clinicalDuration(ticks) {
  const mins = Math.max(15, Math.round((ticks * MIN_PER_TICK) / 15) * 15);
  return `over ${mins} min`;
}

// The closing line every handoff ends on: whether the movement above is new
// for this patient, and whether anyone has looked yet. A chronically abnormal
// patient sits on their own median, so nothing clears the gate above and this
// line carries the whole message — "this is their baseline, not an event".
function normalityLine(patient) {
  const chronic = patient && patient.archetype === 'chronic-stable';
  const context = chronic
    ? 'Chronically elevated — this is their baseline'
    : 'Normally stable';
  const review = patient && patient.treated ? 'Reviewed.' : 'Not yet reviewed.';
  return `${context}. ${review}`;
}

// buildExplanation(patient) -> { headline, lines: string[] }
//
// Every number in the output is read straight from patient.history and the
// same median/spread machinery L1 uses. No engine score is consulted.
export function buildExplanation(patient) {
  const bed = patient ? patient.bed : '—';
  const headline = `BED ${bed} — Review now`;

  const history = patient && patient.history ? patient.history : [];
  if (history.length < 4) {
    return { headline, lines: [normalityLine(patient)] };
  }

  const current = history[history.length - 1];
  const refLen = Math.max(3, Math.min(EXPLAIN_BASELINE_TICKS, history.length >> 1));
  const ref = history.slice(0, refLen);

  const moved = [];
  for (const key of VITAL_KEYS) {
    const series = ref.map((h) => h[key]);
    const mid = median(series);
    const spread = medianAbsDev(series, mid);
    const denom = Math.max(spread, VITAL_FLOORS[key]);
    const deviation = Math.abs(current[key] - mid) / denom - DEVIATION_NOISE_BAND;
    if (deviation > EXPLAIN_DEVIATION_GATE) {
      moved.push({ key, deviation, denom, mid, from: mid, to: current[key] });
    }
  }
  moved.sort((a, b) => b.deviation - a.deviation);

  // The single duration annotation rides the lead vital: how long ago it
  // first broke clearly out of its reference band.
  let duration = '';
  if (moved.length) {
    const lead = moved[0];
    let onsetTick = current.tick;
    for (const h of history) {
      const d = Math.abs(h[lead.key] - lead.mid) / lead.denom - DEVIATION_NOISE_BAND;
      if (d > EXPLAIN_DEVIATION_GATE * 0.5) {
        onsetTick = h.tick;
        break;
      }
    }
    duration = clinicalDuration(Math.max(1, current.tick - onsetTick));
  }

  const lines = moved.map((m, i) =>
    explanationLine(m.key, m.from, m.to, i === 0 ? duration : '')
  );
  lines.push(normalityLine(patient));

  return { headline, lines };
}

// Accept engine scores as a function(patient), a Map keyed by bed, or a plain
// object keyed by bed — whichever the caller finds convenient.
function makeScoreLookup(engineScores) {
  if (typeof engineScores === 'function') return engineScores;
  if (engineScores instanceof Map) return (p) => engineScores.get(p.bed);
  if (engineScores && typeof engineScores === 'object') {
    return (p) => engineScores[p.bed];
  }
  return () => 0;
}
