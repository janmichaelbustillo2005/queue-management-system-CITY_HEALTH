-- Phase 2.2 Stage 1: Undo restores waiting without reserving any doctor.
-- Requires Phase 2 and Phase 2.1 migrations. This replaces only the recovery
-- function and adds a versioned Undo gate; installation does not update
-- patients, counters, triggers or RLS.
-- Prepare/review only: applying to an identified development project requires
-- explicit approval. Never execute the original schema/seeding SQL.
-- Recovery: retain the Phase 2.1 migration as the previous function definition,
-- but do not reinstall its first-free reservation behavior without review.
-- No patient data rollback/backfill is needed or included.
BEGIN;

CREATE OR REPLACE FUNCTION public.recover_patient_visit(
  p_patient_id BIGINT,
  p_action TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_expected_status TEXT,
  p_expected_created_at TIMESTAMPTZ,
  p_expected_called_at TIMESTAMPTZ,
  p_expected_started_at TIMESTAMPTZ,
  p_expected_completed_at TIMESTAMPTZ,
  p_expected_counter_id TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_patient public.patients%ROWTYPE;
  v_role TEXT;
  v_updated_count INTEGER;
  v_counter_count INTEGER;
  v_expected_counter_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0 OR p_action IS NULL
      OR p_action NOT IN ('requeue', 'undo') OR p_expected_revision IS NULL
      OR p_expected_status IS NULL OR p_expected_created_at IS NULL THEN
    RAISE EXCEPTION 'A patient, recovery action and complete visit snapshot are required' USING ERRCODE = '22023';
  END IF;
  -- Preserve the authenticated API's existing staff recovery permissions.
  SELECT u.role::TEXT INTO v_role FROM public.users AS u
    WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required for recovery' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'undo' THEN
    -- Match lifecycle's counter-before-patient lock order. Lock ALL existing
    -- counters by ascending id so stale pointers outside the canonical three
    -- are released safely too. Never select or reserve an available counter.
    PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;
  END IF;
  SELECT p.* INTO v_patient FROM public.patients AS p
    WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision
      OR v_patient.status::TEXT IS DISTINCT FROM p_expected_status
      OR v_patient.created_at IS DISTINCT FROM p_expected_created_at
      OR v_patient.called_at IS DISTINCT FROM p_expected_called_at
      OR v_patient.consultation_started_at IS DISTINCT FROM p_expected_started_at
      OR v_patient.completed_at IS DISTINCT FROM p_expected_completed_at
      OR v_patient.counter_id IS DISTINCT FROM p_expected_counter_id THEN
    RAISE EXCEPTION 'Patient visit changed; refresh before retrying recovery' USING ERRCODE = '40001';
  END IF;
  IF v_patient.status::TEXT = 'completed' AND v_patient.consultation_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed consultation history must be preserved. Register a new visit instead.';
  END IF;
  IF p_action = 'undo' AND v_patient.status::TEXT NOT IN ('completed', 'cancelled', 'no-show') THEN
    RAISE EXCEPTION 'Only completed, cancelled, or no-show patients can be undone';
  END IF;

  IF p_action = 'requeue' THEN
    UPDATE public.patients AS p
      SET status = 'waiting',
          created_at = pg_catalog.clock_timestamp(),
          completed_at = NULL, consultation_started_at = NULL, called_at = NULL,
          counter_id = NULL, reason = p_reason
      WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  ELSE
    -- The service relationship and original priority-tier queue position are
    -- retained. Only the normal authorized Call can acquire the doctor's slot.
    UPDATE public.patients AS p
      SET status = 'waiting', completed_at = NULL, consultation_started_at = NULL,
          called_at = NULL, counter_id = NULL
      WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  END IF;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_patient.status::TEXT <> 'waiting'
      OR v_patient.consultation_started_at IS NOT NULL OR v_patient.completed_at IS NOT NULL
      OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
      OR (p_action = 'undo' AND (v_patient.called_at IS NOT NULL
        OR v_patient.counter_id IS NOT NULL
        OR v_patient.created_at IS DISTINCT FROM p_expected_created_at)) THEN
    RAISE EXCEPTION 'Unable to recover the expected patient visit';
  END IF;

  IF p_action = 'undo' THEN
    SELECT pg_catalog.count(*) INTO v_expected_counter_count FROM public.counters AS c
      WHERE c.current_patient_id = p_patient_id;
    UPDATE public.counters AS c SET current_patient_id = NULL
      WHERE c.current_patient_id = p_patient_id;
    GET DIAGNOSTICS v_counter_count = ROW_COUNT;
    IF v_counter_count <> v_expected_counter_count OR EXISTS (
        SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
      -- Suppressed/failed releases must roll back the patient and revision too.
      RAISE EXCEPTION 'Unable to release the recovered patient counters';
    END IF;
  END IF;
  RETURN v_patient;
END;
$function$;

-- A distinct named RPC prevents the new backend from silently executing the
-- old Phase 2.1 Undo contract when this migration has not been installed.
-- Validate inside the same transaction too: reinstalling the older function
-- behind this wrapper must roll back its first-free counter reservation.
CREATE OR REPLACE FUNCTION public.undo_patient_visit_waiting(
  p_patient_id BIGINT,
  p_action TEXT,
  p_user_id_num TEXT,
  p_expected_revision UUID,
  p_expected_status TEXT,
  p_expected_created_at TIMESTAMPTZ,
  p_expected_called_at TIMESTAMPTZ,
  p_expected_started_at TIMESTAMPTZ,
  p_expected_completed_at TIMESTAMPTZ,
  p_expected_counter_id TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_patient public.patients%ROWTYPE;
BEGIN
  IF p_action IS DISTINCT FROM 'undo' THEN
    RAISE EXCEPTION 'This recovery entry point only permits Undo' USING ERRCODE = '22023';
  END IF;
  v_patient := public.recover_patient_visit(p_patient_id, p_action, p_user_id_num,
    p_expected_revision, p_expected_status, p_expected_created_at,
    p_expected_called_at, p_expected_started_at, p_expected_completed_at,
    p_expected_counter_id, p_reason);
  IF v_patient.status::TEXT IS DISTINCT FROM 'waiting'
      OR v_patient.called_at IS NOT NULL OR v_patient.counter_id IS NOT NULL
      OR v_patient.consultation_started_at IS NOT NULL OR v_patient.completed_at IS NOT NULL
      OR v_patient.created_at IS DISTINCT FROM p_expected_created_at
      OR EXISTS (SELECT 1 FROM public.counters c WHERE c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Phase 2.2 waiting recovery function is required before Undo' USING ERRCODE = '55000';
  END IF;
  RETURN v_patient;
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.undo_patient_visit_waiting(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.undo_patient_visit_waiting(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
