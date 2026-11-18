-- NS1: remove the Front Desk "Not Present" database function (No-Show / Not Present removal).
-- STATUS: FOR REVIEW. Applying it to a Supabase project needs the owner's written approval.
-- Run 20261118-ns1-preflight.sql first and 20261118-ns1-verify.sql after.
-- Order: either before or after deploying the NS1 backend. That backend no longer calls
-- set_patient_presence, and nothing else in the database calls it.
--
-- WHAT IT DOES
--   1. Returns any patient still marked Not Present to present (live had 0 such rows on
--      2026-11-18). Without the function nobody could ever clear the mark, and OC1's
--      confirm_next_patient_visit skips such a visit, so it would be stuck. Only not_present_at /
--      not_present_by change; ticket, priority, status, doctor and history are untouched.
--   2. Drops public.set_patient_presence(...): it exists only for Not Present / Mark Present.
--
-- INTENTIONALLY KEPT (shared or historical; see the summary in the rollback script):
--   * patients.not_present_at, patients.not_present_by and CHECK patients_not_present_pair.
--     OC1's shared objects read them: qms_oc1_guard_confirmation() (one confirmed/active patient
--     per doctor), qms_guard_front_desk_confirmation() (FC1 + OC1 Re-queue rule) and
--     confirm_next_patient_visit() (WPS / WPS-A next-patient choice). Dropping the columns would
--     mean rewriting those functions. With the setter gone the columns stay NULL forever, so every
--     Not Present check in them is permanently inert: the guard refuses any other writer, and a
--     Re-queue only ever clears them.
--   * queue_status: the live enum never had 'no-show' (verified 2026-11-18), so there is nothing
--     to remove. Text comparisons such as OLD.status::TEXT IN ('completed','cancelled','no-show')
--     inside FC1/OC1/RR1 functions are harmless and are not rewritten.
--   * patient_outcome_attribution (PH1, not installed on live) keeps its CHECK; the backend
--     only ever writes 'cancelled'.
--
-- If 20261113-oc1-one-confirmation-per-doctor.sql is ever re-run, it re-creates
-- set_patient_presence; run this script again afterwards.
-- Rollback: 20261118-ns1-rollback.sql re-creates the function exactly as OC1 installed it.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. Return any set-aside patient to present. The OC1 guard accepts a Not Present change only for
--    the patient named in qms.oc1_presence_patient (the marker set_patient_presence used).
DO $clear_not_present$
DECLARE
  v_id BIGINT;
  v_cleared INTEGER := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'patients' AND column_name = 'not_present_at') THEN
    FOR v_id IN EXECUTE 'SELECT p.id FROM public.patients AS p
        WHERE p.not_present_at IS NOT NULL OR p.not_present_by IS NOT NULL ORDER BY p.id FOR UPDATE' LOOP
      PERFORM pg_catalog.set_config('qms.oc1_presence_patient', v_id::TEXT, true);
      EXECUTE 'UPDATE public.patients SET not_present_at = NULL, not_present_by = NULL WHERE id = $1' USING v_id;
      v_cleared := v_cleared + 1;
    END LOOP;
    PERFORM pg_catalog.set_config('qms.oc1_presence_patient', '', true);
  END IF;
  RAISE NOTICE 'NS1: % patient(s) returned from Not Present to present', v_cleared;
END;
$clear_not_present$;

-- 2. The Not Present / Mark Present function.
DROP FUNCTION IF EXISTS public.set_patient_presence(BIGINT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN);

NOTIFY pgrst, 'reload schema';
COMMIT;
