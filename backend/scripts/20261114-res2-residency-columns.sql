-- RES2: structured residency columns on permanent patient records.
-- STATUS: DRAFT FOR REVIEW. NOT INSTALLED on any hosted project. Applying it to a Supabase
-- project needs separate written approval. Run 20261114-res2-preflight.sql first, and
-- 20261114-res2-verify.sql after.
--
-- ADDITIVE ONLY. Adds four nullable columns and their CHECKs to public.patient_records. Replaces
-- no function, alters no existing column, and updates no row: every existing record keeps its
-- residency text exactly as saved, and its new columns start NULL (not recorded). public.patients
-- (visits) and the RR1 insert function are not touched; visits keep copying the residency text.
--
--   residency_barangay  one of the 31 official barangays of Cabadbaran City (PSGC 160203000)
--   residency_detail    the Purok / Street / House No., at most 45 characters; NULL when none
--   residency_source    'map'    = Google Places gave both the barangay and the detail saved
--                       'manual' = the Front Desk chose the barangay or typed the detail
--   residency_place_id  the Google place ID behind a map selection (Google allows caching IDs)
--
-- City, province and country are not stored per row: every RES1 address is in Cabadbaran City,
-- Agusan del Norte, Philippines, and the residency column keeps the full readable address.
--
-- Rollback: 20261114-res2-rollback.sql (drops the four columns and what they hold).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.patient_records ADD COLUMN IF NOT EXISTS residency_barangay TEXT;
ALTER TABLE public.patient_records ADD COLUMN IF NOT EXISTS residency_detail TEXT;
ALTER TABLE public.patient_records ADD COLUMN IF NOT EXISTS residency_source TEXT;
ALTER TABLE public.patient_records ADD COLUMN IF NOT EXISTS residency_place_id TEXT;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.patient_records'::REGCLASS AND c.conname = 'patient_records_residency_barangay_check') THEN
    ALTER TABLE public.patient_records ADD CONSTRAINT patient_records_residency_barangay_check CHECK (
      residency_barangay IS NULL OR residency_barangay IN (
        'Antonio Luna', 'Bay-ang', 'Bayabas', 'Caasinan', 'Cabinet', 'Calamba', 'Calibunan', 'Comagascas',
        'Concepcion', 'Del Pilar', 'Katugasan', 'Kauswagan', 'La Union', 'Mabini', 'Mahaba',
        'Poblacion 1', 'Poblacion 2', 'Poblacion 3', 'Poblacion 4', 'Poblacion 5', 'Poblacion 6',
        'Poblacion 7', 'Poblacion 8', 'Poblacion 9', 'Poblacion 10', 'Poblacion 11', 'Poblacion 12',
        'Puting Bato', 'Sanghan', 'Soriano', 'Tolosa'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.patient_records'::REGCLASS AND c.conname = 'patient_records_residency_detail_check') THEN
    ALTER TABLE public.patient_records ADD CONSTRAINT patient_records_residency_detail_check CHECK (
      residency_detail IS NULL OR (
        residency_detail = pg_catalog.btrim(residency_detail)
        AND pg_catalog.char_length(residency_detail) BETWEEN 1 AND 45
        AND residency_detail !~ '[[:cntrl:]]'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.patient_records'::REGCLASS AND c.conname = 'patient_records_residency_source_check') THEN
    -- A source is recorded only together with a barangay; a map source needs its place ID.
    ALTER TABLE public.patient_records ADD CONSTRAINT patient_records_residency_source_check CHECK (
      (residency_source IS NULL AND residency_barangay IS NULL AND residency_detail IS NULL AND residency_place_id IS NULL)
      OR (residency_source = 'manual' AND residency_barangay IS NOT NULL)
      OR (residency_source = 'map' AND residency_barangay IS NOT NULL AND residency_place_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.patient_records'::REGCLASS AND c.conname = 'patient_records_residency_place_id_check') THEN
    ALTER TABLE public.patient_records ADD CONSTRAINT patient_records_residency_place_id_check CHECK (
      residency_place_id IS NULL OR residency_place_id ~ '^[A-Za-z0-9_-]{8,300}$'
    );
  END IF;
END
$constraints$;

COMMIT;
NOTIFY pgrst, 'reload schema';
