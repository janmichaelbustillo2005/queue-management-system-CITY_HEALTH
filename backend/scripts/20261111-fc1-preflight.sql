-- FC1 Front Desk confirmation: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261111-fc1-front-desk-confirmation.sql. Expected: every passed = true,
-- failed_count = 0, all_pass = true. Rows 6 and 7 are information (always pass): the visits that
-- will start as Pending Confirmation, and the Call functions the migration will replace.
BEGIN TRANSACTION READ ONLY;

WITH call_functions(signature) AS (
  VALUES ('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'patients.visit_state_revision (Phase 2.1)', 'uuid',
    COALESCE((SELECT c.data_type FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = 'visit_state_revision'), 'MISSING COLUMN'),
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = 'visit_state_revision' AND c.data_type = 'uuid')

  UNION ALL
  SELECT 2, 'trigger patients_rotate_visit_revision (Phase 2.1)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_rotate_visit_revision' AND NOT t.tgisinternal) THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_rotate_visit_revision' AND NOT t.tgisinternal)

  UNION ALL
  SELECT 3, 'users.role and users.doctor_name', 'present',
    CASE WHEN (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name IN ('role', 'doctor_name')) = 2 THEN 'present' ELSE 'MISSING COLUMN' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name IN ('role', 'doctor_name')) = 2

  UNION ALL
  -- A re-run of FC1 (e.g. after installing a Call script later) finds both columns already present.
  SELECT 4, 'patients.confirmed_at / confirmed_by', 'absent, or both present (FC1 re-run)',
    CASE (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name IN ('confirmed_at', 'confirmed_by'))
      WHEN 0 THEN 'absent' WHEN 2 THEN 'both present' ELSE 'ONLY ONE PRESENT' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name IN ('confirmed_at', 'confirmed_by')) IN (0, 2)

  UNION ALL
  SELECT 5, 'role postgres (function owner)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'postgres') THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = 'postgres')

  UNION ALL
  SELECT 6, 'information: waiting visits that will start as Pending Confirmation', 'any',
    (SELECT pg_catalog.count(*) FROM public.patients AS p WHERE p.status::TEXT = 'waiting')::TEXT || ' waiting visit(s)', true

  UNION ALL
  SELECT 7, 'information: installed Call functions FC1 will replace', 'any',
    COALESCE((SELECT pg_catalog.string_agg(pg_catalog.split_part(f.signature, '(', 1), ', ' ORDER BY f.signature)
      FROM call_functions AS f WHERE pg_catalog.to_regprocedure(f.signature) IS NOT NULL), 'none'), true
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
