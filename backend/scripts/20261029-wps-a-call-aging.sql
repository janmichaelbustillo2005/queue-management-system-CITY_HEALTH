-- WPS-A: atomic Call with 10-minute aging. A twin of C1 (20261025-c1-atomic-call.sql) for the
-- proposed Weighted-Priority Scheduling with Aging; C1 itself is not changed.
-- STATUS: DEVELOPMENT DRAFT. NOT INSTALLED. The aging policy (10-minute step, +2 cap, tie rules)
-- needs adviser / City Health Office approval, and applying this file to any Supabase project
-- needs separate written approval. The backend uses it only when WPS_AGING is enabled.
-- Requires C1's prerequisites (Phase 2, 2.1, 2.2). Adds one function; changes no data.
--
-- Identical to call_patient_visit except for the Weighted-Priority check (step 6):
--   effective = priority_score + LEAST(2, FLOOR(waited / 10 minutes)), waited = p_ranked_at -
--   created_at (both in milliseconds, as the backend compares); a visit registered after
--   p_ranked_at gets no bonus. Order: effective DESC, priority_score DESC (a protected category
--   wins a tie), created_at ASC, id ASC. The backend passes the instant it ranked at, so Node and
--   PostgreSQL compute the same bonus even when their clocks differ; it must be within 10
--   minutes of the database clock. backend/src/lib/wpsPriority.js holds the same constants and a
--   test compares the two orders.
-- Consultation stays non-preemptive: only waiting visits are ranked.
--
-- Rollback (no data change): set WPS_AGING off (the backend returns to C1), then
--   DROP FUNCTION public.call_patient_visit_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
BEGIN;

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

REVOKE ALL ON FUNCTION public.call_patient_visit_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_patient_visit_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
