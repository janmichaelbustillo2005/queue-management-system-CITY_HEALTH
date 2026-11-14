-- OC1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261113-oc1-one-confirmation-per-doctor.sql was installed.
--
-- ORDER:
--   1. Deploy the backend version without OC1 (it confirms through FC1's confirm_patient_visit and
--      has no Not Present action) and restart it. The OC1 backend refuses every confirmation and
--      Not Present action once these functions are gone.
--   2. Run this script. It drops OC1's trigger and functions and restores FC1's guard function
--      exactly as in 20261111-fc1-front-desk-confirmation.sql. FC1 (columns, trigger,
--      confirm_patient_visit, Call functions) and every existing confirmation are kept.
-- The columns confirmed_for, not_present_at and not_present_by and the CHECK patients_not_present_pair
-- are KEPT (history; nothing reads them without OC1). Patients marked Not Present simply become
-- pending again. To discard the columns as well, run the commented statements at the end.
-- Never uses CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS patients_one_confirmation_per_doctor ON public.patients;
DROP FUNCTION IF EXISTS public.qms_oc1_guard_confirmation();
DROP FUNCTION IF EXISTS public.confirm_next_patient_visit(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);
DROP FUNCTION IF EXISTS public.qms_oc1_active_visit(TEXT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qms_oc1_active_doctor(TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.qms_oc1_day_start();
DROP FUNCTION IF EXISTS public.qms_oc1_effective_priority(INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);
DROP FUNCTION IF EXISTS public.qms_oc1_visit_doctor(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qms_oc1_service_doctor(TEXT);

-- FC1's guard, restored exactly as in 20261111-fc1-front-desk-confirmation.sql (only when FC1's
-- trigger is still installed).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = 'public.patients'::regclass
      AND tgname = 'patients_front_desk_confirmation') THEN
    EXECUTE $oc1$
CREATE OR REPLACE FUNCTION public.qms_guard_front_desk_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status::TEXT = 'waiting' AND OLD.status::TEXT IN ('completed', 'cancelled', 'no-show')
     AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    -- Re-queue: a new turn at the end of the queue needs a new confirmation.
    NEW.confirmed_at := NULL;
    NEW.confirmed_by := NULL;
  ELSIF OLD.confirmed_at IS NOT NULL THEN
    IF NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by THEN
      RAISE EXCEPTION 'A Front Desk confirmation cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.confirmed_at IS NOT NULL OR NEW.confirmed_by IS NOT NULL THEN
    IF OLD.status::TEXT <> 'waiting' OR NEW.status::TEXT <> 'waiting' OR OLD.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Only a waiting patient can be confirmed by the Front Desk' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF OLD.status::TEXT = 'waiting' AND NEW.status::TEXT = 'serving' AND NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'This patient has not been confirmed by the Front Desk yet. A doctor can call a patient only after the Front Desk confirms the visit.'
      USING ERRCODE = 'P0001', HINT = 'awaiting_front_desk_confirmation';
  END IF;
  RETURN NEW;
END;
$function$;
$oc1$;
  END IF;
END;
$do$;

-- Optional, discards the OC1 history columns (uncomment only with approval):
-- ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_not_present_pair;
-- ALTER TABLE public.patients DROP COLUMN IF EXISTS not_present_by, DROP COLUMN IF EXISTS not_present_at, DROP COLUMN IF EXISTS confirmed_for;

NOTIFY pgrst, 'reload schema';
COMMIT;
