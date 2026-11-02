-- D1: shared-queue Call with flexible doctor assignment (Model A, provisional).
-- STATUS: REVIEW DRAFT. NOT INSTALLED. The shared-versus-separate-queue policy awaits
-- administrator/adviser approval. Applying this to any Supabase project needs separate written
-- approval, and the backend uses it only when DOCTOR_DISPATCH_MODE=shared.
-- Requires Phase 2, Phase 2.1 (visit_state_revision + rotation trigger) and Phase 2.2.
-- Adds one function. It replaces none (C1 stays installed and is still used by the default
-- service-routed mode) and does not update patients, counters, triggers or RLS on installation.
--
-- Confirmed requirement: Doctor 1, Doctor 2 and Doctor 3 are general doctors. Each may serve any
-- configured service. The doctor is chosen when the visit is called (Frontdesk selects one of the
-- available doctors, or a doctor calls for itself); registration assigns no doctor.
--
-- Same contract as C1, with the service-to-doctor routing removed:
--   * staff account (users FOR SHARE): superadmin, Frontdesk, or the doctor's own account;
--   * patient revision unchanged, still waiting, never completed, a configured service, and not
--     holding a legacy Phase 2.1 reservation for a different doctor;
--   * counter exists, online, empty (or holding this visit's legacy reservation);
--   * no other counter points at the visit; the doctor has no other serving visit (a legacy
--     serving row without an assignment still blocks the doctor its service used to route to);
--   * Weighted-Priority order over ONE shared queue: the visit is the first waiting visit this
--     doctor may take, by priority_score DESC, created_at (milliseconds) ASC, id ASC. Visits
--     reserved for another doctor are skipped; every other waiting visit competes.
-- getSharedQueueHead in queueService.js mirrors the ranking; a test compares the two.
--
-- Lock order: users FOR SHARE -> all counters ascending by id FOR UPDATE -> the patient
-- FOR UPDATE. Identical to C1, F5 Requeue, Phase 2.2 Undo and W1 Cancel, so two doctors calling
-- the same visit serialize on the counters and the second sees a changed revision (40001).
-- lock_timeout bounds a wait behind a stuck holder (55P03, nothing committed).
--
-- Errors: 22023 bad arguments, 42501 account/assignment, P0002 patient not found,
-- 40001 visit changed since it was read, P0001 not callable (offline, busy, priority, state).
--
-- Rollback (no data change): set DOCTOR_DISPATCH_MODE=service (or unset) and restart the
-- backend, then run 20261029-d1-rollback.sql.
BEGIN;

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

ALTER FUNCTION public.call_patient_visit_shared(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.call_patient_visit_shared(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_patient_visit_shared(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
