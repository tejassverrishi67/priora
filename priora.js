// priora.js — PriorA's decision layers. PURE FUNCTIONS ONLY.
//
// Nothing in this file may touch the DOM, read globals, import modules, or use
// randomness. Every export is a deterministic function of its arguments so the
// six layers can be reasoned about in isolation and swapped freely.
//
// Slice 3 ships:
//   L1  personalBaseline(patient)          — drift from the patient's OWN norm
//       velocity(patient)                  — how fast that patient is moving
//   L3  rankPatients(patients, scores)     — one ordering over the whole unit

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
  const history = patient && patient.history ? patient.history : [];
  if (history.length < 2) return 0;

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
