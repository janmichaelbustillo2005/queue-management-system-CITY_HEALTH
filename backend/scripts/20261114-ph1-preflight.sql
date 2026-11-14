-- PH1 Doctor Patient History: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261114-ph1-patient-history.sql. Expected: 5 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH required_columns(position, column_name) AS (
  VALUES (1, 'id'), (2, 'status'), (3, 'counter_id'), (4, 'completed_at')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT r.position, 'patients.' || r.column_name, 'present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = r.column_name) THEN 'present' ELSE 'MISSING COLUMN' END,
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = r.column_name)
  FROM required_columns AS r

  UNION ALL
  SELECT 5, 'patient_outcome_attribution not yet present', 'absent',
    CASE WHEN pg_catalog.to_regclass('public.patient_outcome_attribution') IS NULL THEN 'absent' ELSE 'already present' END,
    pg_catalog.to_regclass('public.patient_outcome_attribution') IS NULL
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
