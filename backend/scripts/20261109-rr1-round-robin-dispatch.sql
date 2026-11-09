-- RR1: Round-robin doctor dispatch over the shared WPS / WPS-A queue, with automatic release of
-- pending assignments held by doctors who go offline.
-- STATUS: DRAFT FOR REVIEW. NOT INSTALLED on any hosted project. Applying it to a Supabase
-- project needs separate written approval. The backend uses it only when
-- DOCTOR_DISPATCH_MODE=round_robin; the default "service" mode never calls it.
-- Requires Phase A (staff sessions / get_staff_doctor_presence), Phase 2, Phase 2.1
-- (visit_state_revision + rotation trigger). Run 20261109-rr1-preflight.sql first.
--
-- ADDITIVE ONLY. Adds two tables, six functions and two unique indexes on existing tables
-- (counters.current_patient_id, one serving visit per doctor). Replaces no existing function,
-- alters no existing column, and updates no patient, counter, user or session row.
--
-- Model (see docs in the function comments):
--   * WPS (or WPS-A when the backend runs with WPS_AGING) decides WHO is next: the dispatcher
--     ranks unassigned waiting visits exactly like call_patient_visit_shared(_wps_a):
--     effective priority DESC, priority_score DESC, created_at (ms) ASC, id ASC.
--   * Round robin decides WHICH DOCTOR receives the next-ranked visit: Doctor 1 -> 2 -> 3, skipping
--     doctors that are not eligible. The pointer is persisted in doctor_rotation_state and moves
--     only when an assignment commits.
--   * An assignment is a WAITING visit whose counter_id names the doctor while no counter points at
--     it ("pending"). The assigned doctor's own Call accepts it (call_patient_visit_rr). Nothing is
--     announced until that Call.
--   * Eligible to receive: counter enabled (is_online) AND signed in (Phase A presence: live,
--     unrevoked, unexpired session with a heartbeat in the last 75 s) AND no serving visit AND no
--     counter pointer AND no pending assignment. So each free doctor holds at most one.
--   * A doctor that is signed out, stale or disabled loses its pending assignments: they return to
--     the shared queue with created_at, priority_score and flags untouched, are re-ranked by the
--     same WPS/WPS-A rules and re-dispatched in the same transaction.
--   * A SERVING visit whose doctor is signed out is never moved automatically: it is recorded once
--     as 'intervention_required'; staff may transfer it (transfer_active_consultation).
--   * Every assignment change is recorded in patient_assignment_history.
--
-- Services: the dispatcher and Call accept only qms_rr_approved_services() (the CHO-approved list:
-- consultation, checkup, prenatal, maternity, family_planning). The service never chooses the
-- doctor: every approved service can go to any of the three general doctors.
--
-- Lock order (no cycle with C1/D1/F5/W1/Undo, which take users -> counters -> patient):
--   dispatcher / transfer: doctor_rotation_state FOR UPDATE -> users FOR SHARE (transfer) ->
--   all counters ascending FOR UPDATE -> patients FOR UPDATE.
--   call_patient_visit_rr: users FOR SHARE -> all counters FOR UPDATE -> patient FOR UPDATE.
-- Errors: 22023 bad arguments, 42501 account/assignment, P0002 patient not found,
-- 40001 visit changed since it was read, P0001 not allowed in the current state.
-- Rollback: set DOCTOR_DISPATCH_MODE back, restart, then run 20261109-rr1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.doctor_rotation_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_doctor TEXT CHECK (last_doctor IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
  last_patient_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);
COMMENT ON TABLE public.doctor_rotation_state IS
  'RR1 round-robin pointer: the doctor that received the last committed assignment. Written only by dispatch_round_robin.';
INSERT INTO public.doctor_rotation_state (id, last_doctor) VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.doctor_rotation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.doctor_rotation_state FROM PUBLIC, anon, authenticated;

-- No foreign key: history outlives any later archive/clear of patient rows.
CREATE TABLE IF NOT EXISTS public.patient_assignment_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id BIGINT NOT NULL,
  previous_doctor TEXT,
  new_doctor TEXT,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('round_robin_assignment', 'round_robin_reassignment',
    'doctor_unavailable', 'intervention_required', 'staff_transfer', 'released_for_transfer')),
  automatic BOOLEAN NOT NULL,
  actor_id_num TEXT,
  visit_called_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
COMMENT ON TABLE public.patient_assignment_history IS
  'RR1 audit of doctor assignment changes: automatic round-robin assignments, releases when a doctor became unavailable, intervention notices and staff transfers.';
CREATE INDEX IF NOT EXISTS patient_assignment_history_patient_idx
  ON public.patient_assignment_history (patient_id, created_at);
CREATE INDEX IF NOT EXISTS patient_assignment_history_created_idx
  ON public.patient_assignment_history (created_at);
-- One intervention notice per serving call and doctor, however often the dispatcher runs.
CREATE UNIQUE INDEX IF NOT EXISTS patient_assignment_history_intervention_once
  ON public.patient_assignment_history (patient_id, previous_doctor, visit_called_at)
  WHERE reason = 'intervention_required';
ALTER TABLE public.patient_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.patient_assignment_history FROM PUBLIC, anon, authenticated;
-- Supabase default privileges also grant the identity sequence to the browser roles.
REVOKE ALL ON SEQUENCE public.patient_assignment_history_id_seq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Database-level ownership guarantees (every dispatch mode). Existing code already keeps both;
-- the indexes make any violation impossible rather than merely avoided. Creation fails (and
-- the whole migration rolls back) if existing rows already break them: run the preflight.
--   * a visit is pointed at by at most one doctor counter;
--   * a doctor has at most one serving visit.
-- ---------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS counters_current_patient_once
  ON public.counters (current_patient_id) WHERE current_patient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS patients_one_serving_visit_per_doctor
  ON public.patients (counter_id) WHERE status = 'serving' AND counter_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Doctor state: one definition of enabled / signed in / busy / pending, used by every function.
-- Presence is the Phase A definition, read through get_staff_doctor_presence().
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qms_rr_doctor_state(p_queue_start TIMESTAMPTZ, p_queue_end TIMESTAMPTZ)
RETURNS TABLE (doctor_name TEXT, counter_id BIGINT, enabled BOOLEAN, signed_in BOOLEAN,
  last_seen_at TIMESTAMPTZ, current_patient_id BIGINT, serving_patient_id BIGINT,
  pending_patient_id BIGINT, eligible BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH presence AS (
    SELECT d.value->>'doctor_name' AS doctor_name, (d.value->>'online')::BOOLEAN AS online,
      (d.value->>'last_seen_at')::TIMESTAMPTZ AS last_seen_at
    FROM pg_catalog.jsonb_array_elements(public.get_staff_doctor_presence()->'doctors') AS d(value)
  ), state AS (
    SELECT c.id_num::TEXT AS doctor_name, c.id AS counter_id, COALESCE(c.is_online, false) AS enabled,
      COALESCE(p.online, false) AS signed_in, p.last_seen_at, c.current_patient_id,
      (SELECT s.id FROM public.patients AS s WHERE s.status::TEXT = 'serving' AND s.counter_id = c.id_num
        ORDER BY s.id LIMIT 1) AS serving_patient_id,
      (SELECT w.id FROM public.patients AS w
        WHERE w.status::TEXT = 'waiting' AND w.counter_id = c.id_num
          AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
          AND NOT EXISTS (SELECT 1 FROM public.counters AS x WHERE x.current_patient_id = w.id)
        ORDER BY w.id LIMIT 1) AS pending_patient_id
    FROM public.counters AS c
    LEFT JOIN presence AS p ON p.doctor_name = c.id_num
    WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
  )
  SELECT s.doctor_name, s.counter_id, s.enabled, s.signed_in, s.last_seen_at, s.current_patient_id,
    s.serving_patient_id, s.pending_patient_id,
    s.enabled AND s.signed_in AND s.current_patient_id IS NULL AND s.serving_patient_id IS NULL
      AND s.pending_patient_id IS NULL AS eligible
  FROM state AS s ORDER BY s.doctor_name;
$function$;

-- ---------------------------------------------------------------------------------------------
-- The services the three general doctors are approved to take from the shared queue. The ONLY
-- list the dispatcher and the round-robin Call use; queueService.js APPROVED_GENERAL_SERVICES
-- must match it (a test compares them). City Health administrator confirmation of 2026-10-29
-- (docs/d1-flexible-doctor-assignment-20261029.md). Approving another service means adding its
-- key here and in queueService.js, after CHO approval; nothing else changes.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qms_rr_approved_services()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT ARRAY['consultation', 'checkup', 'prenatal', 'maternity', 'family_planning']::TEXT[];
$function$;

-- ---------------------------------------------------------------------------------------------
-- Dispatcher: release, flag, assign. Idempotent; safe to call from any number of backends.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_round_robin(
  p_queue_start TIMESTAMPTZ,
  p_queue_end TIMESTAMPTZ,
  p_ranked_at TIMESTAMPTZ,
  p_aging BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_services CONSTANT TEXT[] := public.qms_rr_approved_services();
  v_doctors CONSTANT TEXT[] := ARRAY['Doctor 1', 'Doctor 2', 'Doctor 3'];
  -- Doctor state read ONCE per pass, after the locks: every decision below uses the same view
  -- of presence, so a heartbeat crossing the 75-second line mid-pass cannot split decisions.
  v_state JSONB;
  v_last TEXT;
  v_start INTEGER;
  v_candidate TEXT;
  v_order TEXT[] := ARRAY[]::TEXT[];
  v_row RECORD;
  v_next_id BIGINT;
  v_released JSONB := '[]'::JSONB;
  v_assigned JSONB := '[]'::JSONB;
  v_flagged JSONB := '[]'::JSONB;
  v_any_available BOOLEAN;
  v_unassigned BIGINT;
BEGIN
  IF p_queue_start IS NULL OR p_queue_end IS NULL OR p_ranked_at IS NULL OR p_aging IS NULL
     OR NOT pg_catalog.isfinite(p_queue_start) OR NOT pg_catalog.isfinite(p_queue_end)
     OR NOT pg_catalog.isfinite(p_ranked_at) OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A queue window, ranking instant and aging flag are required' USING ERRCODE = '22023';
  END IF;

  -- 1. One dispatcher at a time (every backend instance), then every counter, as Call does.
  SELECT s.last_doctor INTO v_last FROM public.doctor_rotation_state AS s WHERE s.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The doctor rotation is not initialised (RR1 migration incomplete)';
  END IF;
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;
  SELECT COALESCE(pg_catalog.jsonb_object_agg(d.doctor_name, pg_catalog.to_jsonb(d)), '{}'::JSONB) INTO v_state
    FROM public.qms_rr_doctor_state(p_queue_start, p_queue_end) AS d;

  -- 2. Release pending assignments of doctors that are signed out, stale or disabled. A legacy
  --    Phase 2.1 reservation (a counter points at the visit) is not a pending assignment.
  FOR v_row IN
    SELECT w.id, w.counter_id::TEXT AS doctor
    FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.completed_at IS NULL
      AND w.counter_id::TEXT = ANY (v_doctors)
      AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND NOT (COALESCE((v_state->(w.counter_id::TEXT)->>'enabled')::BOOLEAN, false)
        AND COALESCE((v_state->(w.counter_id::TEXT)->>'signed_in')::BOOLEAN, false))
      AND NOT EXISTS (SELECT 1 FROM public.counters AS x WHERE x.current_patient_id = w.id)
    ORDER BY w.id
    FOR UPDATE OF w
  LOOP
    -- created_at, priority_score and vulnerability_flags are not touched: waiting time and
    -- WPS/WPS-A rank are preserved. The revision rotates, so stale actions on it fail.
    UPDATE public.patients AS p SET counter_id = NULL
      WHERE p.id = v_row.id AND p.status::TEXT = 'waiting' AND p.counter_id = v_row.doctor;
    INSERT INTO public.patient_assignment_history
        (patient_id, previous_doctor, new_doctor, previous_status, new_status, reason, automatic)
      VALUES (v_row.id, v_row.doctor, NULL, 'waiting', 'waiting', 'doctor_unavailable', true);
    v_released := v_released || pg_catalog.jsonb_build_object('patient_id', v_row.id, 'doctor', v_row.doctor);
  END LOOP;

  -- 3. A serving visit whose doctor is signed out stays with that doctor; staff are told once.
  FOR v_row IN
    INSERT INTO public.patient_assignment_history
        (patient_id, previous_doctor, new_doctor, previous_status, new_status, reason, automatic, visit_called_at)
      SELECT s.id, s.counter_id, s.counter_id, 'serving', 'serving', 'intervention_required', true, s.called_at
      FROM public.patients AS s
      WHERE s.status::TEXT = 'serving' AND s.completed_at IS NULL AND s.counter_id::TEXT = ANY (v_doctors)
        AND NOT COALESCE((v_state->(s.counter_id::TEXT)->>'signed_in')::BOOLEAN, false)
      ON CONFLICT (patient_id, previous_doctor, visit_called_at) WHERE reason = 'intervention_required' DO NOTHING
      RETURNING patient_id, previous_doctor
  LOOP
    v_flagged := v_flagged || pg_catalog.jsonb_build_object('patient_id', v_row.patient_id, 'doctor', v_row.previous_doctor);
  END LOOP;

  -- 4. Eligible doctors in rotation order, starting after the last doctor assigned.
  v_start := COALESCE(pg_catalog.array_position(v_doctors, v_last), 0);
  FOR i IN 1..3 LOOP
    v_candidate := v_doctors[((v_start + i - 1) % 3) + 1];
    -- Eligibility from the same snapshot. A doctor whose pending visit step 2 just released was
    -- not enabled-and-signed-in, so it is not eligible either.
    IF COALESCE((v_state->v_candidate->>'eligible')::BOOLEAN, false) THEN
      v_order := v_order || v_candidate;
    END IF;
  END LOOP;

  -- 5. Each eligible doctor, in turn, receives the highest-ranked unassigned visit.
  FOREACH v_candidate IN ARRAY v_order LOOP
    SELECT w.id INTO v_next_id FROM public.patients AS w
      WHERE w.status::TEXT = 'waiting' AND w.completed_at IS NULL
        AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
        AND w.service_type = ANY (v_services)
        AND NULLIF(pg_catalog.btrim(w.counter_id), '') IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.counters AS x WHERE x.current_patient_id = w.id)
      ORDER BY COALESCE(w.priority_score, 0) + CASE WHEN p_aging THEN LEAST(2, GREATEST(0, pg_catalog.floor(
          EXTRACT(EPOCH FROM (pg_catalog.date_trunc('milliseconds', p_ranked_at)
            - pg_catalog.date_trunc('milliseconds', w.created_at))) / 600)))::INTEGER ELSE 0 END DESC,
        COALESCE(w.priority_score, 0) DESC,
        pg_catalog.date_trunc('milliseconds', w.created_at) ASC, w.id ASC
      LIMIT 1
      FOR UPDATE OF w;
    EXIT WHEN v_next_id IS NULL;
    UPDATE public.patients AS p SET counter_id = v_candidate
      WHERE p.id = v_next_id AND p.status::TEXT = 'waiting' AND p.counter_id IS NULL;
    INSERT INTO public.patient_assignment_history
        (patient_id, previous_doctor, new_doctor, previous_status, new_status, reason, automatic)
      VALUES (v_next_id, NULL, v_candidate, 'waiting', 'waiting',
        CASE WHEN EXISTS (SELECT 1 FROM public.patient_assignment_history AS h
            WHERE h.patient_id = v_next_id AND h.reason = 'doctor_unavailable')
          THEN 'round_robin_reassignment' ELSE 'round_robin_assignment' END, true);
    UPDATE public.doctor_rotation_state AS s
      SET last_doctor = v_candidate, last_patient_id = v_next_id, updated_at = pg_catalog.clock_timestamp()
      WHERE s.id = 1;
    v_assigned := v_assigned || pg_catalog.jsonb_build_object('patient_id', v_next_id, 'doctor', v_candidate);
    v_next_id := NULL;
  END LOOP;

  SELECT pg_catalog.bool_or((d.value->>'enabled')::BOOLEAN AND (d.value->>'signed_in')::BOOLEAN) INTO v_any_available
    FROM pg_catalog.jsonb_each(v_state) AS d;
  SELECT pg_catalog.count(*) INTO v_unassigned FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.created_at >= p_queue_start AND w.created_at < p_queue_end
      AND NULLIF(pg_catalog.btrim(w.counter_id), '') IS NULL;
  RETURN pg_catalog.jsonb_build_object('released', v_released, 'assigned', v_assigned,
    'interventions', v_flagged, 'all_unavailable', NOT COALESCE(v_any_available, false),
    'unassigned_waiting', v_unassigned);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Call: the assigned doctor accepts its pending assignment. No ranking here: the dispatcher
-- ranked when it assigned. Same writes and verification as call_patient_visit_shared.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.call_patient_visit_rr(
  p_patient_id BIGINT,
  p_doctor_name TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID
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
  v_updated_count INTEGER;
  v_claimed_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_doctor_name IS NULL OR p_doctor_name NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = '' OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'A patient, doctor, staff identity and visit revision are required' USING ERRCODE = '22023';
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
  IF v_patient.counter_id IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'This patient is not assigned to %. Refresh the queue.', p_doctor_name USING ERRCODE = '42501';
  END IF;
  IF v_patient.service_type IS NULL OR NOT (v_patient.service_type = ANY (v_services)) THEN
    RAISE EXCEPTION 'This visit''s service is not configured for doctor assignment';
  END IF;

  -- 4. Availability and the one-active-patient rule.
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

  -- 5. Both writes, verified; any failure rolls both back.
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

-- ---------------------------------------------------------------------------------------------
-- Staff transfer of a serving visit whose doctor is signed out (intervention).
-- Superadmin or Frontdesk only. The visit keeps its call and consultation timestamps; its
-- doctor and counter pointer move together, so it is never held by two doctors.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_active_consultation(
  p_patient_id BIGINT,
  p_new_doctor TEXT,
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
  v_patient public.patients%ROWTYPE;
  v_old TEXT;
  v_new RECORD;
  v_old_signed_in BOOLEAN;
  v_pending BIGINT;
  v_updated_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0
     OR p_new_doctor IS NULL OR p_new_doctor NOT IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num) = '' OR p_expected_revision IS NULL
     OR p_queue_start IS NULL OR p_queue_end IS NULL OR p_queue_end <= p_queue_start THEN
    RAISE EXCEPTION 'A patient, new doctor, staff identity, visit revision and queue window are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.doctor_rotation_state AS s WHERE s.id = 1 FOR UPDATE;
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR NOT (v_user.role::TEXT = 'superadmin' OR (v_user.role::TEXT = 'admin'
      AND pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''))) IN ('', 'front desk', 'frontdesk'))) THEN
    RAISE EXCEPTION 'Only Frontdesk or Super Admin can transfer a consultation' USING ERRCODE = '42501';
  END IF;
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Patient visit changed; refresh the queue before transferring' USING ERRCODE = '40001';
  END IF;
  v_old := NULLIF(pg_catalog.btrim(v_patient.counter_id), '');
  IF v_patient.status::TEXT <> 'serving' OR v_patient.completed_at IS NOT NULL OR v_old IS NULL THEN
    RAISE EXCEPTION 'Only a serving consultation with an assigned doctor can be transferred';
  END IF;
  IF v_old = p_new_doctor THEN
    RAISE EXCEPTION 'The consultation is already assigned to %', p_new_doctor;
  END IF;

  SELECT d.signed_in INTO v_old_signed_in FROM public.qms_rr_doctor_state(p_queue_start, p_queue_end) AS d
    WHERE d.doctor_name = v_old;
  IF COALESCE(v_old_signed_in, false) THEN
    RAISE EXCEPTION '% is still signed in. A consultation is transferred only when its doctor is unavailable.', v_old;
  END IF;
  SELECT d.* INTO v_new FROM public.qms_rr_doctor_state(p_queue_start, p_queue_end) AS d
    WHERE d.doctor_name = p_new_doctor;
  IF NOT FOUND OR NOT v_new.enabled OR NOT v_new.signed_in THEN
    RAISE EXCEPTION '% is not signed in and available.', p_new_doctor;
  END IF;
  IF v_new.current_patient_id IS NOT NULL OR v_new.serving_patient_id IS NOT NULL THEN
    RAISE EXCEPTION '% is already serving a patient', p_new_doctor;
  END IF;

  -- The receiving doctor's pending assignment goes back to the shared queue, rank preserved.
  v_pending := v_new.pending_patient_id;
  IF v_pending IS NOT NULL THEN
    UPDATE public.patients AS w SET counter_id = NULL
      WHERE w.id = v_pending AND w.status::TEXT = 'waiting' AND w.counter_id = p_new_doctor;
    INSERT INTO public.patient_assignment_history
        (patient_id, previous_doctor, new_doctor, previous_status, new_status, reason, automatic, actor_id_num)
      VALUES (v_pending, p_new_doctor, NULL, 'waiting', 'waiting', 'released_for_transfer', false, p_user_id_num);
  END IF;

  UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
  UPDATE public.patients AS p SET counter_id = p_new_doctor
    WHERE p.id = p_patient_id AND p.status::TEXT = 'serving' RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = p_patient_id
    WHERE c.id_num = p_new_doctor AND c.current_patient_id IS NULL;
  IF v_updated_count <> 1 OR v_patient.counter_id IS DISTINCT FROM p_new_doctor
     OR (SELECT pg_catalog.count(*) FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.counters AS c WHERE c.id_num = p_new_doctor AND c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Unable to transfer the consultation and its doctor counter together';
  END IF;
  INSERT INTO public.patient_assignment_history
      (patient_id, previous_doctor, new_doctor, previous_status, new_status, reason, automatic, actor_id_num, visit_called_at)
    VALUES (p_patient_id, v_old, p_new_doctor, 'serving', 'serving', 'staff_transfer', false, p_user_id_num, v_patient.called_at);
  RETURN v_patient;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Read-only status for Frontdesk / doctor screens: doctor states, open interventions and
-- the assignment history of the queue window.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_round_robin_dispatch_status(p_queue_start TIMESTAMPTZ, p_queue_end TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH doctors AS (SELECT * FROM public.qms_rr_doctor_state(p_queue_start, p_queue_end))
  SELECT pg_catalog.jsonb_build_object(
    'doctors', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'doctor_name', d.doctor_name, 'enabled', d.enabled, 'signed_in', d.signed_in,
        'last_seen_at', d.last_seen_at, 'serving_patient_id', COALESCE(d.serving_patient_id, d.current_patient_id),
        'pending_patient_id', d.pending_patient_id, 'eligible', d.eligible) ORDER BY d.doctor_name) FROM doctors AS d), '[]'::JSONB),
    'all_unavailable', NOT COALESCE((SELECT pg_catalog.bool_or(d.enabled AND d.signed_in) FROM doctors AS d), false),
    'interventions', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'patient_id', s.id, 'doctor', s.counter_id, 'called_at', s.called_at,
        'consultation_started_at', s.consultation_started_at) ORDER BY s.id)
      FROM public.patients AS s JOIN doctors AS d ON d.doctor_name = s.counter_id
      WHERE s.status::TEXT = 'serving' AND s.completed_at IS NULL AND NOT d.signed_in), '[]'::JSONB),
    'history', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'patient_id', h.patient_id, 'previous_doctor', h.previous_doctor, 'new_doctor', h.new_doctor,
        'previous_status', h.previous_status, 'new_status', h.new_status, 'reason', h.reason,
        'automatic', h.automatic, 'created_at', h.created_at) ORDER BY h.id)
      FROM public.patient_assignment_history AS h
      WHERE h.patient_id IN (SELECT p.id FROM public.patients AS p
        WHERE p.created_at >= p_queue_start AND p.created_at < p_queue_end)), '[]'::JSONB),
    'observed_at', pg_catalog.clock_timestamp());
$function$;

-- ---------------------------------------------------------------------------------------------
-- Ownership and grants: service_role (the backend) only.
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.qms_rr_doctor_state(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.qms_rr_approved_services() OWNER TO postgres;
ALTER FUNCTION public.dispatch_round_robin(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) OWNER TO postgres;
ALTER FUNCTION public.call_patient_visit_rr(BIGINT, TEXT, TEXT, UUID) OWNER TO postgres;
ALTER FUNCTION public.transfer_active_consultation(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
ALTER FUNCTION public.get_round_robin_dispatch_status(TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.qms_rr_doctor_state(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.dispatch_round_robin(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.call_patient_visit_rr(BIGINT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_active_consultation(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_round_robin_dispatch_status(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_round_robin(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.call_patient_visit_rr(BIGINT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.transfer_active_consultation(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_round_robin_dispatch_status(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION public.qms_rr_approved_services() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.qms_rr_approved_services() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
