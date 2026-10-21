-- Phase 2.1: protect Requeue/Undo against stale visit snapshots.
-- Apply to the approved development project after Phase 2. Production needs approval.
-- Add revision metadata only; preserve all existing patients and timing history.
BEGIN;

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS visit_state_revision UUID
  NOT NULL DEFAULT pg_catalog.gen_random_uuid();
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients'
      AND column_name = 'visit_state_revision' AND data_type = 'uuid'
      AND is_nullable = 'NO' AND column_default LIKE '%gen_random_uuid()%'
  ) THEN
    RAISE EXCEPTION 'Existing visit_state_revision must be a non-null UUID with gen_random_uuid() default';
  END IF;
END;
$check$;
COMMENT ON COLUMN public.patients.visit_state_revision IS
  'Database-controlled row revision for conditional recovery. Rotated on every update so repeated statuses and identical legacy timestamps cannot reuse an obsolete visit snapshot.';

CREATE OR REPLACE FUNCTION public.rotate_patient_visit_revision()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  NEW.visit_state_revision := pg_catalog.gen_random_uuid();
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS patients_rotate_visit_revision ON public.patients;
CREATE TRIGGER patients_rotate_visit_revision
  BEFORE UPDATE ON public.patients FOR EACH ROW
  EXECUTE FUNCTION public.rotate_patient_visit_revision();
REVOKE ALL ON FUNCTION public.rotate_patient_visit_revision() FROM PUBLIC, anon, authenticated;

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

  -- Preserve local Frontdesk recovery: waiting visits claim their assigned
  -- service's counter only when Call Now succeeds. Undo reserves no counter.
  RETURN v_patient;
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
