# E2E-1 and autonomous development report — 2026-10-29

Branch `feature/e2e1-wps-testing` (worktree `output/wt-e2e1-dev`), from `a87a4cd`. Nothing was merged,
deployed, migrated or written to the hosted Supabase project (`uvmpbgpvmjkfoblrfrdt`) by this work: every
mutation test ran on a disposable local PostgreSQL 17.10 cluster (loopback only, `cluster_name =
r22-disposable-cancel-verification`, one throw-away database per suite, synthetic rows). Hosted access was
read-only `SELECT`s.

## 1. E2E-1 results

| Test | Where | Result | Evidence |
|---|---|---|---|
| A — lifecycle (Register → Call → Accept → Re-Call → Start → Complete), counter release, Display, voice, Records, Analytics | hosted dev project, manual browser, 10:19–10:37 | **PASS** | `output/e2e-1/20261029-testA/` |
| B — WPS: Regular registered first, Senior second; Senior heads Doctor 1 in backend **and** rendered Frontdesk table; backend and C1 (direct service_role call, P0001) refuse the Regular; both complete in WPS order | local PG17, real routes | **PASS** (5/5 runs) | `test/e2e1-test-b-wps.test.js`, `output/e2e-1/20261029-testB-local-pg17/` |
| C — Waiting → W1 Cancel → F5 Requeue → C1 Call → Accept → Re-Call → Start → Complete; revisions change each step; only Doctor 1's counter moves; a Doctor 2 visit is untouched; completed history refuses Cancel/Requeue | local PG17 | **PASS** | `test/e2e1-test-c-d.test.js`, `output/e2e-1/20261029-testCD-local-pg17/` |
| D — three doctors call in parallel from separate backend instances; concurrent Complete (D1) + Cancel (D3) leave D2 unchanged; busy doctor refused with no side effects | local PG17 | **PASS** (fixed-mapping architecture — see §6) | same |

Test B/C/D prove behaviour on PostgreSQL 17 with the real backend; they do not prove hosted browser behaviour.

## 2. Defects found and fixed (each with a failing-first regression test)

| # | Severity | Defect | Fix | Commit |
|---|---|---|---|---|
| 1 | Medium | Accept recorded with the Node clock, `called_at` with the DB clock; if the clinic computer's clock is behind Supabase by more than the Call→Accept gap, Start Consultation is refused ("Accept the current call…"). Reproduced at 2 s and 30 s skew. | Acceptance recorded no earlier than `called_at` + 1 ms; earlier-cycle acceptances still rejected. No SQL change. | `33d7957` |
| 2 | **Critical** | `admin123` opened every account whose id starts with `admin` (all doctor accounts) regardless of stored password. | Removed; only the account's own password; plaintext comparison constant-time. | `b86bfe0` |
| 3 | High | Public `/queue/website` summed client flags: repeats multiplied weight (`["pwd","pwd","pwd"]` = 9), unknown/non-string flags stored, non-array → 500, Senior with any birthdate. | Unknown/malformed → 400; each category once; Senior refused below 60 on the Manila date; invalid/future birthdate → 400. Backend never adds Senior. | `eb1a65b` |
| 4 | Medium | Superadmin could delete itself / delete or demote the last Superadmin; role unvalidated; missing password → 500. | No self-delete; last Superadmin protected; role ∈ {admin, superadmin}; new passwords ≥ 8; 400s. | `a4cba4b` |
| 5 | High (data integrity) | Reset Queues: two-step archive + counter release. A Requeue + Call committed between them lost its counter (serving visit with no doctor pointer) — reproduced on PG17. | With W1 installed, Reset cancels each visit through `cancel_patient_visit` (atomic per visit). Old path kept only without W1. | `83c4943` |
| 6 | Low | Voice launcher `stop()` resolved before the Windows venv interpreter released the port; quick restarts misreported "port in use by another application". Was the known flaky shutdown test (~2/7). | `stop()` waits (≤5 s) until the port is absent. 0/12 failures after. | `2484583` |

Known baseline failures re-examined: **voice-launcher shutdown** — genuine (minor) product defect, fixed (#6).
**Frontdesk carry-over cancel** — test-fixture defect, already fixed in `a87a4cd`; passes.
**C1 randomized soak** (`call:waiting:ok > 20`) — fails occasionally only when the whole suite runs in
parallel; it is a liveness threshold, every consistency/no-deadlock check passed in those runs, and it
passes in isolation and serially (110/110 PG concurrency tests serial). Environment/timing; assertion kept.

## 3. Audit findings not fixed (need a decision or approval)

| Severity | Finding | Recommendation |
|---|---|---|
| Deployment | The 5 accounts on the development project store **plaintext** default passwords (checked read-only, values never printed). The project owner confirmed (2026-10-29) these are **demo/test accounts only**, not real staff accounts, so this is accepted for development. With #2 removed, `admin123` works for a doctor account only if that is its own stored password. | Before any production deployment: create real accounts through Staff Management (stored as bcrypt) and remove or re-password the demo accounts. |
| Medium | No login rate limiting / lockout. | Approve a policy (e.g. 10 failures / 15 min per account+IP → 429). |
| Medium | F5 Requeue reuses the row: the cancellation reason and time **and the original registration time** are overwritten (Test C pins this). Analytics wait for re-queued visits restarts from the requeue. | Visit-history table (design + hosted migration → approval). |
| Policy | Public registration lets an anonymous patient self-declare PWD/Pregnant/Indigenous/Solo Parent. | Decide whether categories other than birthdate-derived Senior require staff verification. |
| Policy | Solo Parent alone scores 1 — identical to Regular. | Confirm intended weights with the Health Office. |
| Low | Analytics wait time rounds each visit to whole minutes before averaging (7m30s shown as 7.0m). | Average unrounded values. |
| Low | `/api/geocode` is an unauthenticated proxy to Nominatim (fair-use 1 req/s). | Require auth or rate-limit. |
| Low | CORS allows any private-LAN origin; many 500 responses echo internal messages. | Tighten for deployment. |
| Verified OK | JWT secret has no fallback (A7); setup endpoints Superadmin-only (S1); Records router requires Superadmin; account edits revoke sessions (trigger); login local-memory fallback is disabled when Supabase is configured. | — |

## 4. WPS-A (implemented, off by default, not activated)

`effective = priority_score + min(2, floor(waited / 10 min))`; order effective DESC, **priority_score DESC**,
registration ASC, id ASC. Waited = registration → ranking instant (ms). Non-preemptive; per-doctor queues.
Safeguard via the base tie-break: a Regular (max 3) never passes a Senior and loses ties to new PWD/Pregnant;
it can pass newer Indigenous/Solo Parent visits. A waiting protected patient also ages (a 20-min PWD passes a
new Senior) — **policy decision needed**, as is the +2 cap. No emergency category exists; emergencies stay
outside the queue per clinical policy.

- Node: `backend/src/lib/wpsPriority.js` (single rank function); `WPS_AGING` env flag; `GET /queue` adds
  `effective_priority`; four frontend comparators use it.
- DB: `backend/scripts/20261029-wps-a-call-aging.sql` (+ rollback) — `call_patient_visit_wps_a`, a C1 twin
  ranking at the backend's instant (±10 min of DB clock). **Draft; not installed anywhere hosted.**
- With aging on and the function missing, Call → 503, nothing changes.
- Verified: 10 unit tests (0/9/10/20 min, edges, cap, ties, categories, separation); 7 PG17 tests incl.
  120 randomized rounds where the DB accepts exactly the backend's head at ±1 ms step edges.

## 5. WRR comparison simulation — both D1 dispatch modes

`backend/simulation/` (engine, policies, scenarios, metrics, run); methodology in
`docs/research/scheduling-simulation-methodology.md`. WPS/WPS-A use the production rank function; WRR serves
priority-score classes highest-first, up to `weight` per turn, FIFO in class. Six scenarios × 30 seeded
replications × **both D1 dispatch modes** (`service` = fixed doctors, current; `shared` = D1 Model A, general
doctors, one queue). Every workload parameter is an **assumption** (`scenarios.js`), not a clinic measurement.
Results: `output/e2e-1/20261029-simulation-both-dispatch-modes/results.md`.

Model observations (synthetic): the shared queue cuts waits far more than any policy change (e.g. unequal
workload, average 104 → 3.9 min); WPS-A is nearly identical to WPS (its +2 cap keeps Regulars below
protected patients, so it does not relieve their longest waits under overload); WRR lowers the longest waits
most in the priority surge but raises Senior waits and serves Regulars ahead of waiting protected patients
(about 5/day in that scenario; 0 for both WPS variants).

## 6. Reconciliation with D1 (general doctors)

D1 (`feature/d1-flexible-doctor-assignment`) branched from `83c4943`, so it already contains fixes #1–#5 and
Tests B–D. Not in D1: WPS-A (`077ea15`), simulation, voice fix (`2484583`). D1 (in progress, uncommitted when
checked) adds `DOCTOR_DISPATCH_MODE` = `service` (default) | `shared` (Model A, needs
`20261029-d1-shared-call.sql`).

Done: the simulation models both modes (no shared files with D1).

Still pending D1's committed code:
- WPS-A in `shared` mode needs the aging `ORDER BY` in D1's shared Call function too (a twin of
  `d1-shared-call.sql`), and the Node head must use the shared queue. In `service` mode the current WPS-A
  twin applies unchanged. **Expect a merge conflict** in `queueService.js`, `env.js`, the PG harnesses and the
  frontend comparators (`PatientQueueTable.js`, `DoctorAdmin.js`, `pages/index.js`, `lib/queueTicket.js`).
- Test B's "Doctor 1 head" and Test D's cross-doctor refusals (`/assigned to Doctor 2/`) hold for `service`
  mode; shared-mode equivalents belong with D1's tests.

Independent of D1: fixes #2, #3, #4, #6, the WPS-A rank function, the simulation.

## 7. Regression (final, worktree)

Backend `node --test test/*.test.js` with PG17 + PGlite enabled and voice venv: **1051/1051 pass, 0 skipped**
(baseline this morning: 1003 pass, 4 skipped). PG concurrency suites serial: **110/110**. Frontend:
**394/394**. Production `next build`: success (14 routes).

## 8. Hosted observation (not caused by this work)

Historical visit **89 (FP-008, registered 2026-09-26)** was cancelled on the hosted project at
2026-10-29 12:03 Manila, reason "Development test concluded — visit not served.". Historical Waiting is now 19.
Counters are consistent. **Confirmed by the project owner on 2026-10-29 as an authorized Historical Backlog
cancellation.** 19 historical Waiting visits remain; they still need separate authorization before any change.

## 9. Requires your approval

Replacing the demo accounts before production; login rate-limit policy; WPS-A policy (cap, protected aging) and installing
its SQL; visit-history migration for F5; merging this branch; any hosted migration or data change.
