-- Disposable PostgreSQL test fixture only. Never apply to a live database.
-- Preserves the pre-Phase-2.2 first-free Undo contract from 9c8da15 so the
-- waiting-only wrapper is tested against an accidental legacy replacement.
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
  v_counter public.counters%ROWTYPE;
  v_role TEXT;
  v_updated_count INTEGER;
  v_counter_count INTEGER;
BEGIN
  IF p_patient_id IS NULL OR p_patient_id <= 0 OR p_action IS NULL
      OR p_action NOT IN ('requeue', 'undo') OR p_expected_revision IS NULL
      OR p_expected_status IS NULL OR p_expected_created_at IS NULL THEN
    RAISE EXCEPTION 'A patient, recovery action and complete visit snapshot are required' USING ERRCODE = '22023';
  END IF;
  -- req.user comes from the existing authenticated API. Keep the legacy admin
  -- and superadmin recovery permissions; do not redesign doctor assignment.
  SELECT u.role::TEXT INTO v_role FROM public.users AS u
    WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_role NOT IN ('admin', 'superadmin') THEN
    RAISE EXCEPTION 'An authenticated staff account is required for recovery' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'undo' THEN
    -- Match the lifecycle counter-before-patient lock order. Lock the small
    -- canonical counter set deterministically before choosing the first free
    -- online counter, preserving the legacy selection rule for Phase 2.2.
    PERFORM c.id FROM public.counters AS c
      WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
      ORDER BY c.id FOR UPDATE;
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
    UPDATE public.patients AS p
      SET status = 'waiting', completed_at = NULL, consultation_started_at = NULL
      WHERE p.id = p_patient_id RETURNING p.* INTO v_patient;
  END IF;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 OR v_patient.status::TEXT <> 'waiting'
      OR v_patient.consultation_started_at IS NOT NULL OR v_patient.completed_at IS NOT NULL
      OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Unable to recover the expected patient visit';
  END IF;

  IF p_action = 'undo' THEN
    SELECT c.* INTO v_counter FROM public.counters AS c
      WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')
        AND c.is_online AND c.current_patient_id IS NULL
      ORDER BY c.id LIMIT 1;
    IF FOUND THEN
      UPDATE public.counters AS c SET current_patient_id = p_patient_id
        WHERE c.id = v_counter.id AND c.is_online AND c.current_patient_id IS NULL;
      GET DIAGNOSTICS v_counter_count = ROW_COUNT;
      IF v_counter_count <> 1 OR NOT EXISTS (
          SELECT 1 FROM public.counters AS c
          WHERE c.id = v_counter.id AND c.current_patient_id = p_patient_id) THEN
        RAISE EXCEPTION 'Unable to reserve the recovery counter';
      END IF;
    END IF;
  END IF;
  RETURN v_patient;
END;
$function$;
