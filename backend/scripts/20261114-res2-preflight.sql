-- RES2 structured residency columns: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261114-res2-residency-columns.sql. Expected: 3 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'patient_records table (patient-records migration)', 'present',
    CASE WHEN pg_catalog.to_regclass('public.patient_records') IS NOT NULL THEN 'present' ELSE 'MISSING TABLE' END,
    pg_catalog.to_regclass('public.patient_records') IS NOT NULL

  UNION ALL
  SELECT 2, 'patient_records.residency (kept as the readable address)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patient_records' AND c.column_name = 'residency') THEN 'present' ELSE 'MISSING COLUMN' END,
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patient_records' AND c.column_name = 'residency')

  UNION ALL
  SELECT 3, 'no RES2 column present yet', 'none',
    COALESCE((SELECT pg_catalog.string_agg(c.column_name, ', ' ORDER BY c.column_name) FROM information_schema.columns AS c
      WHERE c.table_schema = 'public' AND c.table_name = 'patient_records'
        AND c.column_name IN ('residency_barangay', 'residency_detail', 'residency_source', 'residency_place_id')), 'none'),
    NOT EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patient_records'
      AND c.column_name IN ('residency_barangay', 'residency_detail', 'residency_source', 'residency_place_id'))
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
