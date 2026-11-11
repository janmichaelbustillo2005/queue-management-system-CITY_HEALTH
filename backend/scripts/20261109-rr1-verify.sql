-- RR1 round-robin dispatch: post-install verification. READ ONLY; changes nothing.
-- Run after 20261109-rr1-round-robin-dispatch.sql (and again after FC1 if you like).
-- Expected: 10 rows, every passed = true, failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH rr_functions(signature) AS (
  VALUES ('public.qms_rr_doctor_state(timestamptz,timestamptz)'),
    ('public.qms_rr_approved_services()'),
    ('public.qms_rr_next_doctor(text,text[])'),
    ('public.qms_rr_effective_priority(integer,timestamptz,timestamptz,boolean)'),
    ('public.register_visit_round_robin(jsonb,timestamptz,timestamptz)'),
    ('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)'),
    ('public.transfer_active_consultation(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.get_round_robin_dispatch_status(timestamptz,timestamptz)')
), api_functions(signature) AS (
  VALUES ('public.register_visit_round_robin(jsonb,timestamptz,timestamptz)'),
    ('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)'),
    ('public.transfer_active_consultation(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.get_round_robin_dispatch_status(timestamptz,timestamptz)')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'tables doctor_rotation_state and patient_assignment_history (with detail)', 'present',
    CASE WHEN pg_catalog.to_regclass('public.doctor_rotation_state') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patient_assignment_history' AND c.column_name = 'detail') THEN 'present' ELSE 'MISSING' END,
    pg_catalog.to_regclass('public.doctor_rotation_state') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patient_assignment_history' AND c.column_name = 'detail')

  UNION ALL
  SELECT 2, 'rotation pointer: exactly one row (id = 1)', '1',
    (SELECT pg_catalog.count(*)::TEXT FROM public.doctor_rotation_state),
    (SELECT pg_catalog.count(*) = 1 FROM public.doctor_rotation_state WHERE id = 1)

  UNION ALL
  SELECT 3, 'round-robin functions installed', '9 of 9',
    (SELECT pg_catalog.count(*) FILTER (WHERE pg_catalog.to_regprocedure(f.signature) IS NOT NULL)::TEXT || ' of 9' FROM rr_functions AS f),
    (SELECT pg_catalog.bool_and(pg_catalog.to_regprocedure(f.signature) IS NOT NULL) FROM rr_functions AS f)

  UNION ALL
  SELECT 4, 'dispatcher is the automatic-reassignment version (2026-11-11)', 'rr1-auto-reassign-2026-11-11',
    CASE WHEN pg_catalog.strpos(p.prosrc, 'rr1-auto-reassign-2026-11-11') > 0 THEN 'rr1-auto-reassign-2026-11-11' ELSE 'OLDER DRAFT' END,
    pg_catalog.strpos(p.prosrc, 'rr1-auto-reassign-2026-11-11') > 0
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)')

  UNION ALL
  SELECT 5, 'unique index counters_current_patient_once', 'present',
    CASE WHEN pg_catalog.to_regclass('public.counters_current_patient_once') IS NOT NULL THEN 'present' ELSE 'MISSING' END,
    pg_catalog.to_regclass('public.counters_current_patient_once') IS NOT NULL

  UNION ALL
  SELECT 6, 'unique index patients_one_serving_visit_per_doctor', 'present',
    CASE WHEN pg_catalog.to_regclass('public.patients_one_serving_visit_per_doctor') IS NOT NULL THEN 'present' ELSE 'MISSING' END,
    pg_catalog.to_regclass('public.patients_one_serving_visit_per_doctor') IS NOT NULL

  UNION ALL
  SELECT 10, 'unique index patients_queue_number_unique (ticket numbers)', 'present',
    CASE WHEN pg_catalog.to_regclass('public.patients_queue_number_unique') IS NOT NULL THEN 'present' ELSE 'MISSING' END,
    pg_catalog.to_regclass('public.patients_queue_number_unique') IS NOT NULL

  UNION ALL
  SELECT 7, 'backend functions: service_role may execute, anon/authenticated may not', 'service_role only',
    CASE WHEN (SELECT pg_catalog.bool_and(pg_catalog.has_function_privilege('service_role', f.signature, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon', f.signature, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated', f.signature, 'EXECUTE'))
      FROM api_functions AS f WHERE pg_catalog.to_regprocedure(f.signature) IS NOT NULL) THEN 'service_role only' ELSE 'WRONG GRANTS' END,
    COALESCE((SELECT pg_catalog.bool_and(pg_catalog.has_function_privilege('service_role', f.signature, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon', f.signature, 'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated', f.signature, 'EXECUTE'))
      FROM api_functions AS f WHERE pg_catalog.to_regprocedure(f.signature) IS NOT NULL), false)

  UNION ALL
  SELECT 8, 'browser roles cannot read the rotation or the assignment history', 'no access',
    CASE WHEN NOT pg_catalog.has_table_privilege('anon', 'public.doctor_rotation_state', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('authenticated', 'public.doctor_rotation_state', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('anon', 'public.patient_assignment_history', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('authenticated', 'public.patient_assignment_history', 'SELECT')
      THEN 'no access' ELSE 'ACCESSIBLE' END,
    NOT pg_catalog.has_table_privilege('anon', 'public.doctor_rotation_state', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('authenticated', 'public.doctor_rotation_state', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('anon', 'public.patient_assignment_history', 'SELECT')
      AND NOT pg_catalog.has_table_privilege('authenticated', 'public.patient_assignment_history', 'SELECT')

  UNION ALL
  SELECT 9, 'information: the 13 offered services (+4 former) are in the rotation', '17',
    (SELECT pg_catalog.cardinality(public.qms_rr_approved_services())::TEXT),
    (SELECT pg_catalog.cardinality(public.qms_rr_approved_services()) = 17)
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 10 AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
