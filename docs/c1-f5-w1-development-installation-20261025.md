# C1 + F5 + W1: development installation guide (2026-10-25)

**Status: prepared, not executed.** No SQL in this guide has been run against any Supabase project. Installing it on the
development project is a **separate approval step**. Get written approval for that step before starting. Approval covers the
development project only. No production deployment is planned; this is a Capstone 2 prototype for controlled on-site testing.

This guide installs three reviewed functions on the development/testing database, in this order:

| Step | Migration | Adds | Fixes |
|---|---|---|---|
| 1 | **C1** atomic Call: `20261025-c1-atomic-call.sql` | `call_patient_visit(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)` | A Cancel + Requeue/Undo between Call's two statements left a serving visit without its counter. |
| 2 | **F5** safe Requeue: `20261022-f5-requeue-terminal-recovery.sql` | `requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)` | Requeue only finished visits, and release a stale counter pointer to the visit in the same transaction. |
| 3 | **W1** atomic Cancel: `20261025-w1-atomic-cancel.sql` | `cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)` and the internal helper `qms_resolve_doctor_counter(TEXT)` | Cancel committed the patient, then released the counter separately; a Requeue + Call in between lost the new call's counter. |

Each migration adds functions only. It does not write any patient, counter, user or session row. It does not change grants
on existing tables, triggers, RLS, or any installed function: it does not touch Phase 2, Phase A, Phase 2.1, Phase 2.2 or
Phase B.2. Each function is `SECURITY DEFINER`, uses `search_path = ''`, and is owned by `postgres`. EXECUTE is granted to
`service_role` only (none for the helper); `PUBLIC`, `anon` and `authenticated` get nothing.

**Not part of this installation:** No-show stays inactive (`20261023-no-show-enum.sql` is **not** run). N1, Weighted-Priority
Scheduling, demo accounts and Phase B.2 are unchanged.

## 1. Why this order, and what each partial state means

The three migrations are independent: none calls another, and the scripts register no catalog dependencies between them. They
can be installed in any order. The proposed order C1 → F5 → W1 was rehearsed exactly (§9). Each intermediate state is safe:
the backend detects which functions exist (PostgREST `PGRST202`) and falls back safely for the rest.

| State | Call | Cancel | Requeue |
|---|---|---|---|
| None (today) | Revision-guarded two-step fallback | Waiting visits only; a serving visit, or any visit a counter points at, gets **503** "needs the W1 database migration … Nothing was changed" | Via `recover_patient_visit`; a visit a counter still points at gets **503** |
| After C1 | Atomic | Same as today | Same as today |
| After C1 + F5 | Atomic | Same as today | Atomic; stale pointers released |
| After C1 + F5 + W1 | Atomic | Atomic (waiting, called, in consultation) | Atomic |

Lock order is compatible with what is installed. C1 and W1 take the account (`FOR SHARE`), then all counters by id, then the
patient. F5 takes all counters by id, then the account (`FOR SHARE`, inside Phase 2.2's `recover_patient_visit`), then the patient.
Start/Complete take one counter, then the patient. No path holds a patient while waiting for a counter. F5's
counters-then-account order was tested against W1 plus a concurrent account update on the same row: no deadlock (§9).

## 2. Recovery arrangements (before anything else)

1. **Backup point.** Dashboard → Database → Backups: note the time of the latest backup. If the plan has no scheduled backups,
   take a manual `pg_dump` of the `public` schema with the project's connection string. Store the dump privately: it contains
   patient data. Never put it in the repository or a shared chat.
2. **Function snapshot.** In the SQL Editor run this read-only query, then export and keep the result:
   ```sql
   SELECT p.oid::regprocedure AS function, md5(replace(p.prosrc, E'\r\n', E'\n')) AS body_md5,
          pg_get_userbyid(p.proowner) AS owner
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' ORDER BY 1;
   ```
3. **Primary recovery is the rollback scripts** (§7): the migrations change no data, so dropping the new functions restores the
   previous behavior. The backup covers the unexpected case only.
4. Have the three rollback files open and reviewed before you start.

## 3. Pre-installation checklist

Development project: **`uvmpbgpvmjkfoblrfrdt` ("CCHOFPC Queuing System")**, as recorded in `phase-b2-records-installation.md` §9a.

| # | Check | How |
|---|---|---|
| 1 | Correct project | The SQL Editor URL is `supabase.com/dashboard/project/uvmpbgpvmjkfoblrfrdt/sql`, and the host in `backend/.env` `SUPABASE_URL` is `uvmpbgpvmjkfoblrfrdt.supabase.co`. Compare them without printing or pasting the key. **Any other project: stop.** |
| 2 | Expected starting state | Phase B.2 is installed: `20261023-phase-b2-verify.sql` returns "Phase B.2 verification passed; all synthetic fixtures are rolled back". C1/F5/W1 are absent (each preflight confirms it). |
| 3 | Approval recorded | Written approval for "install C1, F5, W1 on the development project". |
| 4 | Quiet window | No clinic activity and no staff signed in. Every Call/Cancel/Requeue and the W1/F5 verify scripts lock all counters for a few milliseconds. |
| 5 | Backend stopped | Stop the backend (`Ctrl+C` in its terminal) so no request runs during installation. It is not strictly required, but it keeps the steps unambiguous. |
| 6 | Recovery ready | §2 done; backup time noted; rollback files reviewed. |
| 7 | Files are the reviewed ones | Run each file **whole**, from this commit, without editing it. The verify scripts fingerprint the installed bodies; an edited file fails them. |
| 8 | Role | The SQL Editor runs as `postgres` (the preflights check this). |

**Note on the SQL Editor:** when you run a whole file, the Editor shows only the **last** result set. Each preflight's first
statement is an inventory of aggregate counts, with no patient identifiers. To see it, select just the first `SELECT … UNION ALL …`
statement and use *Run selected*, then run the whole file.

## 4. Installation steps

Run each step only after the previous one has passed. Export each result (CSV) and keep it with the approval record.

### Step 1: C1

| | File | Expected result |
|---|---|---|
| 1a | `backend/scripts/20261025-c1-preflight.sql` | **19 rows, all `passed = true`, `failed_count = 0`, `all_pass = true`.** Inventory (5 conditions): ideally all 0. |
| 1b | `backend/scripts/20261025-c1-atomic-call.sql` | "Success. No rows returned". One transaction, adds one function. |
| 1c | `backend/scripts/20261025-c1-verify.sql` | **14 rows, all pass.** Rows 11–14 pin the C1 body and confirm the Phase 2/2.2 bodies are unchanged. Read-only. |

### Step 2: F5

| | File | Expected result |
|---|---|---|
| 2a | `backend/scripts/20261025-f5-preflight.sql` | **22 rows, all pass.** Inventory (4 conditions): stale pointers to cancelled/no-show/completed visits, pointers to waiting visits, legacy completed visits without a start, and the no-show label (expected **0** on development). |
| 2b | `backend/scripts/20261022-f5-requeue-terminal-recovery.sql` | "Success. No rows returned". Adds one function. |
| 2c | `backend/scripts/20261025-f5-verify.sql` | **17 rows, all pass.** It first runs a behavioral check on synthetic `F5V` rows and **rolls everything back**; only identity-sequence values are consumed (gaps in ids). |

### Step 3: W1

| | File | Expected result |
|---|---|---|
| 3a | `backend/scripts/20261025-w1-preflight.sql` | **28 rows, all pass.** Inventory (6 conditions), including the no-show label (expected **0**). |
| 3b | `backend/scripts/20261025-w1-atomic-cancel.sql` | "Success. No rows returned". Adds two functions. |
| 3c | `backend/scripts/20261025-w1-verify.sql` | **One row: "W1 verification passed".** Synthetic `W1V` rows, rolled back. |

### Step 4: combined state

Re-run `20261025-c1-verify.sql` (14 pass), `20261025-f5-verify.sql` (17 pass), `20261025-w1-verify.sql` (passed) and
`20261023-phase-b2-verify.sql` (passed). This confirms that no later step altered an earlier one, and that Phase B.2 is intact.

## 5. Stop conditions

Stop, do not continue to the next step, and keep the output if any of these happens:

* **Wrong project**, or any doubt about which project the Editor is connected to.
* **A preflight row with `passed = false`**, or a row count different from 19 / 22 / 28. Do not install that step.
* **A non-zero inventory count.** It does not make installation unsafe (the functions never repair existing rows), but review it
  with the Health Office before testing. A non-zero "stale pointer" count is expected to be repaired later by Requeue (F5) or a
  repeat Cancel (W1).
* **Any error while running a migration file.** The file is one transaction, so nothing was installed. Do not edit it or run
  parts of it. A `lock timeout` (`55P03`) means something was busy: wait for a quiet moment and run it once more. Anything else
  (for example `must be owner`, `permission denied`, `does not exist`): stop and report.
* **A failed verification.** That step is installed but unverified. Run that step's rollback (§7), confirm it reports success,
  and stop.
* **A "destructive operation" warning from the Editor during installation.** The install files contain no `DROP`, so a warning
  means the wrong file is open. Only the rollback files drop anything.
* **Unexpected browser behavior in §6.** Do not "fix" data by hand. Roll back the step that introduced the behavior, then report.

## 6. After installation: restart and real-browser testing

1. **Restart the backend** (`npm start` in `backend/`). No configuration change is needed: the backend calls the new functions
   automatically. Restarting clears in-process state (the call guard, local fallback mode) and confirms that the backend is
   connected to Supabase rather than local fallback mode. `http://localhost:4000/api/health` should return 200.
2. **Schema reload.** Each migration ends with `NOTIFY pgrst, 'reload schema'`. If the app still behaves as if a function
   were missing about 10 s after installation, run `NOTIFY pgrst, 'reload schema';` once. For example, cancelling a *called*
   patient still says "needs the W1 database migration".
3. **Existing sessions keep working.** Sessions and accounts are not touched. Signed-in users stay signed in, and demo
   logins are unchanged.

Use **synthetic patients only**, with names starting with `TEST`, and no real names, birthdates or PhilHealth numbers. Test on a
desktop browser and on a phone-width window. Sign in with the existing demonstration accounts: frontdesk, `admin1`–`admin3`
and Superadmin.

| # | Action | Expected |
|---|---|---|
| 1 | Register `TEST GP regular`, then `TEST GP senior` (Senior flag), then `TEST FP` | Each appears in Waiting; the senior is ranked first for Doctor 1. |
| 2 | Call `TEST GP regular` | Refused: "Call the next eligible patient … according to queue priority". |
| 3 | Call `TEST GP senior`, then call `TEST FP` from `admin3` | Both serving. The display shows them waiting for acceptance. **No voice yet.** |
| 4 | `admin1` Accept → Start → Complete `TEST GP senior` | The voice announcement plays **once** on Accept. Records shows the call, start and completion times; the call time is unchanged by Start. |
| 5 | Call `TEST GP regular`, then Cancel it (reason "test") | Cancelled; Doctor 1 becomes free immediately. No voice and no SMS. |
| 6 | Cancel `TEST FP` while in consultation (`admin3`: Accept, Start, then Cancel) | Cancelled; Doctor 3 is free; Records keeps its start time. |
| 7 | Re-queue `TEST GP regular` | Back in Waiting, at the end of its priority tier; it can be called again. |
| 8 | `admin1` tries to cancel or call a Doctor 3 patient | Refused (Cancel 403; Call 400 "assigned to Doctor 3"); nothing changes. |
| 9 | Two tabs: cancel a called patient in tab A, then cancel it again in tab B without refreshing | Tab B: "already cancelled" or "changed; refresh". Never a second change. |
| 10 | Sign out in tab A, then act in tab B with the same account | Tab B is asked to sign in again (401). |
| 11 | Superadmin sets Doctor 3 offline; try to call or register an FP patient | Refused (offline); turn Doctor 3 back on afterwards. |
| 12 | Records → Patients / Staff / User Accounts | All load exactly as before (Phase B.2 unchanged). |

Leave the `TEST` visits in place as history. Do not delete rows.

## 7. Rollback (each needs its own approval)

Rollback files:
* C1: `backend/scripts/20261025-c1-rollback.sql`
* F5: `backend/scripts/20261025-f5-rollback.sql`
* W1: `backend/scripts/20261025-w1-rollback.sql`

Each file runs in one transaction with a 5 s lock timeout. It names the **exact signature** and first checks the catalog. It
**refuses, and drops nothing,** if any object depends on the function or any other function body calls it. It never uses
`CASCADE`, writes no data, and reloads the PostgREST schema. Running it a second time reports "not installed" and changes nothing.
W1's rollback drops `cancel_patient_visit` first, then its helper.

| Roll back | Backend afterwards (no redeploy needed) | Unaffected |
|---|---|---|
| W1 only | Cancel fails closed again: waiting visits cancel; serving visits, or any visit a counter points at, get 503 | C1, F5, B.2, sessions, data |
| F5 only | Requeue uses `recover_patient_visit`; a visit a counter points at gets 503 | C1, W1, B.2, sessions, data |
| C1 only | Call uses the revision-guarded two-step fallback | F5, W1, B.2, sessions, data |

To remove all three, run them in reverse order (W1, F5, C1). Any order works. After a rollback, re-run that step's preflight: it
must pass again, which means the database is back in a clean pre-installation state. Restart the backend. Never write
`DROP FUNCTION` by hand: an inexact signature either fails (`42883`) or could match a different overload.

## 8. Known limitations and open risks (not changed by this installation)

* **`clearTodaysQueues` (Superadmin "Reset queues").** It archives visits with one statement per visit, then releases counters with
  one `UPDATE … WHERE current_patient_id IN (…)`. That statement locks counter rows in heap order, not id order, so it can
  deadlock with any concurrent Call, Cancel, Requeue or Undo (`40P01`). This was reproduced on PG17. When the Reset is the deadlock
  victim, it answers 500 *after* the visits were archived, which leaves stale counter pointers (every doctor appears busy). The
  archive step also has the same two-statement shape that W1 fixed for Cancel. **Mitigation until it is fixed:** use Reset only
  when no one is calling or cancelling. With F5/W1 installed, the stale pointers are repaired by a Re-queue or a repeat Cancel
  of each archived visit; without them, both answer 503.
* **N1 / No-show** still uses a two-step write and stays disabled; the enum label is not installed.
* **Voice launcher on Windows.** `stop()` kills the venv `python.exe` stub; the real interpreter is a separate child process that
  exits about 35–40 ms later. A start immediately after a stop can therefore see the port as "unresponsive". This is the cause of the
  one failing `voice-service-launcher` test.
* **Login.** `loginUser` accepts `admin123` for any account whose id starts with `admin`, whatever its stored password. This
  is pre-existing demo behavior and was not changed. It must be removed before any deployment beyond controlled testing.
* **Status codes.** A doctor calling another doctor's patient gets **400** ("This patient is assigned to Doctor N"), not 403.
  The Node pre-check answers an account mismatch on Cancel with 403, while W1's own check inside the transaction answers 401.
  Both refusals change nothing.
* **F5 policy pending.** A legacy completed visit without a consultation start is still re-queueable, which is existing
  behavior awaiting a Health Office decision.
* **Rehearsal scope.** The rehearsal used real PostgreSQL 17 with Supabase-like roles. The backend reached it through a
  PostgREST-equivalent test adapter, not hosted PostgREST, and the schema is the "known" model of the development project, not
  a full dump. The first run against hosted PostgREST is §6.

## 9. Verification evidence (disposable PostgreSQL 17.10, loopback only, synthetic data)

The rehearsal installed the exact files, in the order above, as a non-superuser `postgres` owner. The schema was the
development project's known schema (`test/helpers/liveKnownSchema.js`: no `no-show` label) after Phase 2, A, 2.1, 2.2 and B.2.

* `test/c1-f5-w1-installation-sequence.test.js` (12 tests). Covers:
  * each preflight → migration → verify step;
  * privileges and owner;
  * "nothing persisted" snapshots;
  * earlier steps re-verified after later ones;
  * the combined state, plus Phase B.2 verify;
  * idempotent re-run of each migration;
  * catalog dependencies;
  * a failed inexact `DROP`;
  * a rollback refusing because of a caller;
  * each single rollback, with data, sessions, other migrations and B.2 unchanged, a token still valid, the preflight passing
    again, and a clean reinstall.
* `test/c1-f5-w1-backend-workflow.test.js` (24 tests). The **real** routes, JWT middleware, Phase A sessions and `queueService`
  ran against the installed SQL through `test/helpers/pgBackendHarness.js`:
  * the full workflow, with timestamps preserved;
  * Weighted-Priority order and service mapping;
  * Cancel while waiting, called and in consultation;
  * Requeue and re-Call;
  * stale-pointer repair;
  * duplicate requests across two backend instances;
  * forged, logged-out and revoked sessions, including revocation and reassignment *between* the middleware check and the
    function;
  * cross-doctor refusals;
  * counter availability;
  * races on real row locks in both orders: Call vs Cancel, repeat Cancel vs Requeue, Cancel vs Requeue, Requeue vs Call with a
    priority change;
  * F5 lock order vs W1 plus an account update;
  * no SMS, acceptance or voice event after any refused or lost transition;
  * functions absent (fallbacks, fail-closed 503s, a stale revision rejected by the Call fallback with its claim released,
    messages distinguishing a missing migration from an invalid state);
  * both partial states.
* Both suites passed 5 of 5 consecutive runs.

| Run | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Default `npm test` (no database) | 625 | 619 | 1 | 5 |
| All suites, PGlite + PG17 | 972 | 971 | 1 | 0 |
| C1 / F5 / W1 suites | 35 / 58 / 33 | all | 0 | 0 |
| Phase 2.5 cancel RPC (PGlite + PG17) | 86 | 86 | 0 | 0 |
| PGlite database suites | 221 | 221 | 0 | 0 |
| Auth, session and authorization suites | 238 | 238 | 0 | 0 |

The single failure in both full runs is `voice-service-launcher.test.js` (§8), which is unrelated.

To repeat the rehearsal (PowerShell; a disposable loopback cluster named `r22-disposable-cancel-verification`, never Supabase):

```powershell
$env:PHASE25_PG_URL = 'postgres://<user>:<password>@127.0.0.1:<port>/postgres'
$env:PHASE25_PG_MODULE = '<path>/node_modules/pg'
$env:PHASE2_PGLITE_MODULE = '<repo>/output/phase22-final-audit-20261021/pglite/node_modules/@electric-sql/pglite'
node --test test/c1-f5-w1-installation-sequence.test.js test/c1-f5-w1-backend-workflow.test.js
```
