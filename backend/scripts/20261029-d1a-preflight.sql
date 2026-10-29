-- D1-A shared-queue Call with WPS Aging: prerequisite preflight. READ ONLY; changes nothing.
-- Run after D1 (20261029-d1-shared-call.sql) and before 20261029-d1a-shared-wps-a-call.sql.
-- Expected: 10 PASS rows, failed_count=0 and all_pass=true on every row.
BEGIN TRANSACTION READ ONLY;

WITH expected_columns(position, table_name, column_name, data_type) AS (
  VALUES
    (1, 'patients', 'priority_score', 'integer'),
    (2, 'patients', 'created_at', 'timestamp with time zone'),
    (3, 'patients', 'service_type', 'character varying'),
    (4, 'patients', 'counter_id', 'character varying'),
    (5, 'patients', 'visit_state_revision', 'uuid')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT e.position, e.table_name || '.' || e.column_name, e.data_type,
    COALESCE(c.data_type, 'MISSING COLUMN'),
    COALESCE(c.data_type = e.data_type OR (e.data_type = 'character varying' AND c.data_type = 'text'), false)
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c ON c.table_schema = 'public'
    AND c.table_name = e.table_name AND c.column_name = e.column_name
  UNION ALL
  SELECT 6, 'patients_rotate_visit_revision trigger', 'enabled',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' THEN 'enabled' ELSE 'disabled' END FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)
  UNION ALL
  SELECT 7, 'counters Doctor 1, Doctor 2, Doctor 3', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
    (SELECT pg_catalog.count(*) = 3 FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))
  UNION ALL
  SELECT 8, 'roles anon, authenticated, service_role', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')),
    (SELECT pg_catalog.count(*) = 3 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))
  UNION ALL
  SELECT 9, 'D1 call_patient_visit_shared installed first', 'present',
    CASE WHEN pg_catalog.to_regprocedure('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)') IS NULL
      THEN 'MISSING FUNCTION' ELSE 'present' END,
    pg_catalog.to_regprocedure('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)') IS NOT NULL
  UNION ALL
  SELECT 10, 'call_patient_visit_shared_wps_a not yet installed', 'absent',
    CASE WHEN pg_catalog.to_regprocedure('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)') IS NULL
      THEN 'absent' ELSE 'already installed' END,
    pg_catalog.to_regprocedure('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)') IS NULL
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 10 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
