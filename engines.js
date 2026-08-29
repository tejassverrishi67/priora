// engines.js — swappable "hospital AI" scorers (the legacy layer).
//
// Each function takes a patient and returns a risk score in [0, 1]. These are
// deliberately crude: fixed population thresholds, no personalization, no idea
// what THIS patient's normal looks like. That is the whole point — this is the
// "before" state that PriorA is built to sit on top of and fix.

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Reproducible pseudo-noise in [0, 1] keyed on integers. Self-contained so each
// engine stays a drop-in unit with no dependency on patients.js internals.
function hash01(a, b, salt) {
  const x = Math.sin(a * 12.9898 + b * 78.233 + salt * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

// --- 1. Epic-style absolute-threshold scorer -----------------------------------
// Weighted points for crossing fixed thresholds on raw vitals, plus a spurious
// per-patient "risk index" the vendor never validated. Chronically abnormal
// patients (beds 3, 9, 18, 22, 27, 35) sit permanently above the alert line even
// though their vitals never move — exactly the false-alarm firehose that buries
// the one patient who is actually crashing.
export function epicStyle(p) {
  let s = 0;

  // Heart rate
  if (p.hr > 110) s += 0.34;
  else if (p.hr > 90) s += 0.22;
  if (p.hr < 50) s += 0.30;

  // Respiratory rate
  if (p.rr >= 25) s += 0.30;
  else if (p.rr >= 21) s += 0.22;
  if (p.rr < 9) s += 0.24;

  // Systolic BP
  if (p.sbp < 90) s += 0.34;
  else if (p.sbp < 100) s += 0.18;
  if (p.sbp > 180) s += 0.20;

  // SpO2
  if (p.spo2 < 91) s += 0.40;
  else if (p.spo2 <= 96) s += 0.18;

  // Temperature
  if (p.temp >= 38.0) s += 0.24;
  else if (p.temp >= 37.5) s += 0.12;
  if (p.temp < 36.0) s += 0.15;

  // Unvalidated vendor "risk index": age band plus a fixed per-bed offset. Pure
  // noise that has nothing to do with how the patient is trending right now, but
  // it still moves people across the alert threshold.
  const ageF = p.age > 78 ? 0.20 : p.age > 66 ? 0.10 : 0;
  const bedBias = hash01(p.bed, 0, 88) * 0.46;
  s += ageF + bedBias;

  return clamp01(s);
}

// --- 2. Simplified NEWS scorer -----------------------------------------------
// Textbook National Early Warning Score: 0–3 points per vital by fixed clinical
// band, summed and normalized. Less trigger-happy than raw thresholds, but still
// a population yardstick with no memory of the individual in front of it.
export function newsScore(p) {
  let pts = 0;

  // Respiratory rate
  if (p.rr <= 8) pts += 3;
  else if (p.rr <= 11) pts += 1;
  else if (p.rr <= 20) pts += 0;
  else if (p.rr <= 24) pts += 2;
  else pts += 3;

  // SpO2
  if (p.spo2 <= 91) pts += 3;
  else if (p.spo2 <= 93) pts += 2;
  else if (p.spo2 <= 95) pts += 1;

  // Systolic BP
  if (p.sbp <= 90) pts += 3;
  else if (p.sbp <= 100) pts += 2;
  else if (p.sbp <= 110) pts += 1;
  else if (p.sbp >= 220) pts += 3;

  // Heart rate
  if (p.hr <= 40) pts += 3;
  else if (p.hr <= 50) pts += 1;
  else if (p.hr <= 90) pts += 0;
  else if (p.hr <= 110) pts += 1;
  else if (p.hr <= 130) pts += 2;
  else pts += 3;

  // Temperature
  if (p.temp <= 35.0) pts += 3;
  else if (p.temp <= 36.0) pts += 1;
  else if (p.temp <= 38.0) pts += 0;
  else if (p.temp <= 39.0) pts += 1;
  else pts += 2;

  // Normalize: ~12 points is a full-blown crash on this scale.
  return clamp01(pts / 12);
}

// --- 3. Broken vendor model ------------------------------------------------
// A black-box "ML" score that is mostly noise with only a faint trace of real
// signal. Flips patients in and out of alert almost every tick. Nobody on the
// unit trusts it; everybody still gets paged by it.
export function brokenModel(p) {
  const noiseTerm = hash01(p.bed, p.tick, 91);      // pure churn, 0–1
  const faintSignal = clamp01((p.hr - 62) / 240);   // barely-there truth
  return clamp01(noiseTerm * 0.85 + faintSignal * 0.15);
}

// Registry so app.js can offer the scorer as a swappable choice.
export const ENGINES = {
  epic: { label: 'Epic-style thresholds', score: epicStyle },
  news: { label: 'NEWS score', score: newsScore },
  broken: { label: 'Vendor ML model', score: brokenModel },
};
