-- F5: versioned Requeue entry point. Re-queue only a finished visit and release any stale
-- counter pointer to it in the same transaction.
-- STATUS: REVIEW DRAFT. NOT INSTALLED. Applying it to any Supabase project needs separate
-- written approval. Never execute the original schema/seeding SQL.
-- Requires Phase 2, Phase 2.1 and Phase 2.2 (recover_patient_visit as in
-- 20261014-phase22-undo-waiting.sql). Adds one function; it does not replace
-- recover_patient_visit (whose body is md5-pinned by 20261015-phase22-verify.sql) and
-- does not update patients, counters, triggers or RLS during installation.
--
-- Eligibility: cancelled or no-show visits, and legacy completed visits WITHOUT a recorded
-- consultation start (unchanged existing behavior, pending a policy decision). Waiting and
-- serving visits are refused, so an active call, consultation start and counter are never
-- erased. A completed consultation with a start is refused by recover_patient_visit.
--
-- Lock order: all counters ascending by id, then the patient (inside recover_patient_visit);
-- the same order as Phase 2.2 Undo, Start and Complete.
--
-- Rollback (no data change): deploy the previous backend first, then
--   DROP FUNCTION public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);
-- The backend falls back to recover_patient_visit when this function is absent, except for a
-- visit that still has a counter pointer, which it refuses (503) instead of leaving it stale.
BEGIN;

CREATE OR REPLACE FUNCTION public.requeue_patient_visit(
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
  v_locked_pointers INTEGER;
  v_released INTEGER;
BEGIN
  IF p_action IS DISTINCT FROM 'requeue' THEN
    RAISE EXCEPTION 'This recovery entry point only permits Requeue' USING ERRCODE = '22023';
  END IF;
  -- recover_patient_visit compares the locked row's status with p_expected_status, so
  -- restricting the expected status makes this eligibility check atomic with the write.
  IF p_expected_status IS NULL OR p_expected_status NOT IN ('cancelled', 'no-show', 'completed') THEN
    RAISE EXCEPTION 'Only cancelled or no-show visits can be re-queued';
  END IF;

  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  v_patient := public.recover_patient_visit(p_patient_id, p_action, p_user_id_num,
    p_expected_revision, p_expected_status, p_expected_created_at,
    p_expected_called_at, p_expected_started_at, p_expected_completed_at,
    p_expected_counter_id, p_reason);

  -- A waiting visit owns no counter. Release only pointers to this visit; another
  -- patient's assignment is never touched.
  SELECT pg_catalog.count(*) INTO v_locked_pointers FROM public.counters AS c
    WHERE c.current_patient_id = p_patient_id;
  UPDATE public.counters AS c SET current_patient_id = NULL
    WHERE c.current_patient_id = p_patient_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;

  IF v_released <> v_locked_pointers
      OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id)
      OR v_patient.status::TEXT IS DISTINCT FROM 'waiting'
      OR v_patient.called_at IS NOT NULL OR v_patient.counter_id IS NOT NULL
      OR v_patient.consultation_started_at IS NOT NULL OR v_patient.completed_at IS NOT NULL
      OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision THEN
    -- Rolls back the patient recovery together with the counter release.
    RAISE EXCEPTION 'Unable to re-queue the visit and release its counter';
  END IF;
  RETURN v_patient;
END;
$function$;

REVOKE ALL ON FUNCTION public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
