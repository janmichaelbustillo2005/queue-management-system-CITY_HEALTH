-- FC1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261111-fc1-front-desk-confirmation.sql was installed.
--
-- ORDER:
--   1. Deploy the backend version without FC1 and restart it. (The FC1 backend refuses every
--      Call once the columns are gone; the previous backend never reads them.)
--   2. Run this script. It restores each INSTALLED Call function exactly as in its reviewed
--      script (C1, WPS-A, D1, D1-A, RR1; none is newly installed), then drops the guard trigger,
--      its function and confirm_patient_visit.
-- The confirmed_at / confirmed_by columns and their CHECK are KEPT (the confirmation history of
-- past visits; nothing reads them without FC1). To discard that history as well, run the two
-- commented statements at the end. Patients, counters, users, statuses, queue numbers and
-- doctor assignments are not touched. Never uses CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- call_patient_visit: restored exactly as in 20261025-c1-atomic-call.sql, only when installed.
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
    WHERE w.status::TEXT = 'waiting'
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

-- call_patient_visit_wps_a: restored exactly as in 20261029-wps-a-call-aging.sql, only when installed.
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
    WHERE w.status::TEXT = 'waiting'
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

-- call_patient_visit_shared: restored exactly as in 20261029-d1-shared-call.sql, only when installed.
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
    WHERE w.status::TEXT = 'waiting'
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

-- call_patient_visit_shared_wps_a: restored exactly as in 20261029-d1a-shared-wps-a-call.sql, only when installed.
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
    WHERE w.status::TEXT = 'waiting'
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

-- call_patient_visit_rr: restored exactly as in 20261109-rr1-round-robin-dispatch.sql, only when installed.
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
  IF v_patient.counter_id IS DISTINCT FROM p_doctor_name THEN
    RAISE EXCEPTION 'This patient is not assigned to %. Refresh the queue.', p_doctor_name USING ERRCODE = '42501';
  END IF;
  IF v_patient.service_type IS NULL OR NOT (v_patient.service_type = ANY (v_services)) THEN
    RAISE EXCEPTION 'This visit''s service is not configured for doctor assignment';
  END IF;

  -- 4. Priority: the head of this doctor's own list. Round robin chose the doctor; WPS/WPS-A
  --    still decides who that doctor serves first.
  SELECT w.id INTO v_head FROM public.patients AS w
    WHERE w.status::TEXT = 'waiting' AND w.completed_at IS NULL AND w.counter_id = p_doctor_name
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

DROP TRIGGER IF EXISTS patients_front_desk_confirmation ON public.patients;
DROP FUNCTION IF EXISTS public.qms_guard_front_desk_confirmation();
DROP FUNCTION IF EXISTS public.confirm_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ);

-- Optional, discards every recorded confirmation:
-- ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_front_desk_confirmation_pair;
-- ALTER TABLE public.patients DROP COLUMN IF EXISTS confirmed_by, DROP COLUMN IF EXISTS confirmed_at;

COMMIT;
NOTIFY pgrst, 'reload schema';
