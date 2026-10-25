-- W1: atomic Cancel. One transaction cancels an active visit AND releases exactly the counter
-- pointer(s) to it, or changes nothing.
-- STATUS: REVIEW DRAFT. NOT INSTALLED. Applying it to any Supabase project needs separate
-- written approval. Never execute the original schema/seeding SQL.
--
-- Executable successor of the reviewed proposal in docs/phase25-cancel-atomicity-proposal-rev2.md
-- (kept unchanged as history). Differences from that draft:
--   * A revoked/expired/mismatched session or an account that no longer matches the token raises
--     SQLSTATE 28000 (the backend answers 401 and the browser signs out, exactly as the Phase A
--     middleware does). 42501 (403) is kept for a valid account without permission.
--   * Decisions applied: fail closed when absent (D2), session re-validated in the transaction
--     (D3), completed stays 400 (D4), service mapping in SQL with a parity test (D5),
--     1000-character reason limit (D6).
--
-- Requires Phase 2 (patients.reason, consultation_started_at), Phase A (staff sessions),
-- Phase 2.1 (visit_state_revision + rotation trigger) and Phase 2.2. Independent of F5, C1,
-- Phase B.2 and the No-show enum: 'no-show' is compared as text and never cast, so the function
-- works with or without that enum label. Adds two functions; replaces none; does not update
-- patients, counters, users, sessions, triggers, grants on tables or RLS during installation.
--
-- Defect fixed (W1): the backend committed the cancelled patient, then released counters by
-- patient id in a second statement. A Requeue or Undo and a new valid Call of the same visit
-- committed between the two statements, and the delayed release then cleared the new call's
-- counter (a serving visit with no counter pointer).
--
-- Lock order: users FOR SHARE -> staff_auth_sessions FOR SHARE -> all counters ascending by id
-- FOR UPDATE -> the patient FOR UPDATE. Compatible with C1 Call (users, counters, patient),
-- F5 Requeue and Phase 2.2 Undo (counters, patient) and Start/Complete (one counter, patient):
-- no path holds a patient lock while it waits for a counter, so no cycle can form.
-- lock_timeout bounds a wait behind a stuck holder (55P03, nothing committed).
--
-- Errors: 22023 bad arguments or reason; 28000 session/account no longer valid (sign in again);
-- 42501 not permitted; P0002 patient not found; 40001 visit changed since it was read;
-- QM001 completed; QM002 no-show (undo first); QM003 requested doctor contradicts the stored one;
-- QM500 invariant failure (everything rolled back).
--
-- Rollback (no data change): deploy the previous backend first, then
--   DROP FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT);
--   DROP FUNCTION public.qms_resolve_doctor_counter(TEXT);
-- With the current backend, dropping the function only disables cancelling a serving visit or a
-- visit with a counter pointer (503); waiting visits without a pointer still cancel.
BEGIN;

-- Internal. Mirrors queueService.resolveDoctorCounter: trimmed, case-insensitive id_num,
-- numeric counter id, or "N"/"doctor N" alias (leading zeros ignored). Deterministic:
-- the lowest matching counter id wins, as in get_staff_doctor_presence.
-- Whitespace set approximates JavaScript String.trim() (Unicode spaces are not covered).
CREATE OR REPLACE FUNCTION public.qms_resolve_doctor_counter(p_value TEXT)
RETURNS BIGINT
LANGUAGE sql STABLE
SET search_path = ''
AS $function$
  WITH input AS (
    SELECT pg_catalog.lower(pg_catalog.btrim(p_value, E' \t\n\r\f\x0B')) AS raw
  ), parsed AS (
    SELECT i.raw,
      CASE WHEN i.raw ~ '^(doctor[[:space:]]*)?[0-9]+$'
        THEN 'doctor ' || (pg_catalog.regexp_replace(i.raw, '^doctor[[:space:]]*', '')::NUMERIC)::TEXT
      END AS doctor_alias
    FROM input AS i
    WHERE i.raw <> ''
  )
  SELECT c.id
  FROM public.counters AS c CROSS JOIN parsed AS a
  WHERE pg_catalog.lower(pg_catalog.btrim(c.id_num, E' \t\n\r\f\x0B')) = a.raw
     OR c.id::TEXT = a.raw
     OR pg_catalog.lower(c.id_num) = a.doctor_alias
  ORDER BY c.id
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.cancel_patient_visit(
  p_patient_id BIGINT,
  p_session_id UUID,
  p_user_id_num TEXT,
  p_role TEXT,
  p_doctor_name TEXT,
  p_expected_revision UUID,
  p_expected_status TEXT,
  p_reason TEXT,
  p_requested_counter TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_ws CONSTANT TEXT := E' \t\n\r\f\x0B';
  v_user public.users%ROWTYPE;
  v_session public.staff_auth_sessions%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_actor_kind TEXT;
  v_actor_counter BIGINT;   -- counters.id of a doctor account's assignment
  v_owner BIGINT;           -- counters.id that owns the visit (NULL = no owner)
  v_requested BIGINT;       -- counters.id of the client-supplied doctor, if any
  v_stamp TEXT;             -- id_num written to a blank counter_id (attribution rule only)
  v_reason TEXT;
  v_locked_pointers INTEGER;
  v_released INTEGER;
  v_updated INTEGER;
BEGIN
  -- 0. Arguments.
  IF p_patient_id IS NULL OR p_patient_id <= 0 OR p_session_id IS NULL
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num, v_ws) = ''
     OR p_role IS NULL OR p_expected_revision IS NULL OR p_expected_status IS NULL THEN
    RAISE EXCEPTION 'A patient, authenticated session and visit snapshot are required' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(pg_catalog.btrim(p_reason, v_ws), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Reason for cancel is required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'Reason for cancel is too long (maximum 1000 characters)' USING ERRCODE = '22023';
  END IF;

  -- 1. Persisted account and session (same checks as validate_staff_auth_session), held stable
  --    until commit: a logout, revocation or account change waits for this transaction.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin')
     OR v_user.role::TEXT IS DISTINCT FROM p_role
     OR NULLIF(v_user.doctor_name, '') IS DISTINCT FROM NULLIF(p_doctor_name, '') THEN
    RAISE EXCEPTION 'Your account no longer matches your session. Sign in again.' USING ERRCODE = '28000';
  END IF;
  SELECT s.* INTO v_session FROM public.staff_auth_sessions AS s
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_session.role IS DISTINCT FROM p_role
     OR v_session.doctor_name IS DISTINCT FROM NULLIF(p_doctor_name, '')
     OR v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Your authentication session expired or was revoked. Please sign in again.' USING ERRCODE = '28000';
  END IF;

  -- 2. Lock every counter ascending (same order as C1 Call, F5 Requeue and Phase 2.2 Undo).
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. Actor kind, resolved against the locked counters (mirrors resolveCancelActor).
  IF v_user.role::TEXT = 'superadmin' THEN
    v_actor_kind := 'superadmin';
  ELSIF pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''), v_ws))
        IN ('', 'front desk', 'frontdesk') THEN
    v_actor_kind := 'frontdesk';
  ELSE
    v_actor_kind := 'doctor';
    v_actor_counter := public.qms_resolve_doctor_counter(v_user.doctor_name);
    IF v_actor_counter IS NULL THEN
      RAISE EXCEPTION 'Your current account is not assigned to this doctor. Sign in again.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Patient (identified only after the caller, as in authorizeVisitAction).
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;

  -- 5. Owner from persisted data only (mirrors resolveCancelOwner).
  IF pg_catalog.btrim(COALESCE(v_patient.counter_id, ''), v_ws) <> '' THEN
    v_owner := public.qms_resolve_doctor_counter(v_patient.counter_id);
  ELSIF v_patient.status::TEXT <> 'serving' THEN
    -- Must stay identical to getDoctorForService() (parity test required).
    v_owner := public.qms_resolve_doctor_counter(CASE
      WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
      WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
      WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
      ELSE 'Doctor 1' END);
  END IF;
  IF v_actor_kind = 'doctor' AND (v_owner IS NULL OR v_owner <> v_actor_counter) THEN
    RAISE EXCEPTION 'You can only cancel patients assigned to your doctor.' USING ERRCODE = '42501';
  END IF;

  -- 6. Client-supplied doctor: consistency check against the stored owner.
  IF pg_catalog.btrim(COALESCE(p_requested_counter, ''), v_ws) <> '' THEN
    v_requested := public.qms_resolve_doctor_counter(p_requested_counter);
    IF v_requested IS NULL THEN
      RAISE EXCEPTION 'The requested doctor is not a valid counter' USING ERRCODE = '22023';
    END IF;
    IF v_owner IS NOT NULL AND v_requested <> v_owner THEN
      RAISE EXCEPTION 'The requested doctor does not match this patient''s assigned doctor' USING ERRCODE = 'QM003';
    END IF;
  END IF;

  -- 7. Snapshot (Phase 2.1 revision protection).
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision
     OR v_patient.status::TEXT IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Patient visit changed; refresh before retrying cancellation' USING ERRCODE = '40001';
  END IF;

  -- 8. Terminal states.
  IF v_patient.status::TEXT = 'completed' THEN
    RAISE EXCEPTION 'A completed consultation cannot be cancelled' USING ERRCODE = 'QM001';
  ELSIF v_patient.status::TEXT = 'no-show' THEN
    RAISE EXCEPTION 'This patient was marked no-show. Undo the no-show before cancelling.' USING ERRCODE = 'QM002';
  ELSIF v_patient.status::TEXT = 'cancelled' THEN
    -- Idempotent repeat: the patient row is not written, so its revision is unchanged.
    -- Under these locks any pointer to this cancelled visit is stale; release it here.
    SELECT pg_catalog.count(*) INTO v_locked_pointers
      FROM public.counters AS c WHERE c.current_patient_id = p_patient_id;
    UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
    GET DIAGNOSTICS v_released = ROW_COUNT;
    IF v_released <> v_locked_pointers
       OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
      RAISE EXCEPTION 'Unable to release the cancelled patient''s counter' USING ERRCODE = 'QM500';
    END IF;
    RETURN v_patient;
  ELSIF v_patient.status::TEXT NOT IN ('waiting', 'serving') THEN
    RAISE EXCEPTION 'Unsupported visit status' USING ERRCODE = 'QM500';
  END IF;

  -- 9. Attribution: only a blank counter_id, only to the validated owner.
  IF pg_catalog.btrim(COALESCE(v_patient.counter_id, ''), v_ws) = ''
     AND v_owner IS NOT NULL AND v_requested = v_owner THEN
    SELECT c.id_num INTO v_stamp FROM public.counters AS c WHERE c.id = v_owner;
  END IF;

  -- 10. Cancel once and release exactly the matching counter(s), atomically.
  -- consultation_started_at, called_at and created_at are never modified.
  SELECT pg_catalog.count(*) INTO v_locked_pointers
    FROM public.counters AS c WHERE c.current_patient_id = p_patient_id;
  UPDATE public.patients AS p
    SET status = 'cancelled', completed_at = pg_catalog.clock_timestamp(), reason = v_reason,
        counter_id = COALESCE(v_stamp, p.counter_id)
    WHERE p.id = p_patient_id
    RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  IF v_updated <> 1 OR v_released <> v_locked_pointers
     OR v_patient.status::TEXT IS DISTINCT FROM 'cancelled'
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Unable to cancel the visit and release its counter' USING ERRCODE = 'QM500';
  END IF;
  RETURN v_patient;
END;
$function$;

ALTER FUNCTION public.qms_resolve_doctor_counter(TEXT) OWNER TO postgres;
ALTER FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;

-- The helper is internal: no API role may call it (Supabase default privileges grant all three).
REVOKE ALL ON FUNCTION public.qms_resolve_doctor_counter(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
