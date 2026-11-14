-- RES2 structured residency columns: post-install verification. READ ONLY; changes nothing.
-- Run after 20261114-res2-residency-columns.sql. Expected: 9 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH expected_columns(position, column_name) AS (
  VALUES (1, 'residency_barangay'), (2, 'residency_detail'), (3, 'residency_source'), (4, 'residency_place_id')
), expected_constraints(position, constraint_name) AS (
  VALUES (5, 'patient_records_residency_barangay_check'), (6, 'patient_records_residency_detail_check'),
         (7, 'patient_records_residency_source_check'), (8, 'patient_records_residency_place_id_check')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT e.position, 'column ' || e.column_name, 'nullable text',
    COALESCE((SELECT c.data_type || CASE WHEN c.is_nullable = 'YES' THEN ', nullable' ELSE ', NOT NULL' END
      FROM information_schema.columns AS c WHERE c.table_schema = 'public' AND c.table_name = 'patient_records'
        AND c.column_name = e.column_name), 'MISSING'),
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public' AND c.table_name = 'patient_records'
      AND c.column_name = e.column_name AND c.data_type = 'text' AND c.is_nullable = 'YES')
  FROM expected_columns AS e

  UNION ALL
  SELECT e.position, 'constraint ' || e.constraint_name, 'present and validated',
    COALESCE((SELECT CASE WHEN c.convalidated THEN 'present and validated' ELSE 'NOT VALIDATED' END
      FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = pg_catalog.to_regclass('public.patient_records')
        AND c.conname = e.constraint_name), 'MISSING'),
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conrelid = pg_catalog.to_regclass('public.patient_records')
      AND c.conname = e.constraint_name AND c.convalidated)
  FROM expected_constraints AS e

  UNION ALL
  -- The install updates no row: records saved before it have no structured address.
  SELECT 9, 'records with a source also have a barangay', '0 inconsistent rows',
    (SELECT pg_catalog.count(*)::TEXT || ' inconsistent rows' FROM public.patient_records AS r
      WHERE r.residency_source IS NOT NULL AND r.residency_barangay IS NULL),
    NOT EXISTS (SELECT 1 FROM public.patient_records AS r WHERE r.residency_source IS NOT NULL AND r.residency_barangay IS NULL)
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
