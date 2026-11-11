-- FC1 Front Desk confirmation: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261111-fc1-front-desk-confirmation.sql. Expected: every passed = true,
-- failed_count = 0, all_pass = true. Rows 6 and 7 are information (always pass): the visits that
-- will start as Pending Confirmation, and the Call functions the migration will replace. Row 8
-- fails if an installed Call function differs from the reviewed script FC1 was generated from.
BEGIN TRANSACTION READ ONLY;

WITH call_functions(signature) AS (
  VALUES ('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)'),
    ('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)')
), known_sources(signature, original_md5, fc1_md5) AS (
  VALUES ('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)',
      '1468f34221343673d93d34848da46f3f', '02702f8e45dbb1a65363e281c4e33d7e'),
    ('public.call_patient_visit_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)',
      '8a7dfc2485e2bcec69bb5516281e3c59', '1e919639fa7c9898e721fac7357bf674'),
    ('public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)',
      '0ff5318ad880e54f4fb02183576fd4d0', 'dc9f510a75c25dffe0d4269796911572'),
    ('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)',
      'e18c44897641a2d98d6ae3f9d78d17f0', '39f1b955629d754e84099e8631574825'),
    ('public.call_patient_visit_rr(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz,boolean)',
      '7e4a2380e528a1a3b624098d8646ce9b', 'dfb40f8a79baf4fed6251616ca94c550')
), installed AS (
  SELECT k.signature, pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) IN (k.original_md5, k.fc1_md5) AS known
  FROM known_sources AS k JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(k.signature)
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

  UNION ALL
  -- FC1 replaces each installed Call function with its reviewed script plus two edits. A function
  -- that is neither that reviewed version nor already the FC1 version would be overwritten: stop.
  -- Sources compared with line endings normalized, as the C1/D1/D1-A verify scripts do.
  SELECT 8, 'installed Call functions are the reviewed versions (or FC1 already)', 'all known',
    COALESCE((SELECT pg_catalog.string_agg(pg_catalog.split_part(i.signature, '(', 1), ', ' ORDER BY i.signature)
      FROM installed AS i WHERE NOT i.known), 'all known'),
    NOT EXISTS (SELECT 1 FROM installed AS i WHERE NOT i.known)
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
