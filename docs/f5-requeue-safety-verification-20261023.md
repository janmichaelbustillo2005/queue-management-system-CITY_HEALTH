# F5 — Requeue Safety Verification (2026-10-23)

Status: **fixed locally in the backend; versioned SQL reviewed, NOT INSTALLED.**
Branch `main` at `cf2eb34` (contains F5 commit `8904be2`). No Supabase project was touched.

## 1. Defect and root cause

Before `8904be2`, `requeuePatient` accepted any status and called `recover_patient_visit(action => 'requeue')`,
whose only status guard is "completed with a consultation start". A waiting or serving visit
(called, accepted or consultation started) was reset to `waiting` with `called_at`,
`consultation_started_at`, `counter_id` cleared and `created_at` reset, while the doctor's counter
kept pointing at it — blocking that doctor's next Call.

## 2. Implementation already present (`8904be2`), reviewed and confirmed

| Layer | Protection |
|---|---|
| `queueService.requeuePatient` | Rejects waiting (409), serving with or without start (409), completed-with-start (400) from the **persisted** row; ownership via `authorizeVisitAction` (stored assignment, persisted account; body fields never authority). |
| `recoverPatientVisit` | Prefers `requeue_patient_visit`; without it, falls back to `recover_patient_visit` only when no counter points at the visit, otherwise 503 (never leaves a stale pointer). Snapshot (revision + 6 fields) compared under row lock. |
| `20261022-f5-requeue-terminal-recovery.sql` | Restricts `p_expected_status` to cancelled / no-show / completed, which the inner function compares with the **locked** row (atomic eligibility); locks all counters by id, then delegates; releases only pointers to this visit; rolls everything back if any post-condition fails. Does not alter the md5-pinned `recover_patient_visit`. |
| Frontend | Re-queue rendered only for cancelled/no-show rows (Doctor and Frontdesk); modal `submitting` guard / `pendingActionsRef` prevent repeated clicks; backend `{error}` shown. No change needed. |

SQL review result: **no correction required.** Lock order (counters → users `FOR SHARE` → patient)
cannot form a cycle with Undo (users `FOR SHARE` → counters → patient) because nothing holds a
conflicting `users` lock while waiting on `counters`; confirmed by the randomized real-PG soak.

## 3. Before / after (current tests run against pre-F5 code in a throwaway worktree)

| Scenario | Before `8904be2` | After |
|---|---|---|
| A Waiting | 200 "re-queued", `created_at` reset | 409, row unchanged |
| B Serving (called / accepted) | 200, call + counter erased, pointer left | 409, all fields and pointer unchanged |
| C Consultation started | 200, `called_at`, `consultation_started_at`, `counter_id` erased | 409, preserved |
| D Completed consultation | 400 (Phase 2.1) | 400, history preserved |
| E Cancelled with stale pointer | re-queued, **pointer left behind** | re-queued, only its own pointer released |

Pre-F5: 19 of 34 F5 eligibility tests fail; post-F5: 34/34 pass.

## 4. Eligibility rules (final)

Waiting → reject · Serving → reject · Started → reject · Completed with start → reject ·
Completed **without** start (legacy) → permitted, unchanged existing behavior, **policy pending**
(Health Office question 5 in `phase25-cancel-atomicity-proposal-rev2.md`) · Cancelled → permitted
for owning doctor, Frontdesk, Superadmin · No-show → permitted by design, unreachable until the
enum is installed.

## 5. Verification environment

* PGlite 0.3.15 (`output/phase22-final-audit-20261021/pglite`) via `PHASE2_PGLITE_MODULE`.
* Disposable PostgreSQL 17.10 (`embedded-postgres` binaries in a temporary directory), loopback only,
  `cluster_name = r22-disposable-cancel-verification`, via `PHASE25_PG_URL` / `PHASE25_PG_MODULE`.
  Each suite creates and drops its own database. Synthetic rows only.

Note: without those variables the PGlite and real-PG suites are skipped **as whole suites**, so the
default `npm test` count (599) contains no SQL verification.

| Run | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| Default `npm test` | 599 | 593 | 1 | 5 |
| With PGlite + real PG17 | 866 | 865 | 1 | 0 |

The one failure is `voice-service-launcher.test.js` ("starts one ready voice service…"): after
`stop()` the port probe reports `unresponsive` instead of `absent`. It passed in the first baseline
and began failing once the live voice service was started on this machine; the venv `python.exe`
stub spawns a child interpreter whose teardown outlives the probe. No source or test touched by F5;
not a regression.

## 6. Added test

`f5-requeue-concurrency.test.js` — *known C1 gap: Cancel + Requeue inside Call's two-step window
leaves a serving visit without its counter.* Call claims the counter, a Cancel and a Requeue commit,
then Call's patient CAS (`status = 'waiting' AND counter_id IS NULL …`) still matches because it does
not check `visit_state_revision`. Result: serving on Doctor 3, `counters.current_patient_id` NULL.
The same test shows a revision-guarded CAS refuses the delayed update. This is C1 (Call), not a
Requeue defect: it existed before F5 and also occurs with Undo. Pinned to fail loudly once C1 is fixed.

## 7. No-show / N1 interaction

No-show stays inactive (enum absent; not installed). N1's delayed second No-show statement releases
pointers by patient id; if **Requeue** (like Undo) and a Call commit between the two statements, it
releases the new legitimate assignment. The N1 fix (single transactional No-show that releases only a
pointer still matching the no-show revision) covers Requeue too; no F5 change is needed for it.

## 8. Installation plan (requires separate written approval)

1. Preconditions on the target project: Phase 2, 2.1, 2.2 installed; `20261015-phase22-verify.sql` passes.
2. Deploy nothing first — the current backend already prefers the function and falls back safely.
3. Run `20261022-f5-requeue-terminal-recovery.sql` (single transaction; adds one function; no row,
   trigger or RLS change).
4. Verify: function exists, `SECURITY DEFINER`, `search_path=''`, EXECUTE only for `service_role`;
   `recover_patient_visit` md5 still matches the Phase 2.2 pin.
5. Smoke test with synthetic rows only: Requeue a cancelled visit; attempt Requeue on a serving visit (409).

Rollback (no data change): `DROP FUNCTION public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID,
TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);` — the backend reverts to the
pointer-refusing fallback automatically.

A dedicated `-verify.sql` for F5 has not been written; recommended before installation.
