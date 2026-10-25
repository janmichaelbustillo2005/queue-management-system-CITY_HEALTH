# C1 — Atomic Call Verification (2026-10-25)

Status: **fixed locally. A versioned SQL function is prepared and verified on disposable PostgreSQL; it is NOT INSTALLED.**
Branch `main`, HEAD `09d3d1f`. No Supabase project was touched, and no real patient rows were used.

## 1. Defect and root cause

Call ran as two separate PostgREST statements:

1. Claim: `counters.current_patient_id = P WHERE current_patient_id IS NULL AND is_online`.
2. Serve: `patients SET status='serving', counter_id, called_at WHERE status='waiting' AND counter_id IS NULL AND service_type AND completed_at IS NULL`.

Statement 2 did not check `visit_state_revision`. If a Cancel committed between the two statements (releasing the claim) and a
Requeue or Undo then committed (status back to `waiting`, `counter_id` NULL), the visit still matched statement 2. That is an ABA
problem. The result was a **serving visit on Doctor N whose counter was NULL**, along with a pending acceptance and an SMS for a call
that had no counter. Separately, `/queue/call` authorized the caller from token claims only. Every other visit action had validated
the persisted account since R2.

## 2. Before / after (same deterministic scenario, synthetic rows)

| Scenario | Before (`09d3d1f`) | After |
|---|---|---|
| Call vs Cancel + Requeue inside Call's window | 200; serving on Doctor 3, **counter NULL**; awaiting-accept set; 1 SMS | 400 "no longer eligible"; waiting; counter NULL; no acceptance state or SMS |
| Call vs Cancel + Undo inside the window | same corruption | same safe refusal |
| Same scenario as raw SQL on PG17 | legacy statements reproduce it | revision-guarded fallback: 0 rows; RPC: `40001` |
| Call with a token/account mismatch (6 cases)¹ | 200, patient serving | 403, unchanged, no write attempted |

¹ In production, the JWT signature and Phase A `validate_staff_auth_session` already reject most of these. The change gives Call the
same persisted-account check as Cancel, Recall, Requeue and Undo, and the RPC re-checks the account under lock at write time.

## 3. Fix

**Backend (`queueService.callPatient`, `/queue/call`)**

* The route passes `req.user`. Call loads the persisted account through `loadCancellationContext` and `resolveCancelActor`, the same
  R2 helpers the other actions use. A doctor account may call only for its own persisted doctor (403 otherwise). Frontdesk (with no
  assignment or the legacy "Front Desk" label) and Superadmin keep cross-doctor calling. All existing 400/403 messages are kept.
* The existing pre-checks and WPS ranking still run first, so the error messages are unchanged. Then:
  * **migration installed:** `call_patient_visit` performs the whole transition (§4);
  * **not installed (PGRST202/42883):** the existing two-step runs with **`visit_state_revision` added to the patient CAS**. This closes
    the ABA. Its compensating release and lost-response recovery are unchanged.
* `markAwaitingAccept` and the SMS run only after a confirmed transition. A rejected call (400/403/404/409), a lost response, an
  error without a code, or an unconfirmed result row (503) produce no acceptance state, SMS or voice event, and leave any existing
  acceptance untouched. The voice announcement still happens at doctor Accept (Phase 2.2 behavior is unchanged).
* Development memory mode now rotates `visit_state_revision` on Call, like its other mutations.

**Database (`backend/scripts/20261025-c1-atomic-call.sql`).** One new function,
`call_patient_visit(p_patient_id, p_doctor_name, p_user_id_num, p_expected_revision, p_queue_start, p_queue_end)`,
declared `SECURITY DEFINER`, `search_path=''`, `lock_timeout=5s`, with EXECUTE granted to `service_role` only. In one transaction it:

1. takes the staff account `FOR SHARE` and re-checks role and doctor assignment (aliases as in `start_patient_consultation`);
2. locks **all counters ascending by id** `FOR UPDATE`, then the **patient** `FOR UPDATE`;
3. requires the expected revision (otherwise `40001`), `waiting`, no `completed_at`, the service mapped to the doctor, and no
   conflicting `counter_id`;
4. requires the counter to exist, be online, and be empty (or hold this visit's legacy Phase 2.1 reservation), no other counter to point
   at the visit, and no other serving visit (including legacy unassigned ones) for the doctor;
5. re-ranks WPS under the locks: `priority_score DESC`, `created_at` truncated to milliseconds (as `compareWaitingPriority` compares),
   then `id`, over the backend's business-day window;
6. writes patient and counter, checks row counts and post-conditions, and raises (rolling back both writes) on any mismatch.

It adds no columns, triggers or RLS changes, does not update rows at install, and does not change `recover_patient_visit`,
`undo_patient_visit_waiting`, Start/Complete, F5, Phase B.2 or the No-show enum (the verify script pins their source hashes).

Lock order `users FOR SHARE → all counters → patient` matches Undo, F5 Requeue and the proposed atomic Cancel. Start/Complete lock one
counter and then the patient. Because no path holds a patient lock while it waits on a counter, no cycle is possible (no `40P01` in
7,500 soak operations).

## 4. Invariants (asserted on every committed state in tests)

After a successful Call: the visit is `serving` with `counter_id = Doctor N` and `called_at` set; counter N points at it; no other
counter points at it; its revision has changed; `created_at` (queue position) is unchanged. After a refused Call: patient and counter rows
are byte-for-byte unchanged, with no new acceptance, SMS or voice event. At every committed state, every counter pointer refers to a
serving visit assigned to that counter, and every assigned serving visit has exactly its own counter's pointer.

## 5. WPS and authorization preserved

No weights, scores, routing or tie rules changed. `getDoctorForService` is mirrored by one CASE expression that appears three times in
the SQL. A test checks that all three copies are identical and that their output equals the JavaScript function for known, legacy
(dental/laboratory → Doctor 1) and unknown services.

## 6. Verification

Environments: the mock-Supabase harness (`database.callRpcInstalled` opts in to an emulated RPC; absent by default, as with F5);
PGlite 0.3.15; disposable PostgreSQL 17.5 (`embedded-postgres` in a temporary directory, loopback only,
`cluster_name = r22-disposable-cancel-verification`, one fresh database per suite, dropped afterwards).

| Suite | Tests | Pass | Fail | Skip |
|---|---|---|---|---|
| `c1-atomic-call.test.js` (service/route, fallback + RPC) | 14 | 14 | 0 | 0 |
| `c1-atomic-call-concurrency.test.js` (PG17, independent connections) | 21 | 21 | 0 | 0 |
| F5 (eligibility, PGlite, PG17) | 58 | 58 | 0 | 0 |
| Phase 2.1 / 2.2 recovery | 182 | 182 | 0 | 0 |
| Phase 2 consultation | 98 | 98 | 0 | 0 |
| Auth / role authorization (A7, Phase A, R2, R2.1, S1, Records) | 262 | 262 | 0 | 0 |
| Default `npm test` | 613 | 608 | 0 | 5 |
| With PGlite + PG17 | 901 | 900 | 1 | 0 |

Baseline before the change: 599 / 593 / 1 / 5 and 866 / 865 / 1 / 0. The single failure is the intermittent
`voice-service-launcher.test.js` probe ("unresponsive" vs "absent" after `stop()`). It failed 3 of 3 isolated runs and passed once in
the default run. It is unrelated to C1 and is tracked separately.

The PG17 suite covers the following. Lock waits were confirmed through `pg_stat_activity` before each release.

* Call vs Cancel, in both orders;
* Call vs Cancel then Requeue, with the Requeue in flight;
* the Undo ABA;
* Call waiting for an in-flight Complete, then succeeding;
* busy doctor and legacy orphan serving visit;
* two Calls for one patient, plus a duplicate retry;
* two patients contending for one counter;
* WPS order, millisecond ties and day window;
* offline counter, and an offline toggle in flight;
* forged users, doctors, counters, revision and window;
* an account reassigned mid-call;
* legacy Phase 2.1 reservation;
* `lock_timeout` returns `55P03` with nothing committed;
* catalog properties and privileges;
* the preflight and verify scripts;
* a randomized Call/Cancel/Requeue/Undo/Start/Complete soak with consistency sampled while it runs. Five seeds × 1,500 operations:
  0 deadlocks, 0 lock timeouts, 1,056 mid-run samples, all consistent.

## 7. Remaining dependencies (not changed by C1)

* **Cancel's two-step release (Phase 2.5).** The backend Cancel commits the patient, then releases counters by patient id in a separate
  statement. If a Requeue and a new valid Call both commit between those two statements, the delayed release clears the new
  assignment. A pinned PG17 test reproduces this, and shows that an atomic Cancel (counters locked, CAS and release in one transaction)
  cannot produce it. The fix is the reviewed `cancel_patient_visit` proposal (rev2). Its lock order is compatible with C1.
* **N1 (No-show).** It has the same delayed-release shape and stays inactive (enum not installed).
* **`clearTodaysQueues`.** It releases counters in storage order and can deadlock with any id-ordered locker. PostgreSQL aborts one side
  (`40P01` → 503) and nothing partial is committed. This exposure is shared with Undo and Requeue.
* **Session validation inside the RPC.** It is not repeated there. Express validates the Phase A session, and the RPC validates the
  persisted account, as Start and Complete do. Moving session checks into the transaction is the Cancel proposal's open decision D3.
* **Lost response after commit.** Reported as 503 "could not confirm". The visit is serving without an acceptance entry, and the doctor
  accepts it through the existing legacy-accept path. Refreshing the queue shows the true state.
* **Trusted in-process callers.** Once installed, the RPC requires a staff id. The only production caller (the route) always passes one.
* **The F5 audit test "known C1 gap"** still passes because it runs the legacy SQL statements directly. It documents pre-fix behavior;
  the C1 suites cover the fix.

## 8. Installation plan (requires separate written approval)

1. On the development project, run `20261025-c1-preflight.sql` (READ ONLY): 19 PASS rows are expected. Review its consistency
   inventory, which contains counts only.
2. Deploy nothing first. The current backend uses the function when present and the revision-guarded fallback otherwise.
3. Run `20261025-c1-atomic-call.sql`. It is a single transaction and adds one function.
4. Run `20261025-c1-verify.sql` (READ ONLY): 14 PASS rows are expected. This includes source hashes for C1, `recover_patient_visit`,
   `undo_patient_visit_waiting` and `complete_patient_consultation`.
5. Smoke test with synthetic visits only: Call → Accept → Start → Complete for each doctor; a stale Call after Cancel + Requeue should
   return 409.

Rollback (no data change): `DROP FUNCTION public.call_patient_visit(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ);`
The backend then returns to the revision-guarded fallback automatically.
