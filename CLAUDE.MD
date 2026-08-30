\# PriorA — Project Context



Hospitals run AI that flags patients at risk of deterioration. That AI fires

every alert in isolation, at identical urgency, using population thresholds,

with no idea how many nurses are on shift. Result: \~7 in 8 alerts are false,

and the genuinely dying patient competes for attention with someone whose

"abnormal" vitals are their normal.



PriorA is a decision layer BETWEEN the hospital's existing AI and the nurses.

It does NOT predict sepsis. It takes raw risk scores and turns them into a

ranked, personalized, self-explaining list of who to see first — assigned to

the nurses actually working.



\## Tech constraints

\- Single-page app. Vanilla JS + HTML + CSS. No framework, no build step.

\- No backend, database, API calls, or model training.

\- All data synthetic, generated client-side.

\- Simulation tick every 1000ms.

\- PREMIUM LIGHT THEME: bg #F7F9FC, surface #FFFFFF, text #0B0E14,

&#x20; blue #2E5BFF, yellow #F5B700 (sparingly), black #0B0E14 for critical.

\- Inter font. 16px card radius, pill buttons. Hairline borders, minimal shadow.



\## Files

\- index.html   — markup shell

\- styles.css   — all styling

\- patients.js  — synthetic patients + scripted trajectories

\- engines.js   — swappable "hospital AI" scorers

\- priora.js    — the 6 layers, PURE FUNCTIONS, NO DOM ACCESS

\- app.js       — simulation loop + rendering (only file touching DOM)



\## The 6 layers

L1 Personal baseline — rolling median + spread of the patient's OWN vitals.

&#x20;  deviation = |current - own\_median| / own\_spread

&#x20;  CRITICAL: reads RAW VITALS directly, NEVER the engine's score.

L2 Site calibration — remap raw engine score to local event rates.

L3 Cross-patient ranking — compare ALL patients against each other.

&#x20;  priority = (calibrated\_risk \* 0.30) + (deviation \* 0.45) + (velocity \* 0.25)

L4 Staff assignment — split ranked list across nurses on shift by bed range.

&#x20;  Extra nurses extend DEPTH into the list; never distribute false alarms.

L5 Explanation — colleague-style handoff text, not a score.

L6 Safety — hard threshold override + auto re-escalation.



\## Invariants — never break these

\- Bed 12 must rank #1 at any activation tick from 20 (crash onset) through

&#x20;  roughly tick 55 (mid-plateau) — this is L3's job, verified by the

&#x20;  headless ranking test.

\- Once a patient has been flat-critical and unreviewed for an extended

&#x20;  period (Bed 12 post-tick ~55), holding them at #1 against an actively

&#x20;  deteriorating patient becomes L6's responsibility (hard safety floor +

&#x20;  staleness escalation), not L3's. This is correct separation of concerns,

&#x20;  not a known bug — do not attempt to fix this by changing L1/L3 weights

&#x20;  or the baseline window again.

\- Beds 3, 9, 18, 22, 27, 35 (chronically abnormal) must NEVER rank top 2,

&#x20;  at any tick, regardless of engine.

\- L1/velocity must work even if the engine score is garbage.

\- No patient is ever deleted — only moved between assigned and watchlist.

