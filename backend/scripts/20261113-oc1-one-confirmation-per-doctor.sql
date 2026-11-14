-- OC1: one confirmed or active patient per doctor, Front Desk "Not Present", strict reassignment
-- and Undo rules.
-- STATUS: DRAFT FOR REVIEW. Applying it to a Supabase project needs separate written approval.
-- Requires FC1 (20261111-fc1-front-desk-confirmation.sql). Run 20261113-oc1-preflight.sql first
-- and 20261113-oc1-verify.sql after. Install it BEFORE the OC1 backend: that backend refuses every
-- confirmation and Not Present action (503) until these functions exist.
--
-- THE RULE (each doctor independently, in every writer: confirmation, Call, Undo, transfer,
-- round-robin dispatch, any direct UPDATE):
--   A doctor has at most ONE active visit. Active = a visit it is serving (any day), an Undo
--   reservation on its counter, or a CONFIRMED visit of the doctor still waiting in today's
--   (Asia/Manila) queue. Completing, cancelling or marking no-show the active visit frees the doctor.
--
-- WPS / WPS-A are unchanged. The Front Desk may confirm a doctor's next pending visit only while
-- the doctor has no active visit. The next pending visit is the head of the doctor's unconfirmed,
-- present, waiting visits of today's queue in the existing order: effective priority
-- (priority_score, plus with WPS_AGING +1 per full 10 minutes waited, at most +2) DESC,
-- priority_score DESC, registration time ASC, id ASC. That is the formula of
-- qms_rr_effective_priority / call_patient_visit_rr / call_patient_visit_wps_a and of
-- backend/src/lib/wpsPriority.js; weights, aging and ranking are not changed here.
--
-- What it adds or changes:
--   * patients.confirmed_for: the doctor the confirmation was given for (kept in step with the
--     serving doctor once called or transferred). A visit's confirmation is valid for that doctor
--     only: when a waiting visit is assigned to ANOTHER doctor (automatic reassignment, or an Undo
--     whose doctor is no longer available), the confirmation is cleared and the Front Desk confirms
--     the patient again under the new doctor. Undo back to the same doctor keeps it (FC1).
--   * patients.not_present_at / not_present_by: the Front Desk marked a PENDING patient Not Present.
--     The visit keeps its ticket, registration time, priority and doctor; it is only skipped when
--     choosing the doctor's next patient, and cannot be confirmed, until the Front Desk marks the
--     patient present again (set_patient_presence). It then rejoins at its original WPS / WPS-A rank
--     and never interrupts an active visit. A Re-queue (a new turn) clears it.
--   * confirm_next_patient_visit(): the confirmation entry point of the OC1 backend.
--   * set_patient_presence(): Not Present / Present, Frontdesk accounts only.
--   * qms_guard_front_desk_confirmation() (FC1's guard) is REPLACED by a version that also clears
--     the confirmation on reassignment to another doctor and clears Not Present on Re-queue. Its
--     FC1 rules are kept. 20261113-oc1-rollback.sql restores FC1's version exactly. If FC1 is
--     re-run later, re-run OC1 afterwards (20261113-oc1-verify.sql row 5 detects it).
--   * Trigger patients_one_confirmation_per_doctor (BEFORE UPDATE; fires after FC1's guard):
--     confirmation and Not Present written only through the two functions; confirmed_for kept in
--     step; and the one-active-visit rule above, refused with SQLSTATE P0001 and
--     HINT doctor_has_active_patient (Undo and transfer show it to staff).
--
-- Not changed: priority scores, WPS / WPS-A, Call functions, registration, ticket numbers,
-- round-robin assignment and its rotation pointer, statuses, Cancel / No-show / Re-queue.
--
-- Doctor of a PENDING visit (choosing the next patient), by the backend's dispatch mode:
--   round_robin: its stored assignment (counter_id); none while pending reassignment.
--   service:     its stored assignment, else its service's doctor (as call_patient_visit).
--   shared:      none before the Call (D1), so the next-patient rule does not apply there.
-- Doctor of an ACTIVE visit: serving -> counter_id (legacy rows without one: its service's
-- doctor, as the Calls treat them); confirmed waiting -> counter_id, else confirmed_for.
--
-- Lock order: users FOR SHARE -> all counters ascending FOR UPDATE -> the patient FOR UPDATE, as
-- call_patient_visit(_rr), Undo and Re-queue; RR1 registration/dispatch/transfer take the rotation
-- row first, then the counters. Every writer that can make a visit active holds the counter locks,
-- so the trigger's check cannot race.
-- Errors: 22023 bad arguments, 42501 not a Frontdesk account, P0002 visit not found, P0001 refused
-- (HINT doctor_has_active_patient | not_next_for_doctor | awaiting_doctor_assignment |
-- patient_not_present | one_confirmation_per_doctor).
-- Rollback: deploy the previous backend first, then run 20261113-oc1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $prerequisites$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'patients' AND column_name = 'confirmed_at')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.patients'::regclass
      AND tgname = 'patients_front_desk_confirmation') THEN
    RAISE EXCEPTION 'OC1 requires FC1 (20261111-fc1-front-desk-confirmation.sql). Nothing was changed.';
  END IF;
END;
$prerequisites$;

-- ---------------------------------------------------------------------------------------------
-- Columns (nullable, no default, no backfill)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS confirmed_for TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS not_present_at TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS not_present_by TEXT;
COMMENT ON COLUMN public.patients.confirmed_for IS
  'OC1: the doctor the Front Desk confirmation is valid for (the serving doctor once called). Cleared with the confirmation; a reassignment to another doctor clears both.';
COMMENT ON COLUMN public.patients.not_present_at IS
  'OC1: when the Front Desk marked this pending patient Not Present. Skipped when choosing the doctor''s next patient until marked present; ticket, priority, registration time and doctor are kept.';
COMMENT ON COLUMN public.patients.not_present_by IS
  'OC1: id_num of the Frontdesk account that marked the patient Not Present (NULL while present).';
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.patients'::regclass AND conname = 'patients_not_present_pair') THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_not_present_pair
      CHECK ((not_present_at IS NULL) = (not_present_by IS NULL));
  END IF;
END;
$check$;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
-- The service routing of call_patient_visit (legacy rows and service dispatch).
CREATE OR REPLACE FUNCTION public.qms_oc1_service_doctor(p_service_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
    WHEN p_service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
    WHEN p_service_type = 'family_planning' THEN 'Doctor 3'
    ELSE 'Doctor 1'
  END;
$function$;

-- The doctor of a PENDING visit for a dispatch mode (see the header).
CREATE OR REPLACE FUNCTION public.qms_oc1_visit_doctor(p_service_type TEXT, p_counter_id TEXT, p_dispatch_mode TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_dispatch_mode
    WHEN 'round_robin' THEN NULLIF(pg_catalog.btrim(COALESCE(p_counter_id, '')), '')
    WHEN 'service' THEN COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_counter_id, '')), ''), public.qms_oc1_service_doctor(p_service_type))
    ELSE NULL
  END;
$function$;

-- WPS effective priority at p_ranked_at; identical to qms_rr_effective_priority (RR1) and to the
-- WPS-A Call functions: priority_score, plus with aging +1 per full 10 minutes waited, at most +2.
CREATE OR REPLACE FUNCTION public.qms_oc1_effective_priority(p_score INTEGER, p_created_at TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ, p_aging BOOLEAN)
RETURNS INTEGER
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT COALESCE(p_score, 0) + CASE WHEN p_aging THEN LEAST(2, GREATEST(0, pg_catalog.floor(
    EXTRACT(EPOCH FROM (pg_catalog.date_trunc('milliseconds', p_ranked_at)
      - pg_catalog.date_trunc('milliseconds', p_created_at))) / 600)))::INTEGER ELSE 0 END;
$function$;

-- Start of today's Asia/Manila business day (backend/src/lib/businessDay.js).
CREATE OR REPLACE FUNCTION public.qms_oc1_day_start()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT (pg_catalog.date_trunc('day', pg_catalog.clock_timestamp() AT TIME ZONE 'Asia/Manila')) AT TIME ZONE 'Asia/Manila';
$function$;

-- The doctor a visit keeps busy, or NULL when the visit is not active (see the header).
CREATE OR REPLACE FUNCTION public.qms_oc1_active_doctor(p_status TEXT, p_service_type TEXT, p_counter_id TEXT,
  p_confirmed_at TIMESTAMPTZ, p_confirmed_for TEXT, p_completed_at TIMESTAMPTZ, p_created_at TIMESTAMPTZ, p_day_start TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_status = 'serving'
      THEN COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_counter_id, '')), ''), public.qms_oc1_service_doctor(p_service_type))
    WHEN p_status = 'waiting' AND p_confirmed_at IS NOT NULL AND p_completed_at IS NULL AND p_created_at >= p_day_start
      THEN COALESCE(NULLIF(pg_catalog.btrim(COALESCE(p_counter_id, '')), ''), NULLIF(pg_catalog.btrim(COALESCE(p_confirmed_for, '')), ''))
    ELSE NULL
  END;
$function$;

-- Another active visit of p_doctor than p_exclude_id: its id, or NULL. A counter pointer counts
-- even when its visit row is gone.
CREATE OR REPLACE FUNCTION public.qms_oc1_active_visit(p_doctor TEXT, p_exclude_id BIGINT, p_day_start TIMESTAMPTZ)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT COALESCE(
    (SELECT c.current_patient_id FROM public.counters AS c
      WHERE c.id_num = p_doctor AND c.current_patient_id IS NOT NULL AND c.current_patient_id IS DISTINCT FROM p_exclude_id
      ORDER BY c.id LIMIT 1),
    (SELECT a.id FROM public.patients AS a
      WHERE a.id IS DISTINCT FROM p_exclude_id
        AND (a.status::TEXT = 'serving' OR (a.status::TEXT = 'waiting' AND a.confirmed_at IS NOT NULL AND a.created_at >= p_day_start))
        AND public.qms_oc1_active_doctor(a.status::TEXT, a.service_type, a.counter_id, a.confirmed_at, a.confirmed_for,
          a.completed_at, a.created_at, p_day_start) = p_doctor
      ORDER BY (a.status::TEXT = 'serving') DESC, a.id ASC
      LIMIT 1));
$function$;

-- ---------------------------------------------------------------------------------------------
-- FC1's guard, extended (replaces FC1's version; the rollback restores it). FC1 rules unchanged:
-- Re-queue clears the confirmation, a confirmation is set once on a waiting visit and never
-- rewritten, waiting -> serving needs a confirmation. OC1 additions are marked.
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
    -- OC1: a new turn starts present.
    NEW.not_present_at := NULL;
    NEW.not_present_by := NULL;
  ELSIF OLD.confirmed_at IS NOT NULL AND NEW.status::TEXT = 'waiting'
     AND NULLIF(pg_catalog.btrim(COALESCE(NEW.counter_id, '')), '') IS NOT NULL
     AND NEW.counter_id IS DISTINCT FROM OLD.counter_id
     AND NEW.counter_id IS DISTINCT FROM OLD.confirmed_for
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
     AND NEW.confirmed_by IS NOT DISTINCT FROM OLD.confirmed_by THEN
    -- OC1 (oc1_reassignment): a waiting visit assigned to another doctor than the one it was
    -- confirmed for is a new assignment; the Front Desk confirms it again under that doctor.
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

-- ---------------------------------------------------------------------------------------------
-- OC1 guard: who may write the OC1 state, and the one-active-visit-per-doctor rule.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qms_oc1_guard_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_confirming BOOLEAN := COALESCE(pg_catalog.current_setting('qms.oc1_confirming_patient', true), '') = NEW.id::TEXT;
  v_presence BOOLEAN := COALESCE(pg_catalog.current_setting('qms.oc1_presence_patient', true), '') = NEW.id::TEXT;
  v_requeue BOOLEAN := NEW.status::TEXT = 'waiting' AND OLD.status::TEXT IN ('completed', 'cancelled', 'no-show')
    AND NEW.created_at IS DISTINCT FROM OLD.created_at;
  v_day_start TIMESTAMPTZ;
  v_new_doctor TEXT;
  v_old_doctor TEXT;
  v_blocking BIGINT;
  v_blocking_number TEXT;
BEGIN
  -- 1. A confirmation is written only by confirm_next_patient_visit.
  IF OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL AND NOT v_confirming THEN
    RAISE EXCEPTION 'A patient can be confirmed only through the Front Desk confirmation, one patient at a time per doctor.'
      USING ERRCODE = 'P0001', HINT = 'one_confirmation_per_doctor';
  END IF;

  -- 2. confirmed_for follows the confirmation: none without one; the serving doctor once called
  --    or transferred; otherwise only the confirmation itself sets it.
  IF NEW.confirmed_at IS NULL THEN
    NEW.confirmed_for := NULL;
  ELSIF NEW.status::TEXT = 'serving' AND NULLIF(pg_catalog.btrim(COALESCE(NEW.counter_id, '')), '') IS NOT NULL THEN
    NEW.confirmed_for := pg_catalog.btrim(NEW.counter_id);
  ELSIF NEW.confirmed_for IS DISTINCT FROM OLD.confirmed_for AND NOT v_confirming THEN
    RAISE EXCEPTION 'A Front Desk confirmation cannot be changed' USING ERRCODE = 'P0001';
  END IF;

  -- 3. Not Present is written only by set_patient_presence (a Re-queue clears it), and a patient
  --    marked Not Present cannot be confirmed.
  IF (NEW.not_present_at IS DISTINCT FROM OLD.not_present_at OR NEW.not_present_by IS DISTINCT FROM OLD.not_present_by)
     AND NOT v_presence AND NOT (v_requeue AND NEW.not_present_at IS NULL AND NEW.not_present_by IS NULL) THEN
    RAISE EXCEPTION 'Only the Front Desk can mark a patient Not Present or present.' USING ERRCODE = 'P0001', HINT = 'patient_not_present';
  END IF;
  IF NEW.not_present_at IS NOT NULL AND NEW.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This patient is marked Not Present. Mark the patient present before confirming.'
      USING ERRCODE = 'P0001', HINT = 'patient_not_present';
  END IF;

  -- 4. One active visit per doctor: refuse a change that makes this visit active for a doctor
  --    (Undo, transfer, confirmation, ...) while that doctor has another active visit.
  v_day_start := public.qms_oc1_day_start();
  v_new_doctor := public.qms_oc1_active_doctor(NEW.status::TEXT, NEW.service_type, NEW.counter_id, NEW.confirmed_at,
    NEW.confirmed_for, NEW.completed_at, NEW.created_at, v_day_start);
  IF v_new_doctor IS NOT NULL THEN
    v_old_doctor := public.qms_oc1_active_doctor(OLD.status::TEXT, OLD.service_type, OLD.counter_id, OLD.confirmed_at,
      OLD.confirmed_for, OLD.completed_at, OLD.created_at, v_day_start);
    IF v_new_doctor IS DISTINCT FROM v_old_doctor THEN
      v_blocking := public.qms_oc1_active_visit(v_new_doctor, NEW.id, v_day_start);
      IF v_blocking IS NOT NULL THEN
        SELECT a.queue_number INTO v_blocking_number FROM public.patients AS a WHERE a.id = v_blocking;
        RAISE EXCEPTION '% already has an active patient (%). A doctor can have only one confirmed or active patient at a time.',
          v_new_doctor, COALESCE(v_blocking_number, 'unknown') USING ERRCODE = 'P0001', HINT = 'doctor_has_active_patient';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS patients_one_confirmation_per_doctor ON public.patients;
CREATE TRIGGER patients_one_confirmation_per_doctor
  BEFORE UPDATE ON public.patients FOR EACH ROW
  EXECUTE FUNCTION public.qms_oc1_guard_confirmation();

-- ---------------------------------------------------------------------------------------------
-- Confirm the next patient of one doctor.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_next_patient_visit(
  p_patient_id BIGINT,
  p_user_id_num TEXT,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ,
  p_aging BOOLEAN,
  p_dispatch_mode TEXT
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
  v_doctor TEXT;
  v_blocking_id BIGINT;
  v_blocking_number TEXT;
  v_head_id BIGINT;
  v_head_number TEXT;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = ''
     OR p_queue_start IS NULL OR p_queue_end IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR p_queue_end <= p_queue_start
     OR p_aging IS NULL OR p_dispatch_mode IS NULL OR p_dispatch_mode NOT IN ('service', 'shared', 'round_robin') THEN
    RAISE EXCEPTION 'A patient, staff identity, queue window, aging flag and dispatch mode are required' USING ERRCODE = '22023';
  END IF;
  IF p_ranked_at IS NULL OR NOT pg_catalog.isfinite(p_ranked_at)
     OR p_ranked_at < pg_catalog.clock_timestamp() - interval '10 minutes'
     OR p_ranked_at > pg_catalog.clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'The ranking time must be within 10 minutes of the database clock' USING ERRCODE = '22023';
  END IF;

  -- 1. The persisted account: Frontdesk only (no doctor assignment, or the legacy label).
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT <> 'admin'
     OR pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''))) NOT IN ('', 'front desk', 'frontdesk') THEN
    RAISE EXCEPTION 'Only the Front Desk can confirm a patient' USING ERRCODE = '42501';
  END IF;

  -- 2. Every counter, ascending: serializes with Calls, Undo, Re-queue, transfers, round-robin
  --    dispatch, Not Present and other confirmations.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. The visit, locked.
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
  IF v_patient.not_present_at IS NOT NULL THEN
    RAISE EXCEPTION 'This patient is marked Not Present. Mark the patient present before confirming.'
      USING ERRCODE = 'P0001', HINT = 'patient_not_present';
  END IF;

  -- 4. One confirmation at a time per doctor (not in shared dispatch: no doctor before the Call).
  IF p_dispatch_mode <> 'shared' THEN
    v_doctor := public.qms_oc1_visit_doctor(v_patient.service_type, v_patient.counter_id, p_dispatch_mode);
    IF v_doctor IS NULL THEN
      RAISE EXCEPTION 'This patient is waiting for a doctor assignment. It can be confirmed once a doctor is assigned.'
        USING ERRCODE = 'P0001', HINT = 'awaiting_doctor_assignment';
    END IF;

    -- 4a. The doctor's active visit (the same definition the trigger enforces).
    v_blocking_id := public.qms_oc1_active_visit(v_doctor, p_patient_id, p_queue_start);
    IF v_blocking_id IS NOT NULL THEN
      SELECT a.queue_number INTO v_blocking_number FROM public.patients AS a WHERE a.id = v_blocking_id;
      RAISE EXCEPTION '% already has an active patient (%). The next patient can be confirmed after that visit is completed, cancelled or marked no-show.',
        v_doctor, COALESCE(v_blocking_number, 'unknown') USING ERRCODE = 'P0001', HINT = 'doctor_has_active_patient';
    END IF;

    -- 4b. The head of the doctor's present, pending visits, in the unchanged WPS / WPS-A order.
    SELECT w.id, w.queue_number INTO v_head_id, v_head_number FROM public.patients AS w
      WHERE w.status::TEXT = 'waiting' AND w.completed_at IS NULL AND w.confirmed_at IS NULL AND w.not_present_at IS NULL
        AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
        AND public.qms_oc1_visit_doctor(w.service_type, w.counter_id, p_dispatch_mode) = v_doctor
      ORDER BY public.qms_oc1_effective_priority(w.priority_score, w.created_at, p_ranked_at, p_aging) DESC,
        COALESCE(w.priority_score, 0) DESC,
        pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
      LIMIT 1;
    IF v_head_id IS DISTINCT FROM p_patient_id THEN
      RAISE EXCEPTION 'Only the next patient in %''s queue (%) can be confirmed now.', v_doctor, COALESCE(v_head_number, 'unknown')
        USING ERRCODE = 'P0001', HINT = 'not_next_for_doctor';
    END IF;
  END IF;

  -- 5. Confirmation only: status, doctor, priority and queue position are unchanged. The
  --    transaction-local marker is what the OC1 trigger accepts.
  PERFORM pg_catalog.set_config('qms.oc1_confirming_patient', p_patient_id::TEXT, true);
  UPDATE public.patients AS p
    SET confirmed_at = pg_catalog.clock_timestamp(), confirmed_by = v_user.id_num, confirmed_for = v_doctor
    WHERE p.id = p_patient_id AND p.status::TEXT = 'waiting' AND p.confirmed_at IS NULL
    RETURNING p.* INTO v_patient;
  PERFORM pg_catalog.set_config('qms.oc1_confirming_patient', '', true);
  IF NOT FOUND OR v_patient.confirmed_at IS NULL OR v_patient.confirmed_by IS DISTINCT FROM v_user.id_num THEN
    RAISE EXCEPTION 'Unable to save the confirmation';
  END IF;
  RETURN pg_catalog.jsonb_build_object('already_confirmed', false, 'patient', pg_catalog.to_jsonb(v_patient));
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Not Present / Present (Frontdesk only). Only a pending (unconfirmed) waiting visit of today's
-- queue. Changes nothing else: ticket, priority, registration time, doctor and status are kept.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_patient_presence(
  p_patient_id BIGINT,
  p_user_id_num TEXT,
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_present BOOLEAN
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
     OR p_queue_end <= p_queue_start OR p_present IS NULL THEN
    RAISE EXCEPTION 'A patient, staff identity, queue window and presence are required' USING ERRCODE = '22023';
  END IF;

  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT <> 'admin'
     OR pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''))) NOT IN ('', 'front desk', 'frontdesk') THEN
    RAISE EXCEPTION 'Only the Front Desk can mark a patient Not Present or present' USING ERRCODE = '42501';
  END IF;
  -- The same counters lock as a confirmation: a doctor's next patient cannot change mid-confirmation.
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF (v_patient.not_present_at IS NULL) = p_present THEN
    -- Already in the requested state (another desk or a double submission): nothing changes.
    RETURN pg_catalog.jsonb_build_object('changed', false, 'patient', pg_catalog.to_jsonb(v_patient));
  END IF;
  IF NOT p_present THEN
    IF v_patient.status::TEXT <> 'waiting' OR v_patient.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only a waiting patient can be marked Not Present. This visit is %.', v_patient.status::TEXT USING ERRCODE = 'P0001';
    END IF;
    IF v_patient.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'This patient is already confirmed. A confirmed patient who leaves can be cancelled, or marked no-show after the call.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_patient.created_at < p_queue_start OR v_patient.created_at >= p_queue_end THEN
      RAISE EXCEPTION 'Only a visit in today''s queue can be marked Not Present' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('qms.oc1_presence_patient', p_patient_id::TEXT, true);
  UPDATE public.patients AS p
    SET not_present_at = CASE WHEN p_present THEN NULL ELSE pg_catalog.clock_timestamp() END,
      not_present_by = CASE WHEN p_present THEN NULL ELSE v_user.id_num END
    WHERE p.id = p_patient_id
    RETURNING p.* INTO v_patient;
  PERFORM pg_catalog.set_config('qms.oc1_presence_patient', '', true);
  IF NOT FOUND OR (v_patient.not_present_at IS NULL) <> p_present THEN
    RAISE EXCEPTION 'Unable to save the patient''s presence';
  END IF;
  RETURN pg_catalog.jsonb_build_object('changed', true, 'patient', pg_catalog.to_jsonb(v_patient));
END;
$function$;

ALTER FUNCTION public.qms_oc1_service_doctor(TEXT) OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_visit_doctor(TEXT, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_effective_priority(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_day_start() OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_active_doctor(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_active_visit(TEXT, BIGINT, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.qms_oc1_guard_confirmation() OWNER TO postgres;
ALTER FUNCTION public.confirm_next_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) OWNER TO postgres;
ALTER FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) OWNER TO postgres;
-- The guard trigger runs as the writing role, so the helpers it calls stay executable by
-- service_role (they only read); the browser roles get none of them.
REVOKE ALL ON FUNCTION public.qms_oc1_service_doctor(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qms_oc1_visit_doctor(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qms_oc1_effective_priority(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qms_oc1_day_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qms_oc1_active_doctor(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.qms_oc1_active_visit(TEXT, BIGINT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qms_oc1_service_doctor(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.qms_oc1_day_start() TO service_role;
GRANT EXECUTE ON FUNCTION public.qms_oc1_active_doctor(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.qms_oc1_active_visit(TEXT, BIGINT, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.qms_oc1_visit_doctor(TEXT, TEXT, TEXT) FROM service_role;
REVOKE ALL ON FUNCTION public.qms_oc1_effective_priority(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM service_role;
REVOKE ALL ON FUNCTION public.qms_oc1_guard_confirmation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_next_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_next_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
