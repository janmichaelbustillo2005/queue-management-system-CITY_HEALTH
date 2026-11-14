-- PH1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261114-ph1-patient-history.sql was installed.
--
-- ORDER: none required. The PH1 backend keeps working without the table: Cancel and No-show are
-- unaffected (the attribution insert is best-effort), and Patient History then lists completed
-- consultations only and says that cancellation and no-show attribution is unavailable.
-- DATA LOSS: every recorded "cancelled by / marked no-show by" attribution is discarded. Patients,
-- counters, assignment history, confirmations and accounts are not touched. Never uses CASCADE.
-- Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.patient_outcome_attribution;

COMMIT;
NOTIFY pgrst, 'reload schema';
