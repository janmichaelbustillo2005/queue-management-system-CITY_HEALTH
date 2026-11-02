# WPS-A versus WRR when Regular or Vulnerable patients are the majority (2026-11-02)

> **Synthetic data only.** Every patient, arrival time and consultation length below comes from the seeded research
> simulator, not from City Health Office records. The live queue, Call Now, the database and patient records are not
> involved. WRR exists only in this simulation and is not offered as a live scheduler. The numbers describe the
> model under stated assumptions. Replace those assumptions with observed clinic data before drawing conclusions
> about the real clinic.

**Purpose.** Before City Health Office testing, determine how WPS-A (the operational candidate) and WRR (the
comparison baseline) behave when Regular patients outnumber Vulnerable patients (Scenario A) and the reverse
(Scenario B), and where each one's weaknesses appear.

| Item | Value |
|---|---|
| Page | `/algorithm-simulation` (Superadmin → Simulation Mode → Algorithm Simulation): the existing page, with its scenarios replaced |
| Branch | `feature/algorithm-simulation-scenarios`, from `feature/algorithm-simulation` @ `4d6c904` (the pushed page; merged to `main` by PR #8) |
| Code | `backend/simulation/experiment-scenarios.js` (workloads), `experiments.js` (metrics, comparison, findings), `experiment-report.js` (this report's tables); `visual.js` and the page reuse them |
| Results | `docs/research/experiment-results-20261102/experiment-results.md` and `.json` (30 seeds per experiment) |
| Tests | `backend/test/simulation-experiments.test.js` (14), `frontend/test/algorithm-simulation.test.cjs` (12) |

Reproduce, from `backend/`:

```bash
node simulation/experiment-report.js ../docs/research/experiment-results-20261102 30 20261029
```

A test regenerates both files from their seeds and requires them to match byte for byte.

## 1. Method

### What is held equal

- **One workload per seed.** It is generated once and served by both algorithms: the same registration times,
  classifications, service types, consultation lengths, three general doctors, and the same dispatch mode (D1
  Model A shared queue). A test checks this for every scenario and seed. A difference between WPS-A and WRR therefore
  comes from the choice of the next patient alone. **No result here compares dispatch modes.** The benefit of a
  shared queue over fixed per-service doctors (reported on 2026-10-30) is not credited to either algorithm.
- **Non-preemptive, work-conserving.** A free doctor always calls someone if anyone is waiting. Throughput and
  utilization are therefore expected to match, and they do (Section 3).
- **WPS-A is the production rule, unchanged.** Ranking uses `compareWps` from `backend/src/lib/wpsPriority.js`.
  This is the function the backend uses and that `wps-a-postgres.test.js` checks against the PostgreSQL call
  functions:
  `effective = base + min(2, floor(waited / 10 min))`; order by effective, then base, then registration time, then id.
  Ranking is recalculated whenever a doctor becomes free.
- **WRR is the existing research policy, unchanged.** There is one class per distinct base score, and its weight is that
  score. Classes are visited from the highest weight down, and each class may send up to its weight in patients per
  turn, first come, first served inside the class. Empty classes are skipped. The weights are those documented in
  `scheduling-simulation-methodology.md`.

### Classifications and base priority (the live registration rule)

Senior 4, PWD 3, Pregnant 3, Indigenous 2, Solo Parent 1, and Regular 1. A combination sums its weights, for
example Senior + PWD = 7 and Pregnant + Indigenous = 5. "Vulnerable" means at least one approved classification.
It is a priority-lane category, not clinical urgency. **Note:** a Solo Parent alone has base 1, the same as a
Regular patient. Both algorithms therefore treat Solo Parents exactly like Regular patients.

### Experiments

| Experiment | Patients (default) | Mix | Arrivals |
|---|---|---|---|
| **Scenario A — Regular-majority** | 100 (adjustable 20–400) | exactly 80% Regular / 20% Vulnerable | staggered over 08:00–16:00, morning peak and lunch dip |
| **Scenario B — Vulnerable-majority** | 100 (adjustable) | exactly 20% Regular / 80% Vulnerable | same profile |
| **Controlled — one Regular before nine Vulnerable** | 13 (fixed) | 3 opening patients, 1 Regular at 08:01, then Senior, PWD, Pregnant, Senior, Indigenous, PWD, Senior + PWD, Pregnant, Senior from 08:02 to 08:10 | doctors busy until 08:20; 10-minute consultations; no randomness |
| **Stress — sustained higher-priority arrivals** | 100 (adjustable) | 85% Senior/PWD/Pregnant (incl. Senior + PWD), 15% Regular | an opening crowd of 10 (the followed Regular registers 4th), then a continuous 24 per hour, above the ~18 per hour three doctors can see |

The Vulnerable mix in A and B is apportioned exactly, not drawn at random: Senior 34%, PWD 14%, Pregnant 16%,
Indigenous 8%, Solo Parent 8%, Senior + PWD 10%, Pregnant + Solo Parent 5%, Pregnant + Indigenous 3%, PWD + Solo
Parent 2%. Consultation lengths are lognormal by service type (mean 7–14 minutes). **All of these are
assumptions.**

Sensitivity runs repeat A and B at 150 and 200 patients (heavier days). Each experiment uses 30 seeds
(20261029–20261058).

### Metrics, all computed from the simulated calls, starts and completions

- Average, 95th-percentile and maximum wait: overall, Regular, Vulnerable, and per classification.
- Patients completed, throughput (patients per hour until the queue empties), and utilization of the three doctors.
- **Regular bypass:** a call that went to a patient who registered after a Regular patient who was left waiting.
- **Priority-lane violation:** a Regular called while a Senior, PWD or Pregnant patient waited.
- **Still waiting at the cut-off:** not yet called when registrations stopped. This is *not* starvation, because the
  queue then drains and everyone is served.
- **Starvation evidence:** still waiting at the cut-off, after sitting through the last 60 minutes of arrivals in
  which every call (at least 3) went to a later registration. This is the strongest statement a finite simulation
  supports. For WPS-A it is also structural: a capped Regular (1 + 2 = 3) can never pass a waiting patient with
  base 3 or more, so it stays blocked for as long as such patients keep arriving.
- **Call-order differences:** how many patients each algorithm called at a different position, and how many
  times a later Regular was called ahead of a Vulnerable patient.
- **Overload:** consultation minutes registered per hour against the doctors' 180 minutes. A load above 1 is
  reported as arrivals exceeding service capacity.

## 2. Verification

| Check | Result |
|---|---|
| Backend `npm test` | 686 tests: 677 pass, 0 fail, 9 skipped (the disposable-PostgreSQL suites, which need `PHASE25_PG_URL`; not configured on this machine) |
| New `simulation-experiments.test.js` | 14 / 14 pass: exact 80/20 and 20/80 mixes at 100, 150 and 37 patients; live weights read from `queueService.js`; staggered arrivals; identical workloads and the unchanged engine; WPS-A at 0, 10 and 20+ minutes (and the controlled Regular at 08:20 = +1, 08:30 on = +2, effective capped at 3); production `compareWps` plus the SQL ORDER BY in both WPS-A call functions; the controlled case; WRR class turns; starvation evidence under WPS-A and not WRR (3 seeds); metrics recomputed from events; seed reproducibility; input validation; report byte-for-byte; no database, API or environment access |
| Earlier simulation evidence | `simulation.test.js`, `simulation-visual.test.js` and `simulation-report.test.js` (24) still pass. The committed 2026-10-30 `results.json` is reproduced unchanged; the earlier research scenarios still build for the report and are no longer offered on the page. |
| Frontend `npm test` | 421 / 421 pass (Algorithm Simulation: 12, including the scenario picker, patient count, the ranking at each WPS-A call, the WRR turn, and final results equal to the computed analysis) |
| `next build` | succeeds; `/algorithm-simulation` prerendered |
| Browser (isolated dev server on port 3140, API pointed at an unused port) | All four experiments ran to completion, and the final-results tables matched the backend numbers. Scenario B at 10:51:41: WPS-A calls P047 Regular (base 1 + Aging 2 = 3) over the newly registered P056 Indigenous (2), and shows the recalculated ranking. WRR had called the same Regular at 10:50:05 on "turn 39, class w1". The stress chart marks where registrations stop. The page made no API request of its own. |

## 3. Results (30 seeds, mean ± 95% CI; full tables in `experiment-results.md`)

### Scenario A — Regular-majority, 100 patients (offered load 0.63)

| Measure | WPS-A | WRR |
|---|---|---|
| Average wait — Regular / Vulnerable | 5.2 / 1.8 min | 5.2 / 1.8 min |
| Maximum wait — Regular / Vulnerable | 23.9 / 11.1 min | 24.0 / 11.4 min |
| Priority-lane violations per day | 0 | 0.4 |
| Same call order for every patient | 18 of 30 seeds | |

### Scenario B — Vulnerable-majority, 100 patients (offered load 0.67)

| Measure | WPS-A | WRR | Seeds better (WPS-A / WRR) |
|---|---|---|---|
| Average wait — Regular | 14.1 min | 11.5 min | 1 / 29 |
| Maximum wait — Regular | 52.9 min | 43.2 min | 2 / 28 |
| Average wait — Vulnerable | 4.5 min | 5.1 min | 26 / 2 |
| Maximum wait — Vulnerable | 45.2 min | 39.9 min | 11 / 19 |
| Average wait — Senior | 2.2 min | 4.1 min | |
| Average wait — Indigenous | 9.0 min | 4.8 min | |
| Regular bypasses per day | 50.6 | 35.6 | 0 / 29 |
| Priority-lane violations per day | 0 | 3.6 | 30 / 0 |
| Starvation evidence | 0 | 0 | |

### Heavier days (sensitivity)

| Experiment | Load | Regular avg (WPS-A / WRR) | Vulnerable avg | Lane violations (WRR) | Starvation evidence (WPS-A / WRR) |
|---|---|---|---|---|---|
| A, 150 patients | 0.94 | 45.0 / 45.0 min | 6.0 / 5.7 min | 1.2 | 0 / 0 |
| A, 200 patients | 1.25 | 130.0 / 130.0 min | 13.2 / 13.0 min | 2.8 | 0 / 0 |
| B, 150 patients | 1.00 | 146.5 / 125.7 min | 24.8 / 29.5 min | 10.0 | 0 / 0 |
| B, 200 patients | 1.32 | 346.4 / 283.7 min | 75.3 / 87.8 min | 12.5 | 4.3 / 0 per day |

At 200 patients, registrations exceed the three doctors' capacity for most of the day. Waits of 4–7 hours are
an overload result: the simulated clinic keeps registering past what three doctors can see. No scheduling rule
can fix that; it calls for capacity or registration limits.

### Controlled — one Regular before nine Vulnerable (deterministic)

| | WPS-A | WRR |
|---|---|---|
| Regular P004 (registered 08:01) | called **last** (13th) at 08:50 after **49.0 min**, bypassed 9 times | called 12th at 08:40 after **39.0 min**, bypassed 8 times |
| Effective priority of P004 | 2 at 08:20 (19 min, +1), then 3 from 08:30 (+2 cap) | n/a (class w1) |
| Priority-lane violations | 0 | 1 (P004 called while a PWD/Pregnant patient waited) |
| WRR class turns from 08:20 | | w7 → w4 ×3 → w3 ×3 → w2 → **w1 (P004)** → w3 |

Every Vulnerable patient here has base 2 or more, so WPS-A's capped Regular (3) never passes them: a tie with PWD
or Pregnant goes to the higher base. WRR's per-turn cap (3 calls for class w3) gives the Regular class its turn
before the fourth PWD/Pregnant patient.

### Stress — sustained higher-priority arrivals, 100 patients (offered load 1.37; 30 of 30 seeds overloaded)

| Measure | WPS-A | WRR | Seeds better (WPS-A / WRR) |
|---|---|---|---|
| Average wait — Regular | 169.3 min | 91.1 min | 0 / 30 |
| Maximum wait — Regular | 254.7 min | 145.3 min | 0 / 30 |
| Most bypasses of one Regular | 79.1 | 30.3 | 0 / 30 |
| Regular patients still waiting when registrations stopped | 14.4 | 7.3 | 0 / 30 |
| **Regular patients with starvation evidence** | **7.9 per day** | **0** | 0 / 29 |
| Average wait — Vulnerable | 24.7 min | 37.7 min | 30 / 0 |
| Average wait — Senior | 13.3 min | 34.7 min | |
| Priority-lane violations per day | 0 | 10.4 | 30 / 0 |
| Throughput, utilization | equal (work-conserving) | | |

## 4. Findings

### Scenario A (Regular-majority)

- **WPS-A results.** Short waits for everyone (Regular 5.2 min on average, longest about 24 min) and no priority-lane
  violations.
- **WRR results.** Practically the same. In 18 of 30 seeds both algorithms call every patient in the same order. The
  few Vulnerable patients rarely queue long enough to build up several classes at once, which is when WRR's
  rotation would decide differently.
- **Strengths and weaknesses.** Neither algorithm has a material advantage. WRR still produces occasional
  lane violations (0.4 a day at 100 patients, 2.8 at 200) with no measurable gain for Regular patients.
- **Better per metric.** Mostly ties. WPS-A is better on lane violations; the remaining differences are within a
  tenth of a minute.

### Scenario B (Vulnerable-majority)

- **WPS-A results.** Protects the priority lane completely (0 violations) and gives Vulnerable patients the lowest
  average wait, especially Seniors (2.2 vs 4.1 min). Regular patients absorb the cost: average 14.1 min, longest
  52.9 min, and about 51 bypasses a day.
- **WRR results.** Lower Regular waits (average 11.5, longest 43.2 min) and fewer bypasses, at the cost of about
  3.6 lane violations a day and longer Senior and Cumulative-category waits.
- **WRR also shortens the longest Vulnerable wait** (39.9 vs 45.2 min). The longest-waiting "Vulnerable" patients
  under WPS-A are Solo Parents (base 1) and Indigenous patients (base 2). An aged Regular (1 + 2 = 3) can overtake
  an Indigenous patient, and everyone at base 3 or more always does, while WRR gives the w2 class its own turn.
  At 200 patients, Indigenous patients wait 236 min on average under WPS-A against 24 min under WRR.
- **Better per metric.** WPS-A: lane violations, average Vulnerable wait, Senior and Cumulative waits. WRR: every
  Regular measure, bypasses, longest Vulnerable wait, Indigenous waits.

### Does the result change with the Regular/Vulnerable proportion?

**Yes.** With Regular patients in the majority, the two algorithms are effectively equivalent. With Vulnerable
patients in the majority, they diverge, and the gap widens with load: at 100 patients WRR saves Regular patients
about 3 minutes on average, at 200 about 63. The deciding factor is how often several priority classes wait at
the same time, which rises with the Vulnerable share and with overload.

### Does WPS-A's Aging cap sufficiently limit excessive waiting?

**Only when the queue regularly empties of base-3+ patients.** The +2 cap lifts a Regular to an effective 3, which
loses a tie with PWD/Pregnant (base 3) and never reaches Senior (4). Aging therefore lets Regulars overtake
newly registered Indigenous and Solo Parent patients, but it cannot bound their wait against a stream of
Senior/PWD/Pregnant arrivals:

- At normal load (A and B at 100 patients), no Regular showed starvation evidence; the longest Regular waits
  averaged 24 min (A) and 53 min (B).
- Under sustained higher-priority arrivals (stress), **7.9 Regular patients a day** met the starvation-evidence rule
  under WPS-A (0 under WRR). The followed Regular in seed 7 waited 274 minutes and was bypassed 82 times.
- In overloaded Scenario B (200 patients), 4.3 a day met the rule.

In short, the cap limits reordering, not waiting time. This is a property of the formula as designed; the formula
was not changed.

### Do WRR's fairness advantages introduce unacceptable vulnerability-priority trade-offs?

The trade-off is real and grows with the Vulnerable share and load: 0.4 lane violations a day in A, 3.6 in B,
10–12.5 in the stress and overloaded runs. Seniors wait about 2–6 times longer (stress: 13.3 → 34.7 min).
**Whether that is unacceptable is a policy judgment, not a simulation result.** If the office's priority-lane rule
is a strict requirement, any violation disqualifies WRR as specified. If bounded Regular waiting is also required,
WPS-A as specified does not guarantee it under sustained priority demand.

### Evaluation criteria (in order of importance; no single overall winner)

1. **Primary — priority-lane protection** (lane violations, Vulnerable waits). WPS-A is better in every
   experiment (0 violations by construction).
2. **Primary — bounded Regular waiting** (longest/P95 Regular wait, bypasses, starvation evidence). WRR is better
   whenever Vulnerable patients are the majority or arrive continuously; the two tie in Scenario A.
3. **Secondary — average waiting time.** Overall averages are nearly equal. WPS-A favours Vulnerable patients and
   WRR favours Regular patients.
4. **Context — throughput and utilization.** Equal; neither algorithm changes capacity.

The two Primary criteria conflict. Which algorithm is preferable depends on the weight the City Health Office places
on each, so this report does not declare an overall winner.

## 5. Summary for adviser checking (Chapter IV)

1. With **80% Regular patients**, WPS-A and WRR perform the same: identical order on 18 of 30 days, waits within
   0.1 minute. WPS-A keeps a perfect priority lane, while WRR occasionally breaks it for no measurable gain.
2. With **80% Vulnerable patients**, WPS-A keeps Vulnerable (especially Senior) waits lowest and never breaks the
   priority lane. Regular patients wait longer: 14.1 vs 11.5 min on average, 52.9 vs 43.2 min at the longest.
3. **WPS-A's +2 Aging cap does not prevent Regular starvation** when Senior/PWD/Pregnant patients keep arriving
   faster than three doctors can see them (7.9 Regular patients a day with starvation evidence in the stress test,
   0 for WRR). At normal load, starvation evidence did not occur.
4. **WRR bounds Regular waiting** but calls Regular patients ahead of waiting Senior/PWD/Pregnant patients 3.6–12.5
   times a day in Vulnerable-majority and stress conditions, and multiplies average Senior waits by about 2–6.
5. **Classification observations** for the adviser:
   - Solo Parent (base 1) receives no priority under either algorithm.
   - Under WPS-A, Indigenous patients (base 2) can be overtaken by aged Regular patients, so in Vulnerable-majority
     days they wait far longer than under WRR.
6. Throughput and doctor utilization are identical; the algorithms differ only in *who* waits.

**Recommendations (for discussion; nothing here changes the operational system):**

- Keep WPS-A as the operational candidate if the priority lane is a strict requirement. Document its known limit:
  bounded Regular waiting holds only while the queue periodically runs out of Senior/PWD/Pregnant patients.
- For CHO testing, record observed hourly arrivals, Regular/Vulnerable shares and consultation lengths, and rerun
  these experiments with them (only `experiment-scenarios.js` changes).
- Ask the adviser and the CHO whether a separate, explicit safeguard is wanted for long-waiting Regular patients,
  for example a staff alert past a waiting threshold. Any such change needs separate approval. The WPS-A formula,
  Call Now and the live queue were not modified.
- Ask whether Solo Parent's base weight of 1 and Indigenous's base weight of 2 reflect the intended priority. These
  are existing registration weights, out of scope here.
- Treat overload (registrations above about 18 per hour for three doctors) as a capacity issue: no ordering rule
  shortens the total queue.

## 6. Limitations

- Synthetic workloads; every parameter is an assumption.
- No no-shows, recalls, breaks, doctor speed differences, registration or call delays, or balking.
- Shared queue only (D1 Model A, provisional). Results will be rerun if the approved dispatch differs.
- Starvation evidence is a finite-horizon rule (60 minutes, at least 3 calls). The structural argument for WPS-A
  (cap 3 ≤ base 3) explains why it persists as long as such arrivals continue.
- The disposable-PostgreSQL WPS-A tests were not run here, because no cluster is configured on this machine.
  Alignment with PostgreSQL rests on the existing `wps-a-postgres.test.js` and `i1-shared-wps-a-postgres.test.js`
  (reported passing on PostgreSQL 17 in `docs/i1-integration-d1-wpsa-wrr-20261029.md`) and on the new check that
  both SQL call functions still carry the same ORDER BY.
