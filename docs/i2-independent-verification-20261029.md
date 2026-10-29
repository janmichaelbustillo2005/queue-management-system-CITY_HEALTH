# I2 — Independent verification of `integration/d1-wpsa-wrr`

Date: 2026-10-29 · Verified commit: **`bd4a633`** (`origin/integration/d1-wpsa-wrr`, fetched and matched by
SHA `bd4a633e10f5…`). Verification worktree `output/wt-i2-verify`, branch `verify/i2-integration` (adds only
the four I2 test files and this report). The I1 worktree and the integration branch were not modified.
No hosted Supabase write, migration, deployment, merge or Reset Queues. All database work ran on a disposable
PostgreSQL 17.10 cluster (127.0.0.1:55417, `cluster_name = r22-disposable-cancel-verification`), synthetic rows.
Evidence: `output/i2-verification-20261029/` (main checkout; Git-ignored).

## Results

| # | Assignment | Result | Evidence |
|---|---|---|---|
| 1 | Exact integration commit | **PASS**: `bd4a633`, 3 I1 commits on top of the merge `1f8b34a` of D1 `35d312c` + E2E-1 `30490a6` | git |
| 2 | Independent regression | **PASS**: backend **1081/1081** (0 skipped; PG17 + PGlite + voice venv), frontend **405/405**, `next build` OK; with the I2 files **1088/1088**. PG concurrency/priority suites serial **167/167**. Voice launcher **5/5** clean runs | `backend-full*.txt`, `frontend-full.txt`, `pg-serial.txt`, `frontend-build.txt` |
| 3 | 4 configurations (service/shared × aging off/on) | **PASS**: each Call used its own function (`call_patient_visit` / `_wps_a` / `_shared` / `_shared_wps_a`), refused the non-head, called the head; shared mode assigned a consultation to Doctor 3 | `i2-independent-evidence.json` → `matrix` |
| 4 | Node = PostgreSQL = frontend at 10/20-min edges | **PASS**: 10 cases at ±1 ms (20m−1/20m/20m+1, 10m−1/10m/10m+1 and cross-category): `compareWps`, D1-A SQL (head called, other refused) and the rendered Frontdesk table chose the same head every time | `boundaries` |
| 5 | Indigenous/PWD/Pregnant aging scenario | **PASS (behaves as designed) — POLICY RISK**: with aging, Senior → **Indigenous (waited 21 min)** → PWD → Pregnant; without aging Senior → PWD → Pregnant → Indigenous | `indigenousPolicyScenario` |
| 6 | Three doctors, any service, no duplicates | **PASS**: 30 mixed visits (all 5 services), three doctors picking up the head concurrently from three backend instances: 20 lost races refused safely, **0 duplicate assignments**, every visit completed once, consultation/prenatal/maternity served by all three doctors, check-up and FP by two; counters empty, invariants hold | `threeDoctorDrain` |
| 7 | C1/F5/W1 counter ownership, cancel, requeue | **PASS**: C1, W1, F5, Phase 2.5 cancel-RPC, H1, D1, I1, WPS-A and E2E-1 B/C/D suites, run serially (167/167) | `pg-serial.txt` |
| 8 | Legacy C1 non-atomic fallback | **FINDING (Medium)**: see below | `i2-c1-fallback-audit-postgres.test.js` |
| 9 | Simulations | **PASS, reproducible**: rerun of 6 scenarios × 3 policies × 2 modes × 30 seeds is **byte-identical** to I1's `results.json`/`results.md`; simulation tests 7/7 | `simulation/` |
| 10 | D1, D1-R, D1-A (and WPS-A) scripts | **PASS**: from the development project's state (C1/F5/W1 installed) the documented order D1 → D1-R → WPS-A → D1-A passes every preflight and verify; re-running each migration changes nothing; only the 3 new functions and `get_central_records` differ; EXECUTE for `service_role` only; **no row changed**; reverse rollback (each run twice) restores the starting catalog **exactly**; B.2, C1, F5 verifies pass afterwards | `i2-migration-lifecycle-postgres.test.js` |
| 11 | Security | **PASS**: no login path accepts `admin123` (only hit is the dev-memory seed `superadmin123`); both login paths use `passwordMatches`; S2/S3/S4/R1/clock-skew regression tests present and passing; no route added or changed since `83c4943`; public routes unchanged (`/health`, `/auth/login`, `/queue/website`, `/settings`, `/stats`, `/display`, `/geocode`); display-privacy suite passes | `backend-full.txt` |

### Finding 8 — legacy C1 fallback (Medium; recommend fail closed)

In `service` mode with aging off, if `call_patient_visit` answers with any of `PGRST202, PGRST204, 42883, 42703`,
the backend silently uses the old two-statement Call (counter claim, then patient compare-and-set). Reproduced on
PG17 **with C1 installed**: making the function unresolvable for one request (as a stale PostgREST schema cache
would after a migration) → the Call returned 200 through the non-atomic path, with no error or log to the user.
`42703` (undefined column) is also raised from *inside* a function by unrelated schema drift. The other three
paths (WPS-A, D1, D1-A) already refuse with 503.

Recommendation: **fail closed** (503, nothing changed) when C1 is unavailable on a Supabase-backed deployment;
keep the two-step only behind an explicit opt-in (e.g. `ALLOW_LEGACY_TWO_STEP_CALL=1`) for databases that never
had C1, and drop `42703` from the fallback codes for Call. The hosted development project has C1 installed, so
this costs nothing there. This is a backend-only change (no SQL), not made in I2 because the integration
branch must not change; it needs updating the "none installed" fallback tests.

### Policy risk 5 — aging across protected categories

With the provisional +2 cap, an Indigenous Person (2) waiting ≥ 20 min reaches 4 and is called before newly
arrived PWD and Pregnant patients (3), and ties a new Senior (4; the Senior wins by base). A Regular (max 3) never
passes Senior/PWD/Pregnant. If PWD/Pregnant must never be passed by any non-protected category, the rule needs a
protected-first tier or a lower cap for non-protected categories. Decision for the adviser / Health Office.

## Adviser-demonstration environment (read-only investigation)

* **Cause:** the computer was shut down at **13:54** (Windows event 1074, user-initiated via winlogon) and booted
  at **15:13**; it also slept 15:55–16:02. Ports 3000/4000/8765 had been served by preview processes this session
  started at 10:08; they did not survive the shutdown. Last voice health log 13:25. No crash, no code or
  configuration change.
* **Verified demo code:** main checkout `…/queue-management-system-CITY_HEALTH-main`, branch
  `fix/frontdesk-cancel-test-session` @ `a87a4cd` (= accepted H1 code `4b2e77b` + one test-only commit); this is
  what E2E-1 Test A passed on. It does **not** contain the later fixes (S2–S4, R1, …), D1 or WPS-A, by design.
* **Caution:** that checkout has **uncommitted edits by another session** (`frontend/components/QueueTicketActions.js`,
  `frontend/pages/fill-up_form.js`, `frontend/styles/frontdesk-registration.css`, two ticket tests). A dev
  frontend started there serves them. Decide whether to keep them before restarting the demo.
* **Startup (from the main checkout, two terminals; backend starts the voice service on 8765):**
  `npm --prefix backend start` (port 4000) and `npm --prefix frontend run dev` (port 3000). Keep the existing
  `backend/.env` (no `DOCTOR_DISPATCH_MODE` / `WPS_AGING` — those variables do not exist on that branch).
  Not restarted by I2.

## Blocking issues for next week's acceptance testing

None in the integrated code. To run acceptance tests on hosted development, these are prerequisites, not defects:
policy decisions (queue model, dispatch, clinical scope, aging cap incl. risk 5), written approval to install the
chosen functions, a separate test backend with the flags, and the demo restart decision above. Finding 8 should be
fixed before acceptance testing in `service` mode on a Supabase project.

## GO / NO-GO

**Technical: GO** for controlled testing on the **development** Supabase project, limited to a separate test
backend, synthetic patients and the install order verified here (preflight → migration → verify, rollback ready).
**Operational: NO-GO until** (a) written approval of the policy decisions and of installing the specific functions,
and (b) ideally Finding 8 fixed (fail closed) on top of `bd4a633`. Production: NO-GO.
