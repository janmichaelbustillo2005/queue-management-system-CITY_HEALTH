-- NS1 preflight (read-only). Run before 20261118-ns1-remove-not-present.sql.
-- Every row should read 'ok' (or 'info'); anything else, stop and review.
WITH
fn AS (
  SELECT p.oid FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'set_patient_presence'
),
callers AS (
  -- Any other function whose body CALLS set_patient_presence would break when it is dropped.
  -- Comments are stripped first: qms_oc1_guard_confirmation only mentions it in a comment.
  SELECT pg_catalog.string_agg(p.proname, ', ' ORDER BY p.proname) AS names
  FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname <> 'set_patient_presence'
    AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'set_patient_presence\s*\('
),
cols AS (
  SELECT count(*) AS n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'patients' AND column_name IN ('not_present_at', 'not_present_by')
)
SELECT 1 AS check_no, 'set_patient_presence exists (will be dropped)' AS check_name,
  CASE WHEN EXISTS (SELECT 1 FROM fn) THEN 'ok' ELSE 'info: already absent, install is a no-op' END AS result
UNION ALL
SELECT 2, 'no other function calls set_patient_presence',
  CASE WHEN (SELECT names FROM callers) IS NULL THEN 'ok' ELSE 'STOP: called by ' || (SELECT names FROM callers) END
UNION ALL
SELECT 3, 'not_present_at / not_present_by columns (kept)',
  CASE WHEN (SELECT n FROM cols) = 2 THEN 'ok' ELSE 'info: ' || (SELECT n FROM cols) || ' of 2 present' END
UNION ALL
SELECT 4, 'queue_status has no ''no-show'' value',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_enum AS e JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
      WHERE t.typname = 'queue_status' AND e.enumlabel = 'no-show') THEN 'ok'
    ELSE 'info: the enum has no-show; NS1 leaves enum values alone (historical rows)' END
UNION ALL
SELECT 5, 'OC1 confirmation function present (kept)',
  CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_next_patient_visit') THEN 'ok' ELSE 'info: OC1 not installed' END
ORDER BY 1;

-- Patients currently marked Not Present (the install returns them to present). Run separately if
-- row 3 is 'ok':
-- SELECT id, queue_number, status, not_present_at, not_present_by FROM public.patients
--   WHERE not_present_at IS NOT NULL OR not_present_by IS NOT NULL ORDER BY id;
