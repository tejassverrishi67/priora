import { makePatients, stepPatients } from './patients.js';
import { buildExplanation } from './priora.js';

globalThis.__L5_DEBUG = true;

const P = makePatients();
const bed12 = P.find((p) => p.bed === 12);
const bed3 = P.find((p) => p.bed === 3);

function dump(label, patient) {
  const v = `hr=${patient.hr} rr=${patient.rr} sbp=${patient.sbp} spo2=${patient.spo2} temp=${patient.temp}`;
  console.log(`\n===== ${label} =====`);
  console.log(`raw vitals: ${v}`);
  const e = buildExplanation(patient);
  console.log(`headline: ${JSON.stringify(e.headline)}`);
  console.log(`lines (${e.lines.length}):`);
  e.lines.forEach((l) => console.log(`  ${JSON.stringify(l)}`));
}

let tick = 0;
function stepTo(target) {
  while (tick < target) {
    stepPatients(P);
    tick += 1;
  }
}

stepTo(30);
dump('Bed 12 @ tick 30', bed12);
stepTo(35);
dump('Bed 12 @ tick 35', bed12);
stepTo(40);
dump('Bed 12 @ tick 40', bed12);

dump('Bed 3 (chronic-stable) @ tick 40', bed3);
