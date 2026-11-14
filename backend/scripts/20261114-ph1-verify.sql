-- PH1 Doctor Patient History: post-install verification. READ ONLY; changes nothing.
-- Run after 20261114-ph1-patient-history.sql. Expected: 6 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'patient_outcome_attribution exists', 'present',
    CASE WHEN pg_catalog.to_regclass('public.patient_outcome_attribution') IS NULL THEN 'MISSING' ELSE 'present' END,
    pg_catalog.to_regclass('public.patient_outcome_attribution') IS NOT NULL

  UNION ALL
  SELECT 2, 'row level security enabled', 'true',
    COALESCE((SELECT c.relrowsecurity::TEXT FROM pg_catalog.pg_class AS c
      WHERE c.oid = pg_catalog.to_regclass('public.patient_outcome_attribution')), 'MISSING'),
    COALESCE((SELECT c.relrowsecurity FROM pg_catalog.pg_class AS c
      WHERE c.oid = pg_catalog.to_regclass('public.patient_outcome_attribution')), FALSE)

  UNION ALL
  SELECT 3, 'one attribution per outcome (unique patient_id, outcome, outcome_at)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
      WHERE k.conrelid = pg_catalog.to_regclass('public.patient_outcome_attribution')
        AND k.conname = 'patient_outcome_attribution_once' AND k.contype = 'u') THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k
      WHERE k.conrelid = pg_catalog.to_regclass('public.patient_outcome_attribution')
        AND k.conname = 'patient_outcome_attribution_once' AND k.contype = 'u')

  UNION ALL
  SELECT 4, 'browser roles have no table privilege', 'none',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.role_table_grants AS g
      WHERE g.table_schema = 'public' AND g.table_name = 'patient_outcome_attribution'
        AND g.grantee IN ('PUBLIC', 'anon', 'authenticated')) THEN 'GRANTED' ELSE 'none' END,
    NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants AS g
      WHERE g.table_schema = 'public' AND g.table_name = 'patient_outcome_attribution'
        AND g.grantee IN ('PUBLIC', 'anon', 'authenticated'))

  UNION ALL
  SELECT 5, 'service_role may only read and insert (append-only)', 'INSERT,SELECT',
    COALESCE((SELECT pg_catalog.string_agg(g.privilege_type, ',' ORDER BY g.privilege_type)
      FROM information_schema.role_table_grants AS g
      WHERE g.table_schema = 'public' AND g.table_name = 'patient_outcome_attribution' AND g.grantee = 'service_role'), 'none'),
    COALESCE((SELECT pg_catalog.string_agg(g.privilege_type, ',' ORDER BY g.privilege_type)
      FROM information_schema.role_table_grants AS g
      WHERE g.table_schema = 'public' AND g.table_name = 'patient_outcome_attribution' AND g.grantee = 'service_role'), 'none')
      = 'INSERT,SELECT'

  UNION ALL
  -- PH1 adds no trigger anywhere; the patients table keeps exactly the triggers it had.
  SELECT 6, 'no PH1 trigger on patients', 'none',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname ILIKE '%outcome_attribution%')
      THEN 'PRESENT' ELSE 'none' END,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname ILIKE '%outcome_attribution%')
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
