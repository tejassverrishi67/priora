// patients.js — synthetic ICU census + scripted trajectories.
// Pure data module: no DOM, no randomness that isn't reproducible.

const HERO_BED = 12;          // slow crasher
const FAST_BED = 31;          // fast crasher
const RESURRECTION_BED = 7;   // late deteriorator
const CHRONIC_BEDS = [3, 9, 18, 22, 27, 35]; // alarming-looking, genuinely fine

const HISTORY_CAP = 120;

const NAMES = [
  'Ada Whitfield', 'Marcus Bell', 'Priya Raman', 'Thomas Okafor', 'Lena Vasquez',
  'Harold Kim', 'Grace Donnelly', 'Omar Haddad', 'Rosa Linden', 'Charles Pane',
  'Nadia Frost', 'Evelyn Cho', 'Samuel Ortiz', 'Bianca Reyes', 'Dev Patel',
  'Iris Kovac', 'Wesley Grant', 'Marta Silva', 'Julian Ross', 'Anna Beaumont',
  'Kofi Mensah', 'Deborah Wills', 'Elias Bauer', 'Nina Achebe', 'Roy Sandoval',
  'Petra Nowak', 'George Hale', 'Sofia Marino', 'Aaron Levine', 'Claire Fontaine',
  'Victor Hensley', 'Maya Iqbal', 'Leon Carter', 'Ruth Palmer', 'Hugo Vance',
  'Tanya Brooks', 'Neil Ashford', 'Carmen Diaz', 'Patrick Lowe', 'Selina Yates',
];

// ---- small deterministic helpers -------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Fraction of the way through a ramp that starts at `start` and lasts `dur` ticks.
function ramp(tick, start, dur) {
  return clamp01((tick - start) / dur);
}

// Reproducible pseudo-noise in [-1, 1] keyed on (bed, tick, salt).
function noise(bed, tick, salt) {
  const x = Math.sin(bed * 12.9898 + tick * 78.233 + salt * 37.719) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// Gentle natural wobble: two frequencies mixed so it doesn't look like a sine.
function wobble(bed, tick, amp) {
  return (noise(bed, tick * 0.7, 1) * 0.6 + noise(bed, tick * 0.29, 2) * 0.4) * amp;
}

function archetypeFor(bed) {
  if (bed === HERO_BED) return 'slow-crasher';
  if (bed === FAST_BED) return 'fast-crasher';
  if (bed === RESURRECTION_BED) return 'resurrection';
  if (CHRONIC_BEDS.includes(bed)) return 'chronic-stable';
  return 'stable';
}

// Per-bed resting vitals for the non-scripted archetypes. Pure function of bed.
function baselineFor(bed, archetype) {
  if (archetype === 'chronic-stable') {
    return {
      hr: 100 + Math.round(Math.abs(noise(bed, 0, 3)) * 12), // 100–112, permanently high
      rr: 22 + (bed % 3),                                     // 22–24
      sbp: 120 + Math.round(noise(bed, 0, 4) * 8),            // wide-normal
      spo2: 95 + (bed % 2),                                   // 95–96
      temp: 37.0 + Math.abs(noise(bed, 0, 5)) * 0.4,          // 37.0–37.4, low-grade
    };
  }
  // ordinary stable patient
  return {
    hr: 68 + Math.round(noise(bed, 0, 3) * 6),
    rr: 15 + (bed % 3),
    sbp: 118 + Math.round(noise(bed, 0, 4) * 8),
    spo2: 97 + (bed % 2),
    temp: 36.7 + noise(bed, 0, 5) * 0.2,
  };
}

// ---- trajectory ----------------------------------------------------------

// Compute a patient's vitals for their current `tick`.
function computeVitals(p) {
  const t = p.tick;
  let v;

  switch (p.archetype) {
    case 'slow-crasher': {
      // Rock stable, then a long quiet slide starting at tick 20.
      const k = ramp(t, 20, 30);
      v = {
        hr: lerp(62, 130, k),
        rr: lerp(16, 34, k),
        sbp: lerp(118, 85, k),
        spo2: lerp(98, 89, k),
        temp: lerp(36.8, 38.4, k),
      };
      break;
    }
    case 'fast-crasher': {
      // Fine until tick 45, then a steep 15-tick collapse.
      const k = ramp(t, 45, 15);
      v = {
        hr: lerp(74, 140, k),
        rr: lerp(15, 32, k),
        sbp: lerp(122, 80, k),
        spo2: lerp(97, 86, k),
        temp: lerp(36.7, 38.8, k),
      };
      break;
    }
    case 'resurrection': {
      // Mildly abnormal and level, then worsens from tick 70.
      const k = ramp(t, 70, 20);
      v = {
        hr: lerp(92, 125, k),
        rr: lerp(20, 30, k),
        sbp: lerp(108, 88, k),
        spo2: lerp(95, 88, k),
        temp: lerp(37.3, 38.5, k),
      };
      break;
    }
    default:
      // stable + chronic-stable: hold the per-bed baseline.
      v = baselineFor(p.bed, p.archetype);
  }

  // Natural minute-to-minute wobble. Chronic patients "barely move".
  const amp = p.archetype === 'chronic-stable' ? 0.5 : 1;
  v.hr = Math.round(v.hr + wobble(p.bed, t, 1.4 * amp));
  v.rr = Math.round(v.rr + wobble(p.bed, t + 11, 0.7 * amp));
  v.sbp = Math.round(v.sbp + wobble(p.bed, t + 23, 1.8 * amp));
  v.spo2 = Math.min(100, Math.round(v.spo2 + wobble(p.bed, t + 37, 0.5 * amp)));
  v.temp = Math.round((v.temp + wobble(p.bed, t + 51, 0.08)) * 10) / 10;
  return v;
}

// ---- public API --------------------------------------------------------

export function makePatients() {
  const patients = [];
  for (let i = 0; i < 40; i++) {
    const bed = i + 1;
    const archetype = archetypeFor(bed);
    const p = {
      bed,
      name: NAMES[i],
      age: 40 + Math.floor(Math.abs(noise(bed, 0, 9)) * 50), // 40–90
      hr: 0,
      rr: 0,
      sbp: 0,
      spo2: 0,
      temp: 0,
      history: [],
      tick: 0,
      treated: false,
      archetype,
    };
    Object.assign(p, computeVitals(p));
    patients.push(p);
  }
  return patients;
}

export function stepPatients(patients) {
  for (const p of patients) {
    p.tick += 1;
    const v = computeVitals(p);
    p.hr = v.hr;
    p.rr = v.rr;
    p.sbp = v.sbp;
    p.spo2 = v.spo2;
    p.temp = v.temp;
    p.history.push({
      tick: p.tick,
      hr: v.hr,
      rr: v.rr,
      sbp: v.sbp,
      spo2: v.spo2,
      temp: v.temp,
    });
    if (p.history.length > HISTORY_CAP) p.history.shift();
  }
  return patients;
}
