-- FC1: Front Desk patient confirmation before a doctor may call the patient.
-- STATUS: DRAFT FOR REVIEW. Applying it to a Supabase project needs separate written approval.
-- Run 20261111-fc1-preflight.sql first and 20261111-fc1-verify.sql after. Install it BEFORE the
-- FC1 backend: that backend refuses every Call (503) until these columns exist.
-- Requires Phase 2.1 (visit_state_revision and its rotation trigger) and Phase A (users).
--
-- What it adds:
--   * patients.confirmed_at / patients.confirmed_by: the Front Desk confirmation of THIS visit
--     (one patients row = one queue visit, so a new visit always starts unconfirmed). NULL means
--     Pending Confirmation. No existing row is updated: visits already waiting when this is
--     installed stay Pending until the Front Desk confirms them.
--   * confirm_patient_visit(): the only confirmation entry point. Frontdesk accounts only
--     (role admin without a doctor assignment); Superadmin and doctors are refused. One waiting
--     visit of the current queue window, confirmed once: a repeat (another desk, a double
--     click) changes nothing and reports already_confirmed with the original confirmation.
--   * Trigger patients_front_desk_confirmation (BEFORE UPDATE), in every dispatch mode and for
--     every writer, including the legacy two-step Call:
--       - waiting -> serving is refused while confirmed_at IS NULL (hint
--         awaiting_front_desk_confirmation). Confirmation itself never changes the status.
--       - a confirmation is set once, only on a waiting visit, never changed afterwards;
--       - Re-queue (a finished visit back to waiting with a NEW created_at) is a new turn and
--         clears it; Undo (back to waiting, created_at unchanged) keeps it.
--   * The installed Call functions (C1, WPS-A, D1, D1-A, RR1; only those already installed are
--     replaced, none is newly installed) differ from their reviewed scripts by two edits: the
--     visit must be confirmed, and the doctor's next patient is the head of its CONFIRMED
--     waiting visits (same WPS / WPS-A order). Unconfirmed visits keep their doctor, rank and
--     place; they are simply not callable, and not shown to the doctor, until confirmed.
--     Re-run this script after installing any of those scripts later: they would otherwise
--     replace the FC1 version (the trigger still refuses an unconfirmed Call either way).
--
-- Not changed: registration, queue numbers, priority, round-robin assignment, rotation pointer
-- and dispatcher (confirmation never assigns, reassigns or advances anything), doctor
-- availability, statuses, Cancel / No-show / Undo / Re-queue functions, and every other table.
--
-- Lock order: confirm_patient_visit takes users FOR SHARE -> the patient FOR UPDATE (the Call
-- functions take users -> counters -> patient), so no cycle. Confirm and Call serialize on the
-- patient row; the confirmation rotates visit_state_revision, so a Call prepared from an older
-- read fails with 40001 and is retried from a fresh read.
-- Errors: 22023 bad arguments, 42501 not a Frontdesk account, P0002 visit not found,
-- P0001 not confirmable / not callable.
-- Rollback: deploy the previous backend first, then run 20261111-fc1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Columns (nullable, no default, no backfill)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
COMMENT ON COLUMN public.patients.confirmed_at IS
  'FC1: when the Front Desk confirmed that the patient of THIS visit is present. NULL = Pending Confirmation; a doctor cannot call the visit. Set by confirm_patient_visit only.';
COMMENT ON COLUMN public.patients.confirmed_by IS
  'FC1: id_num of the Frontdesk account that confirmed this visit (NULL while pending).';
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.patients'::regclass AND conname = 'patients_front_desk_confirmation_pair') THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_front_desk_confirmation_pair
      CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL));
  END IF;
END;
$check$;

-- ---------------------------------------------------------------------------------------------
-- Guard trigger
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qms_guard_front_desk_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status::TEXT = 'waiting' AND OLD.status::TEXT IN ('completed', 'cancelled', 'no-show')
     AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    -- Re-queue: a new turn at the end of the queue needs a new confirmation.
    NEW.confirmed_at := NULL;
    NEW.confirmed_by := NULL;
  ELSIF OLD.confirmed_at IS NOT NULL THEN
    IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
      RAISE EXCEPTION 'A Front Desk confirmation cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL THEN
    IF OLD.status::TEXT <> 'waiting' OR NEW.status::TEXT <> 'waiting' OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only a waiting patient can be confirmed by the Front Desk' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF OLD.status::TEXT = 'waiting' AND NEW.status::TEXT = 'serving' AND NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS patients_front_desk_confirmation ON public.patients;
CREATE TRIGGER patients_front_desk_confirmation
  BEFORE UPDATE ON public.patients FOR EACH ROW
  EXECUTE FUNCTION public.qms_guard_front_desk_confirmation();

-- ---------------------------------------------------------------------------------------------
-- Confirm
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_patient_visit(
  p_patient_id BIGINT,
  p_user_id_num TEXT,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_patient public.patients%ROWTYPE;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, staff identity and queue window are required' USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted account: Frontdesk only (no doctor assignment, or the legacy label).
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT <> 'admin'
     OR pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''))) NOT IN ('', 'front desk', 'frontdesk') THEN
    RAISE EXCEPTION 'Only the Front Desk can confirm a patient' USING ERRCODE = '42501';
  END IF;

  -- 2. The visit, locked: Confirm, Call and Cancel of this visit serialize here.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.confirmed_at IS NOT NULL THEN
    -- A repeat (another desk or a double submission) keeps the original confirmation.
    RETURN pg_catalog.jsonb_build_object('already_confirmed', true, 'patient', pg_catalog.to_jsonb(v_patient));
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient can be confirmed. This visit is %.', v_patient.status::TEXT USING ERRCODE = 'P0001';
  END IF;
  IF v_patient.created_at < p_queue_start OR v_patient.created_at >= p_queue_end THEN
    RAISE EXCEPTION 'Only a visit in today''s queue can be confirmed' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Confirmation only: status, doctor, priority and queue position are unchanged.
  UPDATE public.patients AS p
    SET confirmed_at = pg_catalog.clock_timestamp(), confirmed_by = v_user.id_num
    WHERE p.id = p_patient_id AND p.status::TEXT = 'waiting' AND p.confirmed_at IS NULL
    RETURNING p.* INTO v_patient;
  IF NOT FOUND OR v_patient.confirmed_at IS NULL OR v_patient.confirmed_by IS DISTINCT FROM v_user.id_num THEN
    RAISE EXCEPTION 'Unable to save the confirmation';
  END IF;
  RETURN pg_catalog.jsonb_build_object('already_confirmed', false, 'patient', pg_catalog.to_jsonb(v_patient));
END;
$function$;

ALTER FUNCTION public.confirm_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.confirm_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.qms_guard_front_desk_confirmation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Call functions (generated from the reviewed scripts; see the header). CREATE OR REPLACE keeps
-- each function's owner and grants.
-- ---------------------------------------------------------------------------------------------
-- call_patient_visit: 20261025-c1-atomic-call.sql, plus the two FC1 edits. Replaced only when installed.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE $fc1$
CREATE OR REPLACE FUNCTION public.call_patient_visit(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assignment TEXT;
  v_assigned_doctor TEXT;
  v_next_id BIGINT;
  v_reserved BOOLEAN;
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity, visit revision and queue window are required'
      USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted staff account, held stable for this transaction.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required to call patients' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending by id: serializes with Undo, Requeue, Start, Complete and other Calls.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. A doctor account may call only for its own doctor. Frontdesk (no assignment or the
  --    legacy "Front Desk" label) and Superadmin keep their existing cross-doctor permission.
  --    Aliases match start_patient_consultation, resolved against the locked counters.
  v_assignment := pg_catalog.btrim(COALESCE(v_user.doctor_name, ''));
  IF v_user.role::TEXT = 'admin'
     AND pg_catalog.lower(v_assignment) NOT IN ('', 'front desk', 'frontdesk') THEN
    SELECT c.id_num INTO v_assigned_doctor FROM public.counters AS c
      WHERE c.id::TEXT = v_assignment OR pg_catalog.lower(c.id_num) = pg_catalog.lower(v_assignment);
    IF v_assigned_doctor IS NULL THEN
      v_assigned_doctor := CASE
        WHEN pg_catalog.lower(v_assignment) ~ '^doctor[[:space:]]*[123]$'
          THEN 'Doctor ' || pg_catalog.regexp_replace(v_assignment, '[^0-9]', '', 'g')
        WHEN v_assignment ~ '^[123]$' THEN 'Doctor ' || v_assignment
        ELSE v_assignment
      END;
    END IF;
    IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
      RAISE EXCEPTION 'You can only call patients assigned to your doctor.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.* INTO v_counter FROM public.counters AS c WHERE c.id_num = p_doctor_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% counter was not found', p_doctor_name;
  END IF;

  -- 4. The visit, locked; it must be exactly the version the backend ranked.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before calling' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient without a completion timestamp can be called';
  END IF;
  -- FC1: only a visit the Front Desk confirmed may be called.
  IF v_patient.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  IF (CASE
        WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
        WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
        WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
        ELSE 'Doctor 1'
      END) IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'This patient is assigned to another doctor';
  END IF;
  IF v_patient.counter_id IS NOT NULL AND v_patient.counter_id <> p_doctor_name THEN
    RAISE EXCEPTION 'This waiting patient has a conflicting doctor assignment';
  END IF;

  -- 5. Doctor availability. A Phase 2.1 Undo reservation (counter and visit already paired)
  --    is the only occupied state this visit may be called from.
  IF v_counter.is_online IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% is marked offline in System Settings. Enable availability before calling patients.', p_doctor_name;
  END IF;
  v_reserved := v_patient.counter_id = p_doctor_name AND v_counter.current_patient_id = p_patient_id;
  IF (v_counter.current_patient_id IS NOT NULL AND NOT v_reserved) OR EXISTS (
      SELECT 1 FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.id <> p_patient_id
        AND (s.counter_id = p_doctor_name OR (s.counter_id IS NULL AND (CASE
          WHEN s.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN s.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN s.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1'
        END) = p_doctor_name))) THEN
    RAISE EXCEPTION '% is already serving a patient', p_doctor_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'This patient is already assigned to another doctor';
  END IF;

  -- 6. Weighted-Priority Scheduling, unchanged: the stored priority_score, then registration
  --    order, then id, over the same business-day window the backend ranked.
  SELECT w.id INTO v_next_id FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.confirmed_at IS NOT NULL
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND (CASE
        WHEN w.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
        WHEN w.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
        WHEN w.service_type = 'family_planning' THEN 'Doctor 3'
        ELSE 'Doctor 1'
      END) = p_doctor_name
    ORDER BY COALESCE(w.priority_score, 0) DESC,
      pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
    LIMIT 1;
  IF v_next_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Call the next eligible patient for % according to queue priority', p_doctor_name;
  END IF;

  -- 7. Both writes, verified; any failure rolls both back.
  UPDATE public.patients AS p
    SET status = 'serving', counter_id = p_doctor_name, called_at = pg_catalog.clock_timestamp()
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id = v_counter.id AND c.is_online
      AND (c.current_patient_id IS NULL OR (v_reserved AND c.current_patient_id = p_patient_id));
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_claimed_count <> 1
     OR v_patient.status::TEXT <> 'serving' OR v_patient.counter_id IS DISTINCT FROM p_doctor_name
     OR v_patient.called_at IS NULL OR v_patient.completed_at IS NOT NULL
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1 THEN
    RAISE EXCEPTION 'Unable to call the patient and assign the doctor counter together';
  END IF;
  RETURN v_patient;
END;
$function$;
$fc1$;
  END IF;
END;
$do$;

-- call_patient_visit_wps_a: 20261029-wps-a-call-aging.sql, plus the two FC1 edits. Replaced only when installed.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE $fc1$
CREATE OR REPLACE FUNCTION public.call_patient_visit_wps_a(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assignment TEXT;
  v_assigned_doctor TEXT;
  v_next_id BIGINT;
  v_reserved BOOLEAN;
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity, visit revision and queue window are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_ranked_at IS NULL OR NOT pg_catalog.isfinite(p_ranked_at)
     OR p_ranked_at < pg_catalog.clock_timestamp() - interval '10 minutes'
     OR p_ranked_at > pg_catalog.clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'The ranking time must be within 10 minutes of the database clock'
      USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted staff account, held stable for this transaction.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required to call patients' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending by id: serializes with Undo, Requeue, Start, Complete and other Calls.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. A doctor account may call only for its own doctor. Frontdesk (no assignment or the
  --    legacy "Front Desk" label) and Superadmin keep their existing cross-doctor permission.
  --    Aliases match start_patient_consultation, resolved against the locked counters.
  v_assignment := pg_catalog.btrim(COALESCE(v_user.doctor_name, ''));
  IF v_user.role::TEXT = 'admin'
     AND pg_catalog.lower(v_assignment) NOT IN ('', 'front desk', 'frontdesk') THEN
    SELECT c.id_num INTO v_assigned_doctor FROM public.counters AS c
      WHERE c.id::TEXT = v_assignment OR pg_catalog.lower(c.id_num) = pg_catalog.lower(v_assignment);
    IF v_assigned_doctor IS NULL THEN
      v_assigned_doctor := CASE
        WHEN pg_catalog.lower(v_assignment) ~ '^doctor[[:space:]]*[123]$'
          THEN 'Doctor ' || pg_catalog.regexp_replace(v_assignment, '[^0-9]', '', 'g')
        WHEN v_assignment ~ '^[123]$' THEN 'Doctor ' || v_assignment
        ELSE v_assignment
      END;
    END IF;
    IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
      RAISE EXCEPTION 'You can only call patients assigned to your doctor.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.* INTO v_counter FROM public.counters AS c WHERE c.id_num = p_doctor_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% counter was not found', p_doctor_name;
  END IF;

  -- 4. The visit, locked; it must be exactly the version the backend ranked.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before calling' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient without a completion timestamp can be called';
  END IF;
  -- FC1: only a visit the Front Desk confirmed may be called.
  IF v_patient.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  IF (CASE
        WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
        WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
        WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
        ELSE 'Doctor 1'
      END) IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'This patient is assigned to another doctor';
  END IF;
  IF v_patient.counter_id IS NOT NULL AND v_patient.counter_id <> p_doctor_name THEN
    RAISE EXCEPTION 'This waiting patient has a conflicting doctor assignment';
  END IF;

  -- 5. Doctor availability. A Phase 2.1 Undo reservation (counter and visit already paired)
  --    is the only occupied state this visit may be called from.
  IF v_counter.is_online IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% is marked offline in System Settings. Enable availability before calling patients.', p_doctor_name;
  END IF;
  v_reserved := v_patient.counter_id = p_doctor_name AND v_counter.current_patient_id = p_patient_id;
  IF (v_counter.current_patient_id IS NOT NULL AND NOT v_reserved) OR EXISTS (
      SELECT 1 FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.id <> p_patient_id
        AND (s.counter_id = p_doctor_name OR (s.counter_id IS NULL AND (CASE
          WHEN s.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN s.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN s.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1'
        END) = p_doctor_name))) THEN
    RAISE EXCEPTION '% is already serving a patient', p_doctor_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'This patient is already assigned to another doctor';
  END IF;

  -- 6. Weighted-Priority Scheduling with Aging (WPS-A): stored priority_score plus one point per
  --    full 10 minutes waited at p_ranked_at, at most 2; then priority_score, registration
  --    order and id, over the same business-day window the backend ranked.
  SELECT w.id INTO v_next_id FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.confirmed_at IS NOT NULL
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND (CASE
        WHEN w.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
        WHEN w.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
        WHEN w.service_type = 'family_planning' THEN 'Doctor 3'
        ELSE 'Doctor 1'
      END) = p_doctor_name
    ORDER BY COALESCE(w.priority_score, 0) + LEAST(2, GREATEST(0, pg_catalog.floor(
        EXTRACT(EPOCH FROM (pg_catalog.date_trunc('milliseconds', p_ranked_at)
          - pg_catalog.date_trunc('milliseconds', w.created_at))) / 600)))::INTEGER DESC,
      COALESCE(w.priority_score, 0) DESC,
      pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
    LIMIT 1;
  IF v_next_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Call the next eligible patient for % according to queue priority', p_doctor_name;
  END IF;

  -- 7. Both writes, verified; any failure rolls both back.
  UPDATE public.patients AS p
    SET status = 'serving', counter_id = p_doctor_name, called_at = pg_catalog.clock_timestamp()
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id = v_counter.id AND c.is_online
      AND (c.current_patient_id IS NULL OR (v_reserved AND c.current_patient_id = p_patient_id));
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_claimed_count <> 1
     OR v_patient.status::TEXT <> 'serving' OR v_patient.counter_id IS DISTINCT FROM p_doctor_name
     OR v_patient.called_at IS NULL OR v_patient.completed_at IS NOT NULL
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1 THEN
    RAISE EXCEPTION 'Unable to call the patient and assign the doctor counter together';
  END IF;
  RETURN v_patient;
END;
$function$;
$fc1$;
  END IF;
END;
$do$;

-- call_patient_visit_shared: 20261029-d1-shared-call.sql, plus the two FC1 edits. Replaced only when installed.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE $fc1$
CREATE OR REPLACE FUNCTION public.call_patient_visit_shared(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_services CONSTANT TEXT[] := ARRAY['consultation', 'checkup', 'prenatal', 'maternity', 'family_planning'];
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assignment TEXT;
  v_assigned_doctor TEXT;
  v_next_id BIGINT;
  v_reserved BOOLEAN;
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity, visit revision and queue window are required'
      USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted staff account, held stable for this transaction.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required to call patients' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending by id: serializes with Undo, Requeue, Cancel, Start, Complete
  --    and every other Call, whichever doctor it is for.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. A doctor account may call only for itself. Frontdesk (no assignment or the legacy
  --    "Front Desk" label) and Superadmin select any doctor. Aliases as in C1.
  v_assignment := pg_catalog.btrim(COALESCE(v_user.doctor_name, ''));
  IF v_user.role::TEXT = 'admin'
     AND pg_catalog.lower(v_assignment) NOT IN ('', 'front desk', 'frontdesk') THEN
    SELECT c.id_num INTO v_assigned_doctor FROM public.counters AS c
      WHERE c.id::TEXT = v_assignment OR pg_catalog.lower(c.id_num) = pg_catalog.lower(v_assignment);
    IF v_assigned_doctor IS NULL THEN
      v_assigned_doctor := CASE
        WHEN pg_catalog.lower(v_assignment) ~ '^doctor[[:space:]]*[123]$'
          THEN 'Doctor ' || pg_catalog.regexp_replace(v_assignment, '[^0-9]', '', 'g')
        WHEN v_assignment ~ '^[123]$' THEN 'Doctor ' || v_assignment
        ELSE v_assignment
      END;
    END IF;
    IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
      RAISE EXCEPTION 'A doctor account can only call patients for its own counter.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.* INTO v_counter FROM public.counters AS c WHERE c.id_num = p_doctor_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% counter was not found', p_doctor_name;
  END IF;

  -- 4. The visit, locked; it must be exactly the version the backend ranked.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before calling' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient without a completion timestamp can be called';
  END IF;
  -- FC1: only a visit the Front Desk confirmed may be called.
  IF v_patient.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  -- Every general doctor may serve every configured service; nothing else is routed.
  IF v_patient.service_type IS NULL OR NOT (v_patient.service_type = ANY (v_services)) THEN
    RAISE EXCEPTION 'This visit''s service is not configured for doctor assignment';
  END IF;
  IF NULLIF(pg_catalog.btrim(v_patient.counter_id), '') IS NOT NULL AND v_patient.counter_id <> p_doctor_name THEN
    RAISE EXCEPTION 'This waiting patient has a conflicting doctor assignment';
  END IF;

  -- 5. Doctor availability. A Phase 2.1 Undo reservation (counter and visit already paired)
  --    is the only occupied state this visit may be called from.
  IF v_counter.is_online IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% is marked offline in System Settings. Enable availability before calling patients.', p_doctor_name;
  END IF;
  v_reserved := v_patient.counter_id = p_doctor_name AND v_counter.current_patient_id = p_patient_id;
  IF (v_counter.current_patient_id IS NOT NULL AND NOT v_reserved) OR EXISTS (
      SELECT 1 FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.id <> p_patient_id
        AND (s.counter_id = p_doctor_name OR (s.counter_id IS NULL AND (CASE
          WHEN s.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN s.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN s.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1'
        END) = p_doctor_name))) THEN
    RAISE EXCEPTION '% is already serving a patient', p_doctor_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'This patient is already assigned to another doctor';
  END IF;

  -- 6. Weighted-Priority Scheduling over the shared queue: stored priority_score, then
  --    registration order, then id, over the business-day window the backend ranked.
  SELECT w.id INTO v_next_id FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.confirmed_at IS NOT NULL
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND w.service_type = ANY (v_services)
      AND (NULLIF(pg_catalog.btrim(w.counter_id), '') IS NULL OR w.counter_id = p_doctor_name)
    ORDER BY COALESCE(w.priority_score, 0) DESC,
      pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
    LIMIT 1;
  IF v_next_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Call the next patient in the shared queue according to priority';
  END IF;

  -- 7. Both writes, verified; any failure rolls both back. The selected doctor is the one stored.
  UPDATE public.patients AS p
    SET status = 'serving', counter_id = p_doctor_name, called_at = pg_catalog.clock_timestamp()
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id = v_counter.id AND c.is_online
      AND (c.current_patient_id IS NULL OR (v_reserved AND c.current_patient_id = p_patient_id));
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_claimed_count <> 1
     OR v_patient.status::TEXT <> 'serving' OR v_patient.counter_id IS DISTINCT FROM p_doctor_name
     OR v_patient.called_at IS NULL OR v_patient.completed_at IS NOT NULL
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1 THEN
    RAISE EXCEPTION 'Unable to call the patient and assign the doctor counter together';
  END IF;
  RETURN v_patient;
END;
$function$;
$fc1$;
  END IF;
END;
$do$;

-- call_patient_visit_shared_wps_a: 20261029-d1a-shared-wps-a-call.sql, plus the two FC1 edits. Replaced only when installed.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE $fc1$
CREATE OR REPLACE FUNCTION public.call_patient_visit_shared_wps_a(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_services CONSTANT TEXT[] := ARRAY['consultation', 'checkup', 'prenatal', 'maternity', 'family_planning'];
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assignment TEXT;
  v_assigned_doctor TEXT;
  v_next_id BIGINT;
  v_reserved BOOLEAN;
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity, visit revision and queue window are required'
      USING ERRCODE = '22023';
  END IF;
  -- The backend's ranking instant (as in WPS-A): Node and PostgreSQL compute the same aging
  -- bonus even when their clocks differ, within 10 minutes of the database clock.
  IF p_ranked_at IS NULL OR NOT pg_catalog.isfinite(p_ranked_at)
     OR p_ranked_at < pg_catalog.clock_timestamp() - interval '10 minutes'
     OR p_ranked_at > pg_catalog.clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'The ranking time must be within 10 minutes of the database clock'
      USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted staff account, held stable for this transaction.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required to call patients' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending by id: serializes with Undo, Requeue, Cancel, Start, Complete
  --    and every other Call, whichever doctor it is for.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. A doctor account may call only for itself. Frontdesk (no assignment or the legacy
  --    "Front Desk" label) and Superadmin select any doctor. Aliases as in C1.
  v_assignment := pg_catalog.btrim(COALESCE(v_user.doctor_name, ''));
  IF v_user.role::TEXT = 'admin'
     AND pg_catalog.lower(v_assignment) NOT IN ('', 'front desk', 'frontdesk') THEN
    SELECT c.id_num INTO v_assigned_doctor FROM public.counters AS c
      WHERE c.id::TEXT = v_assignment OR pg_catalog.lower(c.id_num) = pg_catalog.lower(v_assignment);
    IF v_assigned_doctor IS NULL THEN
      v_assigned_doctor := CASE
        WHEN pg_catalog.lower(v_assignment) ~ '^doctor[[:space:]]*[123]$'
          THEN 'Doctor ' || pg_catalog.regexp_replace(v_assignment, '[^0-9]', '', 'g')
        WHEN v_assignment ~ '^[123]$' THEN 'Doctor ' || v_assignment
        ELSE v_assignment
      END;
    END IF;
    IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
      RAISE EXCEPTION 'A doctor account can only call patients for its own counter.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.* INTO v_counter FROM public.counters AS c WHERE c.id_num = p_doctor_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% counter was not found', p_doctor_name;
  END IF;

  -- 4. The visit, locked; it must be exactly the version the backend ranked.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before calling' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient without a completion timestamp can be called';
  END IF;
  -- FC1: only a visit the Front Desk confirmed may be called.
  IF v_patient.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  -- Every general doctor may serve every configured service; nothing else is routed.
  IF v_patient.service_type IS NULL OR NOT (v_patient.service_type = ANY (v_services)) THEN
    RAISE EXCEPTION 'This visit''s service is not configured for doctor assignment';
  END IF;
  IF NULLIF(pg_catalog.btrim(v_patient.counter_id), '') IS NOT NULL AND v_patient.counter_id <> p_doctor_name THEN
    RAISE EXCEPTION 'This waiting patient has a conflicting doctor assignment';
  END IF;

  -- 5. Doctor availability. A Phase 2.1 Undo reservation (counter and visit already paired)
  --    is the only occupied state this visit may be called from.
  IF v_counter.is_online IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% is marked offline in System Settings. Enable availability before calling patients.', p_doctor_name;
  END IF;
  v_reserved := v_patient.counter_id = p_doctor_name AND v_counter.current_patient_id = p_patient_id;
  IF (v_counter.current_patient_id IS NOT NULL AND NOT v_reserved) OR EXISTS (
      SELECT 1 FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.id <> p_patient_id
        AND (s.counter_id = p_doctor_name OR (s.counter_id IS NULL AND (CASE
          WHEN s.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN s.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN s.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1'
        END) = p_doctor_name))) THEN
    RAISE EXCEPTION '% is already serving a patient', p_doctor_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id AND c.id <> v_counter.id) THEN
    RAISE EXCEPTION 'This patient is already assigned to another doctor';
  END IF;

  -- 6. WPS with Aging over the shared queue: stored priority_score plus one point per full
  --    10 minutes waited at p_ranked_at (at most 2); then priority_score, so a protected category
  --    wins a tie with an aged Regular visit; then registration order and id. Same window.
  SELECT w.id INTO v_next_id FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.confirmed_at IS NOT NULL
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND w.service_type = ANY (v_services)
      AND (NULLIF(pg_catalog.btrim(w.counter_id), '') IS NULL OR w.counter_id = p_doctor_name)
    ORDER BY COALESCE(w.priority_score, 0) + LEAST(2, GREATEST(0, pg_catalog.floor(
        EXTRACT(EPOCH FROM (pg_catalog.date_trunc('milliseconds', p_ranked_at)
          - pg_catalog.date_trunc('milliseconds', w.created_at))) / 600)))::INTEGER DESC,
      COALESCE(w.priority_score, 0) DESC,
      pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
    LIMIT 1;
  IF v_next_id IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Call the next patient in the shared queue according to priority';
  END IF;

  -- 7. Both writes, verified; any failure rolls both back. The selected doctor is the one stored.
  UPDATE public.patients AS p
    SET status = 'serving', counter_id = p_doctor_name, called_at = pg_catalog.clock_timestamp()
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id = v_counter.id AND c.is_online
      AND (c.current_patient_id IS NULL OR (v_reserved AND c.current_patient_id = p_patient_id));
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_claimed_count <> 1
     OR v_patient.status::TEXT <> 'serving' OR v_patient.counter_id IS DISTINCT FROM p_doctor_name
     OR v_patient.called_at IS NULL OR v_patient.completed_at IS NOT NULL
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1 THEN
    RAISE EXCEPTION 'Unable to call the patient and assign the doctor counter together';
  END IF;
  RETURN v_patient;
END;
$function$;
$fc1$;
  END IF;
END;
$do$;

-- call_patient_visit_rr: 20261109-rr1-round-robin-dispatch.sql, plus the two FC1 edits. Replaced only when installed.
DO $do$
BEGIN
  IF pg_catalog.to_regprocedure('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)') IS NOT NULL THEN
    EXECUTE $fc1$
CREATE OR REPLACE FUNCTION public.call_patient_visit_rr(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ,
  p_aging BOOLEAN
)
RETURNS public.patients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_services CONSTANT TEXT[] := public.qms_rr_approved_services();
  v_user public.users%ROWTYPE;
  v_counter public.counters%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_assignment TEXT;
  v_assigned_doctor TEXT;
  v_head BIGINT;
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = '' OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL OR p_ranked_at IS NULL OR p_aging IS NULL
     OR NOT pg_catalog.isfinite(p_ranked_at) OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity, visit revision, queue window and ranking instant are required' USING ERRCODE = '22023';
  END IF;

  -- 1. Only the doctor's own account may call (the Call is its acceptance). Aliases as in D1.
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  v_assignment := pg_catalog.btrim(COALESCE(v_user.doctor_name, ''));
  IF NOT FOUND OR v_user.role::TEXT <> 'admin'
     OR pg_catalog.lower(v_assignment) IN ('', 'front desk', 'frontdesk') THEN
    RAISE EXCEPTION 'Only the assigned doctor can call this patient' USING ERRCODE = '42501';
  END IF;
  SELECT c.id_num INTO v_assigned_doctor FROM public.counters AS c
    WHERE c.id::TEXT = v_assignment OR pg_catalog.lower(c.id_num) = pg_catalog.lower(v_assignment)
    ORDER BY c.id LIMIT 1;
  IF v_assigned_doctor IS NULL THEN
    v_assigned_doctor := CASE
      WHEN pg_catalog.lower(v_assignment) ~ '^doctor[[:space:]]*[123]$'
        THEN 'Doctor ' || pg_catalog.regexp_replace(v_assignment, '[^0-9]', '', 'g')
      WHEN v_assignment ~ '^[123]$' THEN 'Doctor ' || v_assignment
      ELSE v_assignment
    END;
  END IF;
  IF v_assigned_doctor IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'A doctor account can only call patients for its own counter.' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending by id.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;
  SELECT c.* INTO v_counter FROM public.counters AS c WHERE c.id_num = p_doctor_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% counter was not found', p_doctor_name;
  END IF;

  -- 3. The visit, exactly as the backend read it, still assigned to this doctor.
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before calling' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only a waiting patient without a completion timestamp can be called';
  END IF;
  -- FC1: only a visit the Front Desk confirmed may be called.
  IF v_patient.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  IF v_patient.counter_id IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'This patient is not assigned to %. Refresh the queue.', p_doctor_name USING ERRCODE = '42501';
  END IF;
  IF v_patient.service_type IS NULL OR NOT (v_patient.service_type = ANY (v_services)) THEN
    RAISE EXCEPTION 'This visit''s service is not configured for doctor assignment';
  END IF;

  -- 4. Priority: the head of this doctor's own list. Round robin chose the doctor; WPS/WPS-A
  --    still decides who that doctor serves first.
  SELECT w.id INTO v_head FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.confirmed_at IS NOT NULL AND w.completed_at IS NULL AND w.counter_id = p_doctor_name
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND NOT EXISTS (SELECT 1 FROM public.counters AS x WHERE x.current_patient_id = w.id)
    ORDER BY public.qms_rr_effective_priority(w.priority_score, w.created_at, p_ranked_at, p_aging) DESC,
      COALESCE(w.priority_score, 0) DESC,
      pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
    LIMIT 1;
  IF v_head IS DISTINCT FROM p_patient_id THEN
    RAISE EXCEPTION 'Call the next patient assigned to % according to queue priority', p_doctor_name;
  END IF;

  -- 5. Availability and the one-active-patient rule.
  IF v_counter.is_online IS DISTINCT FROM true THEN
    RAISE EXCEPTION '% is marked offline in System Settings. Enable availability before calling patients.', p_doctor_name;
  END IF;
  IF v_counter.current_patient_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.id <> p_patient_id AND s.counter_id = p_doctor_name) THEN
    RAISE EXCEPTION '% is already serving a patient', p_doctor_name;
  END IF;
  IF EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'This patient is already assigned to another doctor';
  END IF;

  -- 6. Both writes, verified; any failure rolls both back.
  UPDATE public.patients AS p
    SET status = 'serving', counter_id = p_doctor_name, called_at = pg_catalog.clock_timestamp()
    WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id = v_counter.id AND c.is_online AND c.current_patient_id IS NULL;
  GET DIAGNOSTICS v_claimed_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_claimed_count <> 1
     OR v_patient.status::TEXT <> 'serving' OR v_patient.counter_id IS DISTINCT FROM p_doctor_name
     OR v_patient.called_at IS NULL OR v_patient.completed_at IS NOT NULL
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1 THEN
    RAISE EXCEPTION 'Unable to call the patient and assign the doctor counter together';
  END IF;
  RETURN v_patient;
END;
$function$;
$fc1$;
  END IF;
END;
$do$;

NOTIFY pgrst, 'reload schema';
COMMIT;
