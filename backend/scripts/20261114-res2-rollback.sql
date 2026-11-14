-- RES2 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261114-res2-residency-columns.sql was installed.
--
-- ORDER: no backend change is needed first. The RES2 backend keeps registering patients without
-- these columns: it saves the record without them and logs a warning.
-- DATA LOSS: the structured barangay, detail, source (map/manual) and Google place ID of records
-- saved since the install are discarded. The residency text of every record, every visit, every
-- patient and the queue are not touched. Never uses CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.patient_records DROP CONSTRAINT IF EXISTS patient_records_residency_source_check;
ALTER TABLE public.patient_records DROP CONSTRAINT IF EXISTS patient_records_residency_barangay_check;
ALTER TABLE public.patient_records DROP CONSTRAINT IF EXISTS patient_records_residency_detail_check;
ALTER TABLE public.patient_records DROP CONSTRAINT IF EXISTS patient_records_residency_place_id_check;
ALTER TABLE public.patient_records DROP COLUMN IF EXISTS residency_place_id;
ALTER TABLE public.patient_records DROP COLUMN IF EXISTS residency_source;
ALTER TABLE public.patient_records DROP COLUMN IF EXISTS residency_detail;
ALTER TABLE public.patient_records DROP COLUMN IF EXISTS residency_barangay;

COMMIT;
NOTIFY pgrst, 'reload schema';
