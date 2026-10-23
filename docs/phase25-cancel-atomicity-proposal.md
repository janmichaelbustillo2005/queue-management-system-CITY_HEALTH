# R2.1 — Cancel atomicity: failure analysis and proposed database function

Status: **PROPOSAL ONLY. Nothing here is installed, applied or placed under `backend/scripts/`.**
The SQL below is a review draft inside a document on purpose so it cannot be run by an install script.
Separate written approval is required before it becomes a migration. Date: 2026-10-22. Baseline: `main` @ `8222eac` plus uncommitted R1, R2 and R2.1 changes.

## 1. What happens today (verified in `queueService.performCancellation`)

For a deployed (Supabase) database, Cancel performs these independent PostgREST calls:

1. `SELECT` patient, `SELECT` counters, `SELECT` persisted staff account (authorization snapshot).
2. `UPDATE patients SET status='cancelled', completed_at, reason … WHERE id=? AND status=? AND visit_state_revision=?` — conditional compare-and-set. **Commits on its own.**
3. `UPDATE counters SET current_patient_id=NULL WHERE current_patient_id=?` — `clearCounterAssignment`. **A second, separate transaction.**

PostgREST gives each call its own transaction, so steps 2 and 3 can never be made atomic from the application. Calling two writes "a transaction" in Node does not make them one.

### Failure window

| Window | Cause | Resulting state | Effect |
|---|---|---|---|
| **W1** (between 2 and 3) | process crash, timeout, network loss, deploy restart, a database error on `counters` | patient is `cancelled`, doctor's counter still points at the patient | the doctor's counter looks occupied; Call for that doctor is blocked; the API reported 503 although the patient is already cancelled |
| **W2** | two counters point at the same patient (legacy stale pointer) and step 3 is run through `.maybeSingle()` | both pointers are cleared by the database, but PostgREST returns "multiple rows" | caller sees a failure although state is consistent |
| **W3** (between 1 and 2) | Undo/Requeue/Call/Complete commits another change | patient row no longer matches | **already safe**: the `status` + `visit_state_revision` conditions match no row and Cancel returns 409 |
| **W4** | another doctor's Call between 2 and 3 | none | **safe**: step 3 filters on `current_patient_id = <this patient>`, so it can never release another patient's claim |

W1 is an availability/consistency defect, not an authorization bypass. It is pinned by the existing test *"a failed counter release reports an error and retains database mode and the persisted pointer"* and by the R2.1 test *"cancel committed the patient but failed to release the counter"*.

### Interim mitigation already in the code (not atomic)

A repeat Cancel (or No-show) on an already-terminal patient is idempotent for the patient row, but if a counter still points at that patient it releases **only that pointer**, so a retry by the owning doctor, Frontdesk or Superadmin repairs W1. Another doctor's retry is refused (403). This narrows the damage; it does **not** remove the window, and it needs someone to retry.

## 2. Proposed function: `public.cancel_patient_visit`

One `SECURITY DEFINER` function = one transaction. It validates the persisted actor, locks in the repository's existing order (all counters ascending, then the patient — the same order Phase 2.2 Undo uses), re-checks the visit snapshot, and cancels the patient and releases the matching counter together. Any failure raises and rolls back everything.

### Contract

```
cancel_patient_visit(
  p_patient_id          BIGINT,
  p_user_id_num         TEXT,          -- verified by the Node JWT/session layer; re-validated here against public.users
  p_expected_revision   UUID,          -- visit_state_revision from the authorization snapshot (required)
  p_expected_status     TEXT,          -- status from the snapshot (required)
  p_reason              TEXT DEFAULT NULL,
  p_requested_counter   TEXT DEFAULT NULL  -- optional consistency check only; never assigns anything
) RETURNS public.patients
```

| Outcome | SQLSTATE | Node status |
|---|---|---|
| bad arguments | 22023 | 400 |
| unknown/unauthorized account, doctor acting on a patient that is not its own | 42501 | 403 |
| patient not found | P0002 | 404 |
| snapshot revision/status changed; completed visit; no-show visit; requested counter contradicts stored owner | 40001 | 409 |
| success, or repeat of an already-cancelled patient | — | 200 (repeat is detected by the unchanged `visit_state_revision`) |

Rules:

* Actor comes from `public.users` (`FOR SHARE`), never from the token. `superadmin` and `admin` with no doctor assignment (or the legacy `Front Desk`/`Frontdesk` label) may cancel any active patient. A doctor account resolves its assignment with the same normalization as `complete_patient_consultation` and may cancel only its own serving patient or a not-yet-called patient routed to it.
* Owner of the visit: stored `counter_id` when set; otherwise, for a not-serving patient, the service-to-doctor mapping; a serving patient with no stored doctor has no owner (Frontdesk/Superadmin only).
* Preserves Phase 2.1 revision protection (`visit_state_revision` compare) and Phase 2.2 behavior (no counter is ever reserved or reassigned; Undo is unchanged).
* Consultation history is untouched: `consultation_started_at`, `called_at`, `created_at`, `counter_id` are not modified. A visit that is `completed` is refused. `cancel_meta` / legacy reason-column fallback is not needed because the `reason` column is a prerequisite.
* Cancellation metadata (`completed_at`, `reason`) is written exactly once: the `UPDATE` only runs for `waiting`/`serving` rows; the `visit_state_revision` trigger rotates the revision, so a replay with the old revision fails.
* Releases only counters whose `current_patient_id` equals this patient, and rolls back if the released count differs from the count it locked.

### Draft SQL (review only)

```sql
-- DRAFT. NOT A MIGRATION. DO NOT RUN. Requires Phase 2, 2.1 and 2.2 installed and verified.
BEGIN;

CREATE OR REPLACE FUNCTION public.cancel_patient_visit(
  p_patient_id BIGINT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_expected_status TEXT,
  p_reason TEXT DEFAULT NULL,
  p_requested_counter TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_actor_kind TEXT;
  v_actor_counter TEXT;      -- id_num of the doctor counter a doctor account is assigned to
  v_owner TEXT;              -- id_num of the counter that owns the visit
  v_requested TEXT;
  v_locked_pointers INTEGER;
  v_released INTEGER;
  v_updated INTEGER;
  v_reason TEXT := NULLIF(pg_catalog.btrim(p_reason), '');
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0 OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_expected_revision IS NULL OR p_expected_status IS NULL THEN
    RAISE EXCEPTION 'A patient, staff account and visit snapshot are required' USING ERRCODE = '22023';
  END IF;

  -- 1. Persisted actor (never the token's claims).
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required to cancel a patient' USING ERRCODE = '42501';
  END IF;
  IF v_user.role::TEXT = 'superadmin' THEN
    v_actor_kind := 'superadmin';
  ELSIF v_user.doctor_name IS NULL OR pg_catalog.btrim(v_user.doctor_name) = ''
        OR pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name)) IN ('front desk', 'frontdesk') THEN
    v_actor_kind := 'frontdesk';
  ELSE
    v_actor_kind := 'doctor';
    -- Same assignment normalization as public.complete_patient_consultation.
    SELECT c.id_num INTO v_actor_counter FROM public.counters AS c
      WHERE c.id::TEXT = pg_catalog.btrim(v_user.doctor_name)
         OR pg_catalog.lower(c.id_num) = pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name))
         OR (pg_catalog.lower(pg_catalog.btrim(v_user.doctor_name)) ~ '^(doctor[[:space:]]*)?[123]$'
             AND c.id_num = 'Doctor ' || pg_catalog.regexp_replace(v_user.doctor_name, '[^0-9]', '', 'g'));
    IF v_actor_counter IS NULL THEN
      RAISE EXCEPTION 'Your account is not assigned to a valid doctor' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Lock order: every counter ascending, then the patient (matches lifecycle and Phase 2.2 Undo).
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Canonical owner from stored data.
  IF pg_catalog.btrim(COALESCE(v_patient.counter_id, '')) <> '' THEN
    SELECT c.id_num INTO v_owner FROM public.counters AS c
      WHERE c.id::TEXT = pg_catalog.btrim(v_patient.counter_id)
         OR pg_catalog.lower(pg_catalog.btrim(c.id_num)) = pg_catalog.lower(pg_catalog.btrim(v_patient.counter_id));
  ELSIF v_patient.status::TEXT <> 'serving' THEN
    -- Must stay identical to getDoctorForService() in queueService.js (a parity test is part of the plan).
    v_owner := CASE
      WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
      WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
      WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
      ELSE 'Doctor 1' END;
  END IF;
  IF v_actor_kind = 'doctor' AND v_owner IS DISTINCT FROM v_actor_counter THEN
    RAISE EXCEPTION 'You can only cancel patients assigned to your doctor' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.btrim(COALESCE(p_requested_counter, '')) <> '' THEN
    SELECT c.id_num INTO v_requested FROM public.counters AS c
      WHERE c.id::TEXT = pg_catalog.btrim(p_requested_counter)
         OR pg_catalog.lower(pg_catalog.btrim(c.id_num)) = pg_catalog.lower(pg_catalog.btrim(p_requested_counter));
    IF v_requested IS NULL THEN
      RAISE EXCEPTION 'The requested doctor is not a valid counter' USING ERRCODE = '22023';
    END IF;
    IF v_owner IS NOT NULL AND v_requested IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'The requested doctor does not match this patient''s assigned doctor' USING ERRCODE = '40001';
    END IF;
  END IF;

  -- 4. Snapshot (Phase 2.1 revision protection).
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision
     OR v_patient.status::TEXT IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Patient visit changed; refresh before retrying cancellation' USING ERRCODE = '40001';
  END IF;

  -- 5. Terminal states.
  IF v_patient.status::TEXT = 'completed' THEN
    RAISE EXCEPTION 'A completed consultation cannot be cancelled' USING ERRCODE = '40001';
  ELSIF v_patient.status::TEXT = 'no-show' THEN
    RAISE EXCEPTION 'This patient was marked no-show. Undo the no-show before cancelling' USING ERRCODE = '40001';
  ELSIF v_patient.status::TEXT = 'cancelled' THEN
    -- Idempotent repeat: the patient row is NOT updated (revision stays equal to the request's).
    -- Any stale pointer to a terminal visit is released inside this same transaction.
    UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
    RETURN v_patient;
  END IF;

  -- 6. Cancel exactly once and release exactly the matching counter(s), atomically.
  SELECT pg_catalog.count(*) INTO v_locked_pointers FROM public.counters AS c WHERE c.current_patient_id = p_patient_id;
  UPDATE public.patients AS p
    SET status = 'cancelled', completed_at = pg_catalog.clock_timestamp(), reason = v_reason,
        counter_id = CASE WHEN pg_catalog.btrim(COALESCE(p.counter_id, '')) = '' AND v_requested IS NOT NULL
                          THEN v_requested ELSE p.counter_id END
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  IF v_updated <> 1 OR v_released <> v_locked_pointers
     OR v_patient.status::TEXT <> 'cancelled'
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Unable to cancel the visit and release its counter' ;  -- rolls back both writes
  END IF;
  RETURN v_patient;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_patient_visit(BIGINT, TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_patient_visit(BIGINT, TEXT, UUID, TEXT, TEXT, TEXT) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
```

### Notes on the draft

* Repeat Cancel by a doctor on another doctor's cancelled patient is refused at step 3 before the idempotent branch (owner check precedes terminal handling), matching the Node behavior tested today.
* The service-to-doctor `CASE` duplicates the Node mapping. That is a drift risk; the plan includes a parity test, and the alternative (a mapping table) needs a schema change and a separate decision. Doctor mappings are **not** changed by this proposal.
* The draft intentionally mirrors `complete_patient_consultation` / `recover_patient_visit` patterns so reviewers can diff behavior, not re-learn it.
* No-show, Recall and the other actions could use the same pattern later; they are out of scope until Cancel's function is approved and proven.

## 3. Installation prerequisites (for the separate approval)

1. Phase 2, Phase 2.1 and Phase 2.2 migrations are installed on the target project and the existing verify scripts pass (`20261011-phase2-verify.sql`, `20261012-phase21-verify.sql`, `20261015-phase22-verify.sql`).
2. `public.patients.reason` and `visit_state_revision` (with the rotate-on-update trigger) exist; `public.counters.current_patient_id` exists.
3. Target is an explicitly identified **development** project first; backup/PITR confirmed; no use of the original schema/seed SQL.
4. A preflight and a verify script for the new function (signature, `SECURITY DEFINER`, `search_path=''`, grants only to `service_role`) written in the style of `20261016-phase22-preflight.sql`, plus a rollback script (`DROP FUNCTION` only; no data change).
5. Node change after approval: call the RPC, map SQLSTATEs per the table above, detect idempotent repeat by unchanged revision, and fail closed with 503 "database migration required" if the RPC is missing — exactly as Undo does. Rollout order: install SQL, verify, then deploy Node. Decide whether a missing RPC should keep today's two-step path (availability) or fail closed (consistency) during rollout.

## 4. Verification plan

* SQL tests under the existing optional PGlite harness (`PHASE2_PGLITE_MODULE`): actor kinds, cross-doctor refusal, stale revision, completed/no-show refusal, idempotent repeat, rollback when the counter update is forced to fail (e.g. a trigger that raises), release only the matching counter, parity of the owner mapping with `getDoctorForService`.
* **Independent-connection PostgreSQL concurrency tests (real `pg` clients on two connections against a development database):** Cancel vs Complete, Cancel vs Undo, Cancel vs Requeue, Cancel vs Call, two simultaneous Cancels, deadlock check against Call/Complete lock order. The repository has none today; the R2/R2.1 race tests use the in-memory fake client and prove only the Node-side compare-and-set logic.
* Re-run the existing 490+ backend tests, the frontend tests and the Python voice tests unchanged.

## 5. Decisions needed from the project owner

1. Approve (or reject) installing `cancel_patient_visit` on a development project.
2. During rollout, should Cancel fail closed when the function is missing, or temporarily keep the two-step path?
3. Keep the owner mapping inside SQL (drift risk, tested by parity) or introduce a mapping table (schema change)?
4. Extend the same atomic pattern to No-show, Recall, Requeue and Undo later?
