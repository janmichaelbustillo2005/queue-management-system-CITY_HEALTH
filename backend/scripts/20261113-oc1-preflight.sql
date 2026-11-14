-- OC1 one confirmed or active patient per doctor: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261113-oc1-one-confirmation-per-doctor.sql. Expected: 8 rows, every passed = true,
-- failed_count = 0, all_pass = true. Rows 7 and 8 are information (always pass).
BEGIN TRANSACTION READ ONLY;

WITH guard AS (
  SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) AS h, p.prosrc
  FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.qms_guard_front_desk_confirmation()')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'FC1: patients.confirmed_at / confirmed_by', 'both present',
    CASE WHEN (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name IN ('confirmed_at', 'confirmed_by')) = 2 THEN 'both present' ELSE 'MISSING (install FC1 first)' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name IN ('confirmed_at', 'confirmed_by')) = 2

  UNION ALL
  SELECT 2, 'FC1: trigger patients_front_desk_confirmation', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation') THEN 'present' ELSE 'MISSING (install FC1 first)' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation')

  UNION ALL
  -- OC1 replaces FC1's guard; it must be FC1's reviewed version (or already OC1's).
  SELECT 3, 'FC1 guard qms_guard_front_desk_confirmation is the reviewed FC1 version (or OC1 already)', 'known',
    COALESCE((SELECT CASE WHEN g.h = '383dbaea4d0ca70da328ba64a7dfcfaa' THEN 'FC1 version'
        WHEN pg_catalog.strpos(g.prosrc, 'oc1_reassignment') > 0 THEN 'OC1 version'
        ELSE 'UNKNOWN VERSION' END FROM guard AS g), 'MISSING'),
    COALESCE((SELECT g.h = '383dbaea4d0ca70da328ba64a7dfcfaa' OR pg_catalog.strpos(g.prosrc, 'oc1_reassignment') > 0 FROM guard AS g), false)

  UNION ALL
  SELECT 4, 'counters.id_num / current_patient_id, patients.counter_id / priority_score / created_at', 'present',
    CASE WHEN (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND ((c.table_name = 'counters' AND c.column_name IN ('id_num', 'current_patient_id'))
        OR (c.table_name = 'patients' AND c.column_name IN ('counter_id', 'priority_score', 'created_at')))) = 5 THEN 'present' ELSE 'MISSING COLUMN' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND ((c.table_name = 'counters' AND c.column_name IN ('id_num', 'current_patient_id'))
        OR (c.table_name = 'patients' AND c.column_name IN ('counter_id', 'priority_score', 'created_at')))) = 5

  UNION ALL
  SELECT 5, 'role postgres (function owner)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'postgres') THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'postgres')

  UNION ALL
  -- A re-run finds all OC1 functions; a partial set means something else uses these names.
  SELECT 6, 'OC1 functions', 'none, or all 9 (OC1 re-run)',
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('confirm_next_patient_visit', 'set_patient_presence', 'qms_oc1_guard_confirmation',
        'qms_oc1_service_doctor', 'qms_oc1_visit_doctor', 'qms_oc1_effective_priority', 'qms_oc1_day_start',
        'qms_oc1_active_doctor', 'qms_oc1_active_visit'))::TEXT || ' present',
    (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('confirm_next_patient_visit', 'set_patient_presence', 'qms_oc1_guard_confirmation',
        'qms_oc1_service_doctor', 'qms_oc1_visit_doctor', 'qms_oc1_effective_priority', 'qms_oc1_day_start',
        'qms_oc1_active_doctor', 'qms_oc1_active_visit')) IN (0, 9)

  UNION ALL
  -- OC1 refuses NEW violations only; doctors already above one active visit keep them until they end.
  SELECT 7, 'information: doctors with more than one serving or confirmed waiting visit (by stored assignment)', 'any',
    COALESCE((SELECT pg_catalog.string_agg(x.doctor || ': ' || x.n::TEXT, ', ' ORDER BY x.doctor) FROM (
      SELECT p.counter_id AS doctor, pg_catalog.count(*) AS n FROM public.patients AS p
      -- to_jsonb: this row must still report (not fail) on a database without FC1's column.
      WHERE p.counter_id IS NOT NULL AND (p.status::TEXT = 'serving'
        OR (p.status::TEXT = 'waiting' AND (pg_catalog.to_jsonb(p) ->> 'confirmed_at') IS NOT NULL))
      GROUP BY p.counter_id HAVING pg_catalog.count(*) > 1) AS x), 'none'), true

  UNION ALL
  SELECT 8, 'information: waiting visits', 'any',
    (SELECT pg_catalog.count(*) FROM public.patients AS p WHERE p.status::TEXT = 'waiting')::TEXT || ' waiting visit(s)', true
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
