# Adviser demonstration guide — WPS vs WPS-A vs WRR simulation (about 15 minutes)

Everything runs locally on synthetic data. Nothing touches Supabase, the live queue or the demo servers
(ports 3000/4000), so it can be shown while the demo system is running. Full results and wording:
[`wps-a-vs-wrr-simulation-report-20261030.md`](wps-a-vs-wrr-simulation-report-20261030.md).

## Before the meeting (2 minutes)

From the repository folder on branch `docs/sim-wpsa-wrr-report` (or any branch that contains it), open a
terminal in `backend/`. Node.js 18+ is enough; no database, internet or `.env` is needed.

## 1. Show that the simulator is tested (1 minute)

```bash
node --test test/simulation.test.js test/simulation-report.test.js
```

Expect `tests 12 / pass 12`. Say: *the tests check that every patient is served exactly once, never before
arriving, that no doctor serves two patients at once, that WPS never serves a lower score first, that the same
seed always gives the same day, and that the trace and charts reproduce exactly.*

## 2. Run the whole experiment live (1 minute)

```bash
node simulation/run.js ../output/sim-demo 30 20261029
```

```bash
node simulation/report.js ../output/sim-demo
```

About two seconds in total: 6 scenarios × 30 seeds × 3 policies × 2 queue structures = 1,080 simulated days.
`output/` is ignored by Git, so this does not change the committed results. Optional proof of reproducibility:

```bash
git diff --no-index --stat ../docs/research/simulation-results-20261030/results.json ../output/sim-demo/results.json
```

No output means the live run matches the committed results byte for byte.

## 3. Walk through the charts (6 minutes)

Open the files in `docs/research/simulation-results-20261030/charts/` in a browser (hover a bar for its value).

| Order | Chart | One-sentence message |
|---|---|---|
| 1 | `effects-structure-vs-policy.svg` | Sharing one queue among three general doctors cuts the maximum wait by 30–277 minutes; changing the scheduling rule moves it by minutes. |
| 2 | `wait-max.svg` | Same picture in absolute terms: the left (service dispatch) panel is several times taller than the right (shared). |
| 3 | `utilization.svg` | Why: under service dispatch Doctor 1 is ~99% busy while Doctors 2 and 3 idle half the day; the shared queue balances them. |
| 4 | `effects-policy-only.svg` | At its own scale: WRR helps the worst case only in the surge scenario under service dispatch; WPS-A barely moves anything. |
| 5 | `protected-ordering.svg` | WPS and WPS-A never call a Regular while a Senior/PWD/Pregnant patient waits; WRR does, up to ~6 times a day. |
| 6 | `wait-by-group-long-waits.svg` | The price of each policy: WRR raises Senior waits; WPS-A raises Indigenous waits. |
| 7 | `head-to-head-wrr-vs-wpsa.svg` + `head-to-head.md` | Direct comparison on the same days: WRR shortens worst waits mainly in the surge scenario but fails the priority-lane rule on most days (31–36 of 180 compliant); WPS-A passes on all 180. |

## 4. Show one decision step by step (4 minutes)

Open `docs/research/simulation-results-20261030/sample-trace.md` and go to **09:55:04** in the WPS and WPS-A
tables (scenario long-waits, seed 20261029, shared queue). Doctor 1 becomes free with 15 patients waiting:

* **WPS** calls P053 Indigenous (score 2, arrived 13 seconds earlier) ahead of P032 Regular (waited 55.7 min).
* **WPS-A** calls P032 Regular: after 20 minutes its score is 1 → 3, which beats the new Indigenous patient's 2.
* **WRR** shows classes taking turns: Indigenous (class w2) is served on its turn, then a Regular (w1) when no
  higher class waits.

Then scroll to *Lifecycle of the window's arrivals* to show the same patients getting different doctors and
start times under each policy.

## 5. Close with the limitations (1 minute)

* **Synthetic workload**: no City Health records were used; numbers show direction and relative size, not
  actual clinic waits. The next step is to replace `simulation/scenarios.js` with the clinic's arrival counts,
  consultation times and category shares.
* **WPS-A +2 cap**: cannot bound the worst wait under overload; lets aged Regulars pass Indigenous patients and
  aged PWD/Pregnant patients pass a new Senior — a policy decision for the adviser and Health Office.
* **WRR**: shortens the worst case by serving lower classes ahead of waiting protected patients; kept as a
  research baseline, not used in the live queue.
* **Model**: no breaks, no no-shows, identical doctor speed; the shared queue (D1) is still provisional.

## Questions to expect

| Question | Answer |
|---|---|
| Are these real City Health waiting times? | No. Every patient is generated from documented assumptions; the hosted database was not read. |
| Why 30 repetitions? | 30 paired seeds give 95% confidence intervals narrow enough to separate structure effects (tens of minutes) from policy effects (minutes). |
| Why are average waits the same for all policies? | All three keep doctors busy whenever someone waits, so they only re-order the same total waiting. |
| Is WRR fairer? | Its Jain fairness index is slightly higher, but it achieves that by serving Regulars before waiting Seniors/PWD/Pregnant patients. |
| Does WPS-A help? | In this model its effect on the maximum wait is within about one minute in the shared queue; its value is mainly policy (bounded catch-up for long-waiting patients), and its side effects need approval. |
