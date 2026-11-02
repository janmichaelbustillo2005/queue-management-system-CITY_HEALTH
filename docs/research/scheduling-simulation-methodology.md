# Scheduling simulation: methodology (WPS, WPS-A, WRR)

Code: `backend/simulation/` · Tests: `backend/test/simulation.test.js` · Reproduce (from `backend/`):

```bash
node simulation/run.js ../output/simulation 30 20261029
```

```bash
node simulation/report.js ../output/simulation
```

`report.js` adds comparison tables, paired structure-versus-policy effects, a per-replication CSV, SVG charts and
a step-by-step trace of one seeded day; it reads `results.json` and never changes a result. The committed run,
with seeds and hashes, is `docs/research/simulation-results-20261030/`, written up in
`docs/research/wps-a-vs-wrr-simulation-report-20261030.md` (adviser walkthrough:
`docs/research/adviser-simulation-demo-guide.md`).

The simulation is a research tool. It is never used by the live queue, and WRR is never offered as a live
scheduler.

## Model

- **Discrete-event, non-preemptive.** A consultation, once started, runs to completion. A doctor picks the
  next patient the instant it becomes free, from the patients who have arrived by then; if none has, the
  longest-idle doctor takes the next arrival.
- **Three doctors, two dispatch modes** (matching D1's `DOCTOR_DISPATCH_MODE`; neither is assumed approved):
  - `service`: each service has a fixed doctor (consultation/check-up → Doctor 1, prenatal/maternity →
    Doctor 2, family planning → Doctor 3); three independent queues. This is the current behaviour.
  - `shared`: D1 Model A (provisional). All doctors are general doctors and take the head of one queue.
- **Policies** rank the waiting patients of a queue:
  - *WPS (original)*: the production `compareWps` without aging (score DESC, arrival ASC, id ASC).
  - *WPS-A*: the production `compareWps` with 10-minute aging, +2 cap, base-score tie-break.
  - *WRR*: one class per distinct priority score, weight = score; classes visited from the highest weight
    down; a class sends up to `weight` patients per turn (FIFO inside the class); empty classes are skipped.
    The cycle position is tracked by class weight, so a class appearing mid-day cannot shift it.
- **Identical workloads:** for each seed, one workload is generated and every policy, in both modes, serves
  exactly those patients. Differences between policies therefore come from scheduling alone.

## Workload: assumptions (not measured)

Every parameter is in `backend/simulation/scenarios.js` and is an assumption for a small city health
office:

- An 8-hour registration window, with the clinic draining any remaining queue afterwards.
- Piecewise-constant Poisson arrivals per scenario: low 8/h, medium 14/h, high 19/h, a priority surge
  (12/h with a 20/h Senior-heavy burst from 09:30 to 10:30), an unequal workload (15/h, 75% of arrivals for
  Doctor 1's services), and long waits (24/h for 4 h, then 16/h).
- Lognormal consultation lengths per service (mean 7–14 min, CV 0.4–0.5). In shared mode, any doctor takes
  the same time for a given service.
- Category mixes per service (for example, prenatal is mostly Pregnant).
- Weights follow the live registration rules (Senior 4, PWD 3, Pregnant 3, Indigenous 2, Solo Parent 1,
  Regular 1; combinations are summed).

The clinic's own arrival counts, durations and category shares should replace these values before any
conclusion is drawn about the real clinic.

## Metrics (per simulated day; then mean ± 95% CI over 30 replications)

- Average, 95th-percentile and maximum wait (arrival → consultation start), overall and per priority group.
- Jain's fairness index over individual waits: 1 means everyone waits the same. Priority scheduling is
  intentionally unequal, so read it comparatively.
- Throughput (patients served per hour of the working day) and doctor utilization (busy time / day length).
- Starvation indicators: the number of waits over 60 and over 120 minutes, and the maximum Regular wait.
- Priority-policy deviations:
  - *lower-score-first decisions*: a patient was served while a higher-score patient waited in the same
    queue. This is zero for WPS by construction.
  - *Regular before waiting protected*: a Regular was served while a Senior, PWD or Pregnant patient waited.

## Verification

The tests check:

- Seed determinism.
- Conservation: every patient is served exactly once, never before arrival.
- No doctor overlap.
- Work conservation across policies.
- Zero lower-score-first decisions for WPS, in both modes.
- WPS-A's aging case.
- The WRR credit cycle, including a class appearing mid-day.
- Shared-mode spread across doctors.
- The metric formulas.

## Results

`output/.../results.md` holds the tables for both modes. These are model observations, under the
assumptions above:

- The dispatch mode dominates. A shared queue (Model A) lowers average and maximum waits by a large factor
  versus fixed per-service doctors, most strongly when the workload is unequal across services.
- WPS-A is almost indistinguishable from WPS on every metric. Its +2 cap keeps Regulars below Seniors and
  tied-below PWD/Pregnant, so under overload it does not shorten Regulars' longest waits. It only reorders
  among adjacent categories.
- WRR lowers the longest waits most in the priority-surge scenario. It does so at the cost of higher Senior
  waits and of Regulars served before waiting protected patients (zero for both WPS variants).

## Limitations

- The workloads are synthetic.
- Registration and call delays, no-shows, recalls, breaks and doctor speed differences are not modelled.
- Patients are not lost to balking.
- Shared mode follows D1's provisional Model A and will be rerun if the approved design differs.
