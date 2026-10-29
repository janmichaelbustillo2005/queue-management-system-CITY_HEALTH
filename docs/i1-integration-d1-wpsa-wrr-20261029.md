# I1 — Integration of D1 flexible doctors, WPS-A aging and the WRR research simulation

Date: 2026-10-29 · Branch: `integration/d1-wpsa-wrr` (worktree `output/wt-i1-integration`) · Status: **local
integration and testing complete; nothing installed, enabled or deployed on any hosted project; not merged to main.**

Inputs (verified against `origin`, both clean, common base `83c4943`):
`feature/d1-flexible-doctor-assignment` @ `35d312c` and `feature/e2e1-wps-testing` @ `30490a6`. Neither branch nor
any other worktree, stash or commit was modified.

## 1. Integration branch and commits

| Commit | Content |
|---|---|
| `1f8b34a` | Merge of `30490a6` into `35d312c`, with the conflict resolutions in §2 (nothing else) |
| `97bd97a` | D1-A: shared-queue Call with WPS 10-minute aging (`call_patient_visit_shared_wps_a`), preflight/verify/rollback, PG17 integration suite, `.env.example` |
| `36dc3db` | Tests: shared-queue aging order in the UI and ticket; simulation input consistency across policies and modes |
| `bd4a633` | This report (first version) |
| `09579e8` | I2 Finding 8 (from the E2E-1 session, branch `fix/i2-c1-fail-closed`, fast-forwarded after review): service-mode Call fails closed when C1 cannot be used; opt-in `ALLOW_LEGACY_TWO_STEP_CALL` only for a database that never had C1 |
| (this commit) | Report updated for `09579e8` (§4, §7, §8, §11) |

## 2. Merge conflicts and resolutions

Five files conflicted; three more auto-merged and were reviewed by hand. No file was taken wholesale from one side.

| File | Conflict | Resolution |
|---|---|---|
| `backend/src/services/queueService.js` | (a) `GET /queue` header: D1 `dispatch_mode` vs E2E `wps`; (b) Call ranking: D1 shared head vs E2E aged comparator `compareWaitingPriority(rankedAt)`; (c) Call RPC: D1 `rpcName` vs E2E aging switch | (a) both fields. (b) one `rankedAt` per Call drives `getSharedQueueHead(waiting, doctor, rankedAt)` (shared) or the service head; both use `compareWps`. (c) `getCallRpcName(shared, aging)` picks C1 / WPS-A / D1 / D1-A; only C1 kept the old two-statement fallback (since `09579e8`: only with `ALLOW_LEGACY_TWO_STEP_CALL`); the other three refuse with 503 when their function is missing |
| `backend/test/helpers/pgBackendHarness.js`, `c1f5w1Fixture.js` | D1 `doctorDispatchMode` vs E2E `envOverrides` | both options; `env = {…, doctorDispatchMode, ...envOverrides}` |
| `frontend/components/PatientQueueTable.js` | D1 `isUnassigned` vs E2E `wpsRank` | both helpers; the shared head (`sharedHeadFor`) and every list use the aged `compareQueue` |
| `frontend/lib/queueTicket.js` | D1 shared scope for patients-ahead vs E2E aged rank | shared scope **and** aged rank |
| auto: `backend/src/config/env.js` | — | both `doctorDispatchMode` (strict) and `wpsAging` present |
| auto: `frontend/pages/index.js` | — | `getSharedHead`/`sharedNext` use the aged `compareQueuePriority` |
| auto: `frontend/components/DoctorAdmin.js` | — | aged list order + D1 shared-mode ownership; no interaction |

## 3. Files changed

Relative to the base `83c4943` the integration contains every file of both branches (D1: 32 files; E2E: 29 files)
plus, new in I1:
`backend/scripts/20261029-d1a-shared-wps-a-call.sql`, `20261029-d1a-preflight.sql`, `20261029-d1a-verify.sql`,
`20261029-d1a-rollback.sql`, `backend/test/i1-shared-wps-a-postgres.test.js`,
`docs/i1-integration-d1-wpsa-wrr-20261029.md`; and edits to `backend/.env.example`, `backend/test/simulation.test.js`,
`frontend/test/d1-shared-dispatch-ui.test.cjs` (plus the §2 resolutions).
`git diff --stat 83c4943..integration/d1-wpsa-wrr` lists them all.

## 4. Migration requirements

No migration changes a table, column, trigger, RLS policy, grant on a table or any row. C1/F5/W1/B.2 files are unchanged.

| Function / file | Needed for | Status |
|---|---|---|
| C1 `20261025-c1-atomic-call.sql`, F5 `20261022-f5-requeue-terminal-recovery.sql`, W1 `20261025-w1-atomic-cancel.sql` | every mode (atomic Call/Requeue/Cancel). Since `09579e8`, service-mode Call **refuses** (503) without C1 | reviewed earlier; confirm presence with their preflights before running this branch |
| D1 `20261029-d1-shared-call.sql` (+ preflight 21 / verify 15 / rollback) | `DOCTOR_DISPATCH_MODE=shared` | draft, not installed |
| D1-R `20261029-d1r-records-shared.sql` (+ preflight 7 / verify / rollback) | correct Records doctor filter in shared mode (optional) | draft, not installed |
| WPS-A `20261029-wps-a-call-aging.sql` (+ rollback) | `WPS_AGING` on with service dispatch | draft, not installed |
| **D1-A** `20261029-d1a-shared-wps-a-call.sql` (+ preflight 10 / verify 15 / rollback) | `WPS_AGING` on with shared dispatch | **new**, draft, not installed |

Configuration matrix (backend): `service` + aging off → C1 (default, today's behavior); `service` + aging on →
WPS-A; `shared` + aging off → D1; `shared` + aging on → D1-A. Install order for a shared + aging trial on the
development project: (C1, F5, W1 if absent) → D1 → (D1-R) → D1-A, each preflight → migration → verify; then set the
two flags on a **separate** test backend and restart.

## 5. Shared WPS-A implementation

* Formula (provisional): `P_effective = P_base + min(2, floor(waited_ms / 600000))`, `waited = rankedAt − created_at`
  in whole milliseconds, never negative. Order: `P_effective DESC, P_base DESC, created_at ASC, id ASC`, so a
  protected category always wins a tie with an aged Regular, and a Regular (max 3) never passes a Senior (4).
* One rule in three places: `backend/src/lib/wpsPriority.js` (`compareWps`, used by the backend ranking, `GET
  /queue.effective_priority`, `/display` order and the simulation), the SQL `ORDER BY` in D1-A, and the frontend
  comparators (which sort by the backend's `effective_priority`, then `priority_score`, `created_at`, `id`).
* Aging is recomputed at every Call: the backend ranks at `rankedAt = Date.now()` and passes it as `p_ranked_at`;
  D1-A refuses a `p_ranked_at` more than 10 minutes from the database clock and re-ranks at that same instant under
  its locks, so Node and PostgreSQL compute the same bonus even with clock skew.
* Candidates are D1's: today's waiting visits of the five configured services, unassigned or reserved (legacy
  Phase 2.1) for the calling doctor. Any of the three doctors may take any of them.
* Unchanged from D1/C1: account check, doctor-for-itself rule, offline/busy checks, legacy orphan block, lock order
  users → all counters by id → patient, verified two-row write, one pointer per visit, one visit per doctor.

## 6. C1 / F5 / W1 safety results (PostgreSQL 17, real backend)

* All C1, F5, W1, Phase 2.5 cancel-RPC and Historical-Backlog concurrency suites pass unchanged (see §8).
* Clinical-priority cases (shared + aging, checked in both Node and SQL): aging at 0/9/9:59/10/20/30 minutes gives
  +0/+0/+0/+1/+2/+2; aged Regular vs new Pregnant, PWD, Senior → the protected patient; Indigenous 10 min vs Regular
  30 min → Indigenous; Regular 25 min vs new Indigenous → Regular; Indigenous 20 min vs new Senior → Senior;
  Indigenous 20 min vs new PWD → Indigenous (provisional cap, decision 4); Senior registered after a Regular →
  Senior first.
* I1 suite, shared + aging: three doctors picking up concurrently from three backend instances take exactly the
  three highest WPS-A ranks, one each; 5 rounds of two callers racing for one visit give exactly one assignment;
  W1 Cancel while two other doctors serve releases only the cancelling doctor's counter, bystanders byte-identical;
  a repeated Cancel racing a Requeue and two racing Requeues leave the visit recovered at most once, no pointer to
  it, no row lost (row count unchanged); the patient/counter invariants hold after every scenario.
* Randomized SQL-versus-Node parity (40 rounds, step-edge ages 0 … 120 min, all five services, legacy
  reservations): **0 disagreements** over >300 comparisons; aging changed the head in some rounds.
* Deadlocks (40P01) / lock timeouts (55P03): none observed in any suite.

## 7. Legacy mode compatibility

* `service` mode is the default. With D1, D1-R, WPS-A and D1-A all installed, `service` + aging off still calls C1,
  routes by service and refuses another doctor (D1 suite); `service` + aging on calls WPS-A (I1 four-path test and
  the unchanged WPS-A suite); E2E-1 Tests B/C/D pass unchanged.
* `shared` without D1 → 503; `shared` + aging without D1-A → 503; aging without WPS-A → 503; since `09579e8` also
  `service` without C1 → 503 unless `ALLOW_LEGACY_TWO_STEP_CALL=1` (a database that never had C1; never on Supabase).
  Nothing changes in any refusal. The adviser demonstration (main checkout `a87a4cd`) does not contain this change.

## 8. Full regression

| Suite | Result |
|---|---|
| Backend, all suites incl. PGlite, PostgreSQL 17 and voice launcher (`node --test test/*.test.js`) | **1093 / 1093 pass, 0 skipped** after `09579e8` (1081 / 1081 before it); voice venv installed in the worktree; voice tests use free ports with `--dry-run`, never 8765 |
| Frontend (`node --test test/*.cjs`) | **405 / 405 pass** |
| Production build (`next build`) | success, 14 routes (`09579e8` changes backend files only) |
| Security: `admin123` | the shared fallback removed in `b86bfe0` is an ancestor of this branch; no login path matches `admin123` (the only source hit is the development-memory seed `superadmin123`); neither branch changed `loginUser`; `s2-login-backdoor-postgres.test.js` (admin123 refused for every doctor/admin account) passes |

Logs: `output/i1-integration-20261029/` in the main checkout (backend log, frontend log, build log, evidence JSON);
the run after `09579e8` is in `output/i1-integration-20261029/after-i2-fix/`.

## 9. Updated WPS / WPS-A / WRR comparison (simulation, synthetic)

Re-run with `node simulation/run.js` — 6 scenarios × 3 policies × 2 dispatch modes × 30 seeds, identical patients per
seed for every policy and mode. A new test pins that every policy and mode serves the same patients with the same
service times and the same total doctor time, and that in shared mode no doctor is idle while a patient waits.
Full tables: `output/i1-integration-20261029/simulation/results.md`; compact: `summary-both-modes.md`.

Selected means (minutes):

| Scenario | Mode | WPS avg / max | WPS-A avg / max | WRR avg / max | Regular served before a waiting protected patient (per day) WPS / WPS-A / WRR |
|---|---|---|---|---|---|
| medium-volume | service | 25.9 / 123.2 | 25.9 / 123.2 | 26.0 / 116.0 | 0 / 0 / 1.6 |
| medium-volume | shared | 3.8 / 26.8 | 3.8 / 26.7 | 3.8 / 25.8 | 0 / 0 / 1.9 |
| high-volume | service | 68.5 / 262.1 | 68.5 / 262.0 | 68.7 / 256.2 | 0 / 0 / 4.7 |
| high-volume | shared | 21.6 / 79.1 | 21.5 / 78.3 | 21.5 / 77.9 | 0 / 0 / 5.4 |
| priority-surge | service | 23.9 / 185.0 | 23.9 / 185.0 | 24.0 / 146.8 | 0 / 0 / 5.2 |
| priority-surge | shared | 4.3 / 38.7 | 4.3 / 38.7 | 4.3 / 34.6 | 0 / 0 / 2.8 |
| unequal-workload | service | 104.1 / 305.0 | 104.1 / 304.5 | 104.1 / 304.7 | 0 / 0 / 3.1 |
| unequal-workload | shared | 3.9 / 28.2 | 3.9 / 27.9 | 3.9 / 27.8 | 0 / 0 / 1.7 |

Reading (model only): the dispatch mode dominates — pooling three general doctors cuts waits sharply and evens
utilization (e.g. unequal-workload 0.99/0.26/0.20 → 0.80/0.74/0.64). Within a mode the three policies have nearly
equal average waits and throughput; WRR shortens some maximum waits but serves a Regular ahead of a waiting
Senior/PWD/Pregnant patient several times a day, which WPS and WPS-A never do. WPS-A's lower-score-first decisions
are aged visits passing newer, higher-base ones. A Regular (max 1+2 = 3) never passes a protected patient, but an
Indigenous visit waiting 20+ minutes (2+2 = 4) does precede a newly arrived PWD or Pregnant patient (3); this is a
direct consequence of the provisional cap, pinned by a test, and listed under decision 4.
Caveats: every workload parameter is an assumption (`simulation/scenarios.js`); doctors are assumed identical in
shared mode; the Jain index is over individual waits and falls when most waits are near zero, so it is not
comparable across modes. **These are synthetic model results, not clinical measurements.** WRR stays a research
comparator only; it is not wired into the live queue.

## 10. Outstanding clinical and operational policy decisions

1. Shared queue (D1 Model A) vs separate service queues.
2. Dispatch: Frontdesk selects the doctor (implemented) vs doctor pickup vs automatic assignment.
3. Clinical scope: every doctor for every service, or restrictions per procedure.
4. Aging: adopt WPS-A at all; the 10-minute step, the +2 cap, and "protected category wins ties". Note: with the
   +2 cap an Indigenous patient waiting 20+ minutes is called before a newly arrived PWD or Pregnant patient;
   if protected categories must never be passed, the rule needs a protected-first tier or a lower cap for them.
5. Doctor rights on never-called visits (implemented: Frontdesk/Superadmin only).
6. D1-R Records revision, or accept the filter limitation.
7. Presence requirement for assignment (implemented: signed-in doctors only).
8. F5 history overwrite on Requeue (known, documented in E2E-1; needs a visit-history design).
9. Demo accounts with plaintext passwords on the development project (accepted for development only).

## 11. Hosted deployment prerequisites (development project only)

1. Written approval of decisions 1, 2, 3 and 4 (or a decision to test them provisionally on development).
2. Written approval to install, on the **development** project, the functions for the chosen configuration (§4),
   each with preflight → migration → verify, and rollback scripts at hand. C1 must be present even for `service`
   mode: this branch refuses Calls without it (`09579e8`); do not use `ALLOW_LEGACY_TWO_STEP_CALL` on Supabase.
3. A separate test backend instance with `DOCTOR_DISPATCH_MODE` / `WPS_AGING` set; the adviser-demonstration backend
   keeps the defaults.
4. Synthetic test patients only; no Reset Queues; Historical Backlog left to its separate approval.
5. Re-run the §6 scenarios manually in the browser (login-dependent screens were not exercised in a browser here).

## 12. GO / NO-GO for development Supabase integration testing

**Technically ready: yes.** All automated checks pass (§8), the four Call paths are atomic and agree with the
backend ranking, and both legacy and shared modes are covered on real PostgreSQL 17.
**Operationally: NO-GO until approval.** Hosted testing waits on §11 items 1–2. With those approvals it is a
**GO** for controlled testing on the development project, behind flags, on a separate backend, with synthetic data.
