-- D1-A: shared-queue Call with WPS 10-minute Aging (D1 x WPS-A), provisional.
-- STATUS: REVIEW DRAFT. NOT INSTALLED. Both policies await approval: the shared queue (D1, Model A)
-- and the aging formula P_effective = P_base + min(2, floor(waiting_minutes / 10)) with protected
-- categories winning ties. Applying this to any Supabase project needs separate written approval.
-- The backend uses it only when DOCTOR_DISPATCH_MODE=shared AND WPS_AGING is on.
-- Requires the same prerequisites as D1 (Phase 2, 2.1, 2.2). Adds one function; changes no data,
-- table, trigger or RLS. D1 (call_patient_visit_shared), C1 and WPS-A are not replaced.
--
-- Identical to call_patient_visit_shared (20261029-d1-shared-call.sql) except:
--   * a seventh argument p_ranked_at, the instant the backend ranked (within 10 minutes of the
--     database clock), exactly as call_patient_visit_wps_a;
--   * step 6 orders the shared candidates by WPS-A: effective DESC, priority_score DESC,
--     created_at (ms) ASC, id ASC, with effective = priority_score + LEAST(2, FLOOR(waited / 600 s)),
--     waited = p_ranked_at - created_at in milliseconds (a visit registered later gets no bonus).
-- backend/src/lib/wpsPriority.js (compareWps) holds the same rule; tests compare the two.
-- Candidate set, eligibility, doctor ownership, busy/offline checks, lock order (users -> all
-- counters by id -> patient) and the verified two-row write are D1's, unchanged.
--
-- Rollback (no data change): turn WPS_AGING off (or DOCTOR_DISPATCH_MODE=service), restart the
-- backend, then run 20261029-d1a-rollback.sql.
BEGIN;

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

ALTER FUNCTION public.call_patient_visit_shared_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.call_patient_visit_shared_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_patient_visit_shared_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
