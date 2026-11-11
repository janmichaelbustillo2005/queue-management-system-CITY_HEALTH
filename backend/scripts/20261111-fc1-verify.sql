-- FC1 Front Desk confirmation: post-install verification. READ ONLY; changes nothing.
-- Run after 20261111-fc1-front-desk-confirmation.sql. Expected: 7 rows, every passed = true,
-- failed_count = 0, all_pass = true. Row 7 is information only.
BEGIN TRANSACTION READ ONLY;

WITH call_functions(signature) AS (
  VALUES ('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)')
), installed AS (
  SELECT f.signature, p.prosrc FROM call_functions AS f
  JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(f.signature)
), confirm_fn AS (
  SELECT p.oid, p.prosecdef FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.confirm_patient_visit(bigint,text,timestamptz,timestamptz)')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'patients.confirmed_at timestamptz, confirmed_by text, both nullable', 'present',
    CASE WHEN (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patients' AND c.is_nullable = 'YES' AND c.column_default IS NULL
        AND ((c.column_name = 'confirmed_at' AND c.data_type = 'timestamp with time zone')
          OR (c.column_name = 'confirmed_by' AND c.data_type = 'text'))) = 2 THEN 'present' ELSE 'MISSING OR DIFFERENT' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patients' AND c.is_nullable = 'YES' AND c.column_default IS NULL
        AND ((c.column_name = 'confirmed_at' AND c.data_type = 'timestamp with time zone')
          OR (c.column_name = 'confirmed_by' AND c.data_type = 'text'))) = 2

  UNION ALL
  SELECT 2, 'CHECK patients_front_desk_confirmation_pair (validated)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conrelid = pg_catalog.to_regclass('public.patients')
      AND k.conname = 'patients_front_desk_confirmation_pair' AND k.convalidated) THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conrelid = pg_catalog.to_regclass('public.patients')
      AND k.conname = 'patients_front_desk_confirmation_pair' AND k.convalidated)

  UNION ALL
  SELECT 3, 'trigger patients_front_desk_confirmation: BEFORE UPDATE, row level, enabled', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation' AND t.tgenabled = 'O' AND (t.tgtype & 1) = 1
      AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      AND t.tgfoid = pg_catalog.to_regprocedure('public.qms_guard_front_desk_confirmation()')) THEN 'present' ELSE 'MISSING OR DIFFERENT' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation' AND t.tgenabled = 'O' AND (t.tgtype & 1) = 1
      AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      AND t.tgfoid = pg_catalog.to_regprocedure('public.qms_guard_front_desk_confirmation()'))

  UNION ALL
  SELECT 4, 'confirm_patient_visit: SECURITY DEFINER', 'security definer',
    COALESCE((SELECT CASE WHEN f.prosecdef THEN 'security definer' ELSE 'SECURITY INVOKER' END FROM confirm_fn AS f), 'MISSING'),
    COALESCE((SELECT f.prosecdef FROM confirm_fn AS f), false)

  UNION ALL
  SELECT 5, 'confirm_patient_visit: EXECUTE for service_role only', 'service_role only',
    CASE WHEN NOT EXISTS (SELECT 1 FROM confirm_fn) THEN 'MISSING'
      WHEN pg_catalog.has_function_privilege('service_role', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')
      THEN 'service_role only' ELSE 'WRONG GRANTS' END,
    EXISTS (SELECT 1 FROM confirm_fn)
      AND pg_catalog.has_function_privilege('service_role', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated', (SELECT f.oid FROM confirm_fn AS f), 'EXECUTE')

  UNION ALL
  -- Every installed Call function must be the FC1 version: confirmed head and the explicit check.
  SELECT 6, 'installed Call functions are the FC1 versions', 'all',
    (SELECT pg_catalog.count(*) FILTER (WHERE pg_catalog.strpos(i.prosrc, 'AND w.confirmed_at IS NOT NULL') > 0
        AND pg_catalog.strpos(i.prosrc, 'awaiting_front_desk_confirmation') > 0)::TEXT
      || ' of ' || pg_catalog.count(*)::TEXT || ' installed' FROM installed AS i),
    (SELECT pg_catalog.bool_and(pg_catalog.strpos(i.prosrc, 'AND w.confirmed_at IS NOT NULL') > 0
        AND pg_catalog.strpos(i.prosrc, 'awaiting_front_desk_confirmation') > 0) FROM installed AS i) IS NOT FALSE

  UNION ALL
  SELECT 7, 'information: waiting visits pending Front Desk confirmation', 'any',
    (SELECT pg_catalog.count(*) FROM public.patients AS p WHERE p.status::TEXT = 'waiting' AND p.confirmed_at IS NULL)::TEXT
      || ' waiting visit(s) pending confirmation', true
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
