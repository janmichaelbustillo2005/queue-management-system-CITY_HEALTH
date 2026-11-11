-- RR1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261109-rr1-round-robin-dispatch.sql was installed.
--
-- ORDER:
--   1. Set DOCTOR_DISPATCH_MODE to its previous value (unset = service) and restart the backend.
--      No other mode calls these functions, so nothing depends on them any more.
--   2. Run this script. By default it KEEPS public.patient_assignment_history (audit evidence) and
--      drops only the functions and the rotation pointer. To drop the history too, set
--      v_drop_history to true below after exporting it.
--
-- Waiting visits that still hold a round-robin assignment keep it (with round robin, every visit
-- registered that day has one). In "shared" mode they stay callable only by that doctor; in "service" mode C1 refuses a visit stored for a doctor other
-- than its service's doctor. Before switching to "service", either finish those visits or
-- release them (reviewed, optional):
--   SELECT p.id, p.queue_number, p.counter_id FROM public.patients AS p
--    WHERE p.status::TEXT = 'waiting' AND NULLIF(pg_catalog.btrim(p.counter_id), '') IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p.id);
--   UPDATE public.patients AS p SET counter_id = NULL
--    WHERE p.status::TEXT = 'waiting' AND NULLIF(pg_catalog.btrim(p.counter_id), '') IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p.id);
-- Patient, counter, user and session rows and every other function are not touched. Never uses
-- CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE
  v_drop_history CONSTANT BOOLEAN := false;
  v_fn REGPROCEDURE;
  v_callers TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    pg_catalog.to_regprocedure('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)'),
    pg_catalog.to_regprocedure('public.register_visit_round_robin(jsonb,timestamptz,timestamptz)'),
    pg_catalog.to_regprocedure('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)'),
    -- An earlier draft's Call signature, if that draft was ever installed.
    pg_catalog.to_regprocedure('public.call_patient_visit_rr(bigint,text,text,uuid)'),
    pg_catalog.to_regprocedure('public.transfer_active_consultation(bigint,text,text,uuid,timestamptz,timestamptz)'),
    pg_catalog.to_regprocedure('public.get_round_robin_dispatch_status(timestamptz,timestamptz)'),
    pg_catalog.to_regprocedure('public.qms_rr_doctor_state(timestamptz,timestamptz)'),
    pg_catalog.to_regprocedure('public.qms_rr_approved_services()'),
    pg_catalog.to_regprocedure('public.qms_rr_next_doctor(text,text[])'),
    pg_catalog.to_regprocedure('public.qms_rr_effective_priority(integer,timestamptz,timestamptz,boolean)')] LOOP
    CONTINUE WHEN v_fn IS NULL;
    SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::TEXT, ', ') INTO v_callers
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid <> v_fn AND p.proname NOT IN ('register_visit_round_robin', 'dispatch_round_robin', 'call_patient_visit_rr',
          'transfer_active_consultation', 'get_round_robin_dispatch_status', 'qms_rr_doctor_state',
          'qms_rr_approved_services', 'qms_rr_next_doctor', 'qms_rr_effective_priority')
        AND p.prosrc ~ ('\m' || (SELECT pr.proname FROM pg_catalog.pg_proc AS pr WHERE pr.oid = v_fn) || '\M');
    IF v_callers IS NOT NULL THEN
      RAISE EXCEPTION 'RR1 rollback refused: % is used by [%]. Nothing was changed.', v_fn, v_callers;
    END IF;
  END LOOP;

  DROP FUNCTION IF EXISTS public.register_visit_round_robin(JSONB, TIMESTAMPTZ, TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS public.dispatch_round_robin(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);
  DROP FUNCTION IF EXISTS public.call_patient_visit_rr(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);
  DROP FUNCTION IF EXISTS public.call_patient_visit_rr(BIGINT, TEXT, TEXT, UUID);
  DROP FUNCTION IF EXISTS public.transfer_active_consultation(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS public.get_round_robin_dispatch_status(TIMESTAMPTZ, TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS public.qms_rr_doctor_state(TIMESTAMPTZ, TIMESTAMPTZ);
  DROP FUNCTION IF EXISTS public.qms_rr_approved_services();
  DROP FUNCTION IF EXISTS public.qms_rr_next_doctor(TEXT, TEXT[]);
  DROP FUNCTION IF EXISTS public.qms_rr_effective_priority(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);
  -- The two ownership indexes RR1 added to existing tables (no data is changed by dropping them).
  DROP INDEX IF EXISTS public.counters_current_patient_once;
  DROP INDEX IF EXISTS public.patients_one_serving_visit_per_doctor;
  DROP INDEX IF EXISTS public.patients_queue_number_unique;
  DROP TABLE IF EXISTS public.doctor_rotation_state;
  IF v_drop_history THEN
    DROP TABLE IF EXISTS public.patient_assignment_history;
  END IF;
END
$rollback$;
NOTIFY pgrst, 'reload schema';
COMMIT;
