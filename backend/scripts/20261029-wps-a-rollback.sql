-- WPS-A rollback. Removes only call_patient_visit_wps_a; C1 and all data are untouched.
-- Turn WPS_AGING off in the backend first (it then calls C1 again).
BEGIN;
DROP FUNCTION IF EXISTS public.call_patient_visit_wps_a(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
NOTIFY pgrst, 'reload schema';
COMMIT;
