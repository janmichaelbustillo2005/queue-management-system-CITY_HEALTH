-- NS1 rollback: re-creates public.set_patient_presence exactly as
-- 20261113-oc1-one-confirmation-per-doctor.sql installed it (function body, owner and grants are
-- copied verbatim from that script). The columns were never dropped, so nothing else is needed.
-- The NS1 backend has no Not Present routes; to use the function again, also deploy the backend
-- and frontend from before NS1. Patients returned to present by the install stay present.
BEGIN;
SET LOCAL lock_timeout = '5s';

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

ALTER FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
