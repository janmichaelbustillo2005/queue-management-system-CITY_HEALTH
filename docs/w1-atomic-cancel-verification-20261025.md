# W1 — Atomic Cancel Verification (2026-10-25)

Status: **fixed locally. A versioned SQL function is prepared and verified on disposable PostgreSQL; it is NOT INSTALLED.**
Branch `main`, HEAD `09d3d1f`, on top of the uncommitted C1 work. No Supabase project was touched, and no real patient rows were used.

## 1. Defect and root cause

Cancel ran as two separate PostgREST statements:

1. Patient: `status='cancelled', completed_at, reason WHERE id AND status AND visit_state_revision` (compare-and-set).
2. Counter: `current_patient_id = NULL WHERE current_patient_id = P` (`clearCounterAssignment`).

Statement 2 identified the counter only by patient id and was not tied to the transition statement 1 made. If other operators
re-activated the **same visit** between the two statements (a Requeue or Undo moves it back to `waiting`, then a valid Call puts it on
a doctor again), the delayed statement 2 matched the new assignment and cleared it. The result was a serving visit with no counter
pointer, so the doctor appears free while a patient is still assigned. The route then also cleared that new call's pending
acceptance, because `clearAwaitingAccept` ran after the delayed release.

The window is reachable on the development project **today** through Phase 2.2 Undo (`undo_patient_visit_waiting` is installed and
releases pointers itself). F5 Requeue would add a second path once installed.

## 2. Before / after (disposable PostgreSQL 17, synthetic visit P8, Doctor 3)

| Step | Before (two-step Cancel) | After (`cancel_patient_visit`) |
|---|---|---|
| P8 called | serving, Doctor 3, pointer Doctor 3 | serving, Doctor 3, pointer Doctor 3 |
| Cancel | patient committed (`cancelled`, revision rotated); **pointer still Doctor 3** | transaction open: other sessions still see serving + pointer; a Call with the old snapshot waits on the lock |
| Cancel completes | — | patient `cancelled` **and** pointer NULL in one commit; the waiting Call gets `40001` |
| Requeue (F5) / Undo | waiting, pointer NULL | waiting, pointer NULL |
| Call (C1) | serving, Doctor 3, pointer Doctor 3 | serving, Doctor 3, pointer Doctor 3 |
| Old Cancel resumes / is replayed | delayed release clears it: **serving, Doctor 3, pointer NULL** | replay with its serving or cancelled snapshot → `40001`, nothing written |

Before is reproduced with F5 + C1 installed, and separately with Undo. After was run with W1 + F5 + C1 installed. Revisions, timestamps
and reasons for each step are printed by `w1-atomic-cancel-concurrency.test.js` (`# before:` / `# after:` diagnostics).

## 3. Existing proposal assessment

`docs/phase25-cancel-atomicity-proposal-rev2.md` (kept unchanged as history) already had the right design, and its draft SQL was
covered by 86 PGlite/PG17 tests. W1 turns it into `backend/scripts/20261025-w1-atomic-cancel.sql` with these changes:

* **401 vs 403 correction.** The draft raised `42501` (→ 403) for a revoked, expired or mismatched session and for an account that
  no longer matches the token. The Phase A middleware answers the same conditions with 401, which signs the browser out
  (`frontend/lib/api.js`). These now raise `28000` → **401**. `42501` → 403 is kept for a valid account without permission
  (cross-doctor, unassigned doctor).
* Decisions applied, as the task specifies: fail closed when the function is absent (D2), session re-validated inside the transaction
  (D3), completed stays 400 (D4), service mapping in SQL with a parity test (D5), and a 1000-character reason limit (D6, also enforced by
  the route).
* The rev2 PGlite and PG17 suites now install the migration file instead of the document block. Only the 27 session/account
  assertions changed (`42501` → `28000`).

## 4. Transaction design

`cancel_patient_visit(p_patient_id, p_session_id, p_user_id_num, p_role, p_doctor_name, p_expected_revision, p_expected_status,
p_reason, p_requested_counter)`, `SECURITY DEFINER`, `search_path=''`, `lock_timeout=5s`, owner `postgres`, EXECUTE for
`service_role` only. Internal helper `qms_resolve_doctor_counter(text)`: no API role may execute it.

1. Arguments; reason required, trimmed, ≤ 1000 characters (`22023`).
2. `users` row `FOR SHARE`, then `staff_auth_sessions` row `FOR SHARE`. Account role and doctor must equal the token's; the session must
   exist, belong to the account, carry the same claims, and be neither revoked nor expired (`28000`). A logout or account change waits
   for this transaction.
3. **All counters ascending by id `FOR UPDATE`**, then the **patient `FOR UPDATE`**.
4. Actor (Superadmin / Frontdesk / doctor) and owner come from persisted rows only. A doctor may cancel only its own visit (`42501`).
   A requested doctor is a consistency check (`22023` / `QM003`) and is written only to a blank `counter_id` that it owns.
5. Snapshot: revision and status must equal what Node authorized (`40001`).
6. Eligibility (unchanged policy): `waiting` and `serving` (called or in consultation) are cancelled. `completed` → `QM001` (400),
   `no-show` → `QM002` (409, undo first). `cancelled` is an idempotent repeat: no patient write, and any stale pointer to it is released
   under the same locks.
7. One patient update (`status`, `completed_at = clock_timestamp()`, `reason`) and one release `WHERE current_patient_id = P`, both
   under the locks. `called_at`, `consultation_started_at` and `created_at` are never modified. Row counts and post-conditions are
   checked (`QM500`, which rolls everything back).

Because the counters are locked and the visit's revision is compared before the release, the release can only ever clear pointers to
the visit in the state this call authorized. A later Requeue + Call cannot interleave.

**Lock order.** C1 Call takes users, all counters, then the patient. F5 Requeue and Phase 2.2 Undo take all counters, then the patient.
Start and Complete take one counter, then the patient. Heartbeat takes users, then the session `FOR UPDATE`. Logout takes the session.
No path holds a patient lock while waiting for a counter, so no cycle can form; this was confirmed under load (§7).

## 5. Backend behavior (`queueService.performCancellation`, `/queue/cancel`)

* `authorizeVisitAction` still runs first, so existing 403/404/409/400 messages are unchanged. The RPC is authoritative.
* **Installed:** a single RPC call with `req.user.jti`, `id_num`, `role` and `doctor_name`, plus the authorized revision, status, reason
  and requested doctor. Success is reported only when the returned row is this visit, is `cancelled`, and its revision changed (new
  cancel) or stayed the same (repeat). Anything else is 503 "Could not confirm the cancellation".

  | SQLSTATE | HTTP |
  |---|---|
  | `22023` | 400 |
  | `28000` | 401 |
  | `42501` | 403 |
  | `P0002` | 404 |
  | `40001` | 409 |
  | `QM001` | 400 |
  | `QM002`, `QM003` | 409 |
  | `QM500`, `40P01`, `55P03`, `57014`, `53xxx`, `08xxx`, any other | 503 "nothing was changed" |
  | no code or transport error | 503 "could not confirm" |
* **Not installed (fail closed):** only a `waiting` visit that no counter points at is cancelled, by the existing single compare-and-set.
  It writes no counter, so it is W1-safe. A serving visit, a waiting visit holding a legacy reservation, or a cancelled visit with a
  stale pointer returns **503** "needs the W1 database migration … Nothing was changed". The old two-step is gone.
* `clearRecallCount` (service) and `clearAwaitingAccept` (route) run only after a confirmed new cancellation, with no `await` between
  confirmation and the state change. A refused, failed or unconfirmed cancel, and an idempotent repeat, leave acceptance, recall count
  and voice events untouched. Cancel adds or removes no voice events. The public display stops listing the cancelled visit's
  announcements because it filters by serving status, as before.
* Development memory mode keeps its existing in-process path. A trusted in-process caller (no actor, no session) gets the
  waiting-only path.

## 6. Authorization

Unchanged permissions: the owning doctor, Frontdesk (no assignment or the legacy "Front Desk" label) and Superadmin. Doctor 1 cannot
cancel Doctor 2 or Doctor 3 visits (403 from Node, `42501` from SQL). Orphan serving visits are Frontdesk/Superadmin only. Forged
session ids, roles, doctors, accounts and other users' sessions are `28000` (401). A forged requested counter is `QM003`/`22023`. An
unknown patient is `P0002`, reported only after the caller is identified. The middleware's invalid-JWT response (403 "Invalid or expired
token", special-cased by the frontend) was reviewed and left unchanged; changing it would alter A7 behavior outside this task.

## 7. Verification

Environments: the mock-Supabase harness; PGlite 0.3.15; disposable PostgreSQL 17.5 (`embedded-postgres`, loopback only,
`cluster_name = r22-disposable-cancel-verification`, a fresh database per suite, dropped afterwards). The W1 suite installs Phase 2, A,
2.1, 2.2 and **B.2** (never the superseded Phase B), plus F5, C1 and W1. A second database uses the development project's known enum
without `no-show`.

| Suite | Tests | Pass | Fail | Skip |
|---|---|---|---|---|
| `w1-atomic-cancel.test.js` (service/route, installed + absent, real JWT middleware) | 10 | 10 | 0 | 0 |
| `w1-atomic-cancel-concurrency.test.js` (PG17, W1 + C1 + F5, independent connections) | 23 | 23 | 0 | 0 |
| rev2 suites against the migration (PGlite + PG17, includes 1,000+ op soak) | 86 | 86 | 0 | 0 |
| Cancel / visit-action authorization (R2, R2.1) | 169 | 169 | 0 | 0 |
| C1 | 35 | 35 | 0 | 0 |
| F5 | 58 | 58 | 0 | 0 |
| Phase 2.1 / 2.2 | 182 | 182 | 0 | 0 |
| Phase 2 | 98 | 98 | 0 | 0 |
| Auth (A7, Phase A, S1, Records, B.2) | 123 | 123 | 0 | 0 |
| Default `npm test` | 625 | 619 | 1 | 5 |
| All suites with PGlite + PG17 | 936 | 935 | 1 | 0 |

Baseline before W1: 613 / 607 / 1 / 5. The single failure is the known `voice-service-launcher.test.js` probe; it failed 3 of 3
isolated runs before and after this change, and neither the launcher nor its test was modified.

PG17 coverage (lock waits confirmed in `pg_stat_activity` before each release):

* the W1 reproduction (via F5 and via Undo) and its correction;
* Cancel vs Requeue → Call in flight;
* two Cancels, and Doctor/Frontdesk/Superadmin simultaneously;
* Cancel vs Complete, Undo (including the repeat), C1 Call and F5 Requeue, each in both orders;
* a counter re-pointed in flight;
* an account reassigned in flight (`28000`), and logout in flight in both directions;
* `lock_timeout` (`55P03`, nothing committed);
* a terminated backend, and a failing counter write (nothing committed);
* eligibility, history, cross-doctor and forged identities, reason limits;
* catalog privileges; W1 preflight (28 PASS); the rolled-back verify (passes, keeps no rows); the C1 preflight/verify still passing
  after W1;
* a randomized Cancel / Call / Requeue / Undo / Start / Complete / heartbeat soak on 4 connections: 3 seeds × 1,500 operations,
  **0 deadlocks, 0 lock timeouts**, 703 mid-run consistency samples, all consistent.

Harness note: as with C1 and F5, the mock harness emulates the uninstalled function. Unlike them, it is **on by default**
(`database.cancelRpcInstalled = false` models today's database), because without it no serving visit can be cancelled. Six older
tests that hooked the removed two-step statements now hook the RPC write instead, or call the authenticated route rather than the
trusted service function. The No-show partial-failure test is unchanged.

## 8. Remaining limitations

* **Until installed:** a serving visit (or one holding a counter) cannot be cancelled; staff get a 503 explaining the migration is
  needed. Waiting visits cancel normally.
* **N1 (No-show)** still uses the two-step write and has the same delayed-release shape. Cancel treats `no-show` as text and is
  correct with or without the enum label. When N1 is addressed, it should reuse this function's lock order (users, session, all
  counters, patient), its revision check and its release, ideally as a second entry point sharing the core, and it must keep Cancel's
  `QM002` refusal of no-show visits.
* `clearTodaysQueues` still releases counters in storage order and can deadlock with an id-ordered locker (`40P01` → 503, nothing
  partial). This is shared with Undo, Requeue and Call.
* The C1 suite's soak still uses its own Cancel stand-in. The W1 soak uses the real function with C1 and F5.
* Session validation inside the RPC happens in addition to the middleware's. The Node pre-check (`resolveCancelActor`) still answers
  an account mismatch with 403, as it does for every R2 action; the RPC's own check answers 401.

## 9. Installation (requires separate written approval)

Prerequisites: Phase 2, Phase A, Phase 2.1 and Phase 2.2 installed (Phase B.2, F5, C1 and the No-show enum are optional). Run as the
Supabase SQL editor's `postgres` role. Never run the original schema/seed SQL.

1. `20261025-w1-preflight.sql` (READ ONLY): 28 PASS rows expected. Review the inventory counts with the Health Office.
2. `20261025-w1-atomic-cancel.sql`: one transaction; adds two functions.
3. `20261025-w1-verify.sql`, at a quiet time: one row "W1 verification passed". Everything it writes is rolled back; only identity
   sequence values are consumed.
4. The current backend uses the function automatically. Smoke test with synthetic visits only: cancel a waiting, a called and an
   in-consultation visit for each doctor; Doctor 1 refused on a Doctor 2 visit (403); Undo/Re-queue then Call; and a repeat Cancel from a
   stale tab (409).

Rollback (no data change): `DROP FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT);`
`DROP FUNCTION public.qms_resolve_doctor_counter(TEXT);` The backend then returns to the fail-closed mode in §5.
