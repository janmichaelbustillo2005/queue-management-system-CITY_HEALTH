-- OC1 one confirmed or active patient per doctor: post-install verification. READ ONLY.
-- Run after 20261113-oc1-one-confirmation-per-doctor.sql. Expected: 10 rows, every passed = true,
-- failed_count = 0, all_pass = true. Row 10 is information (always passes).
BEGIN TRANSACTION READ ONLY;

WITH fn(position, signature, markers) AS (
  VALUES (1, 'public.confirm_next_patient_visit(bigint,text,timestamptz,timestamptz,timestamptz,boolean,text)',
      ARRAY['doctor_has_active_patient', 'not_next_for_doctor', 'not_present_at IS NULL', 'qms_oc1_effective_priority', 'FOR UPDATE']),
    (2, 'public.set_patient_presence(bigint,text,timestamptz,timestamptz,boolean)',
      ARRAY['qms.oc1_presence_patient', 'FOR UPDATE'])
), fn_state AS (
  SELECT f.position, f.signature, p.oid, p.prosecdef,
    (SELECT pg_catalog.bool_and(pg_catalog.strpos(p.prosrc, m) > 0) FROM pg_catalog.unnest(f.markers) AS m) AS markers_ok
  FROM fn AS f LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(f.signature)
), checks(position, check_name, expected, actual, passed) AS (
  SELECT s.position, pg_catalog.split_part(s.signature, '(', 1) || ': SECURITY DEFINER, OC1 version, EXECUTE for service_role only',
    'present',
    CASE WHEN s.oid IS NULL THEN 'MISSING'
      WHEN NOT s.prosecdef OR NOT s.markers_ok THEN 'DIFFERENT'
      WHEN NOT pg_catalog.has_function_privilege('service_role', s.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('anon', s.oid, 'EXECUTE')
        OR pg_catalog.has_function_privilege('authenticated', s.oid, 'EXECUTE') THEN 'WRONG GRANTS'
      ELSE 'present' END,
    s.oid IS NOT NULL AND s.prosecdef AND s.markers_ok
      AND pg_catalog.has_function_privilege('service_role', s.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon', s.oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('authenticated', s.oid, 'EXECUTE')
  FROM fn_state AS s

  UNION ALL
  SELECT 3, 'patients.confirmed_for text, not_present_at timestamptz, not_present_by text (nullable, no default)', 'present',
    CASE WHEN (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patients' AND c.is_nullable = 'YES' AND c.column_default IS NULL
        AND ((c.column_name = 'confirmed_for' AND c.data_type = 'text')
          OR (c.column_name = 'not_present_at' AND c.data_type = 'timestamp with time zone')
          OR (c.column_name = 'not_present_by' AND c.data_type = 'text'))) = 3 THEN 'present' ELSE 'MISSING OR DIFFERENT' END,
    (SELECT pg_catalog.count(*) FROM information_schema.columns AS c WHERE c.table_schema = 'public'
        AND c.table_name = 'patients' AND c.is_nullable = 'YES' AND c.column_default IS NULL
        AND ((c.column_name = 'confirmed_for' AND c.data_type = 'text')
          OR (c.column_name = 'not_present_at' AND c.data_type = 'timestamp with time zone')
          OR (c.column_name = 'not_present_by' AND c.data_type = 'text'))) = 3

  UNION ALL
  SELECT 4, 'CHECK patients_not_present_pair (validated)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conrelid = pg_catalog.to_regclass('public.patients')
      AND k.conname = 'patients_not_present_pair' AND k.convalidated) THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS k WHERE k.conrelid = pg_catalog.to_regclass('public.patients')
      AND k.conname = 'patients_not_present_pair' AND k.convalidated)

  UNION ALL
  -- A later FC1 re-run restores FC1's guard: re-run OC1 afterwards.
  SELECT 5, 'FC1 guard qms_guard_front_desk_confirmation is the OC1 version (reassignment clears the confirmation)', 'OC1 version',
    COALESCE((SELECT CASE WHEN pg_catalog.strpos(p.prosrc, 'oc1_reassignment') > 0 THEN 'OC1 version' ELSE 'FC1 VERSION (re-run OC1)' END
      FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.qms_guard_front_desk_confirmation()')), 'MISSING'),
    COALESCE((SELECT pg_catalog.strpos(p.prosrc, 'oc1_reassignment') > 0
      FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.qms_guard_front_desk_confirmation()')), false)

  UNION ALL
  SELECT 6, 'trigger patients_one_confirmation_per_doctor: BEFORE UPDATE, row level, enabled', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_one_confirmation_per_doctor' AND t.tgenabled = 'O' AND (t.tgtype & 1) = 1
      AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      AND t.tgfoid = pg_catalog.to_regprocedure('public.qms_oc1_guard_confirmation()')) THEN 'present' ELSE 'MISSING OR DIFFERENT' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_one_confirmation_per_doctor' AND t.tgenabled = 'O' AND (t.tgtype & 1) = 1
      AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      AND t.tgfoid = pg_catalog.to_regprocedure('public.qms_oc1_guard_confirmation()'))

  UNION ALL
  SELECT 7, 'FC1 trigger patients_front_desk_confirmation still enabled (fires before OC1''s)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation' AND t.tgenabled = 'O') THEN 'present' ELSE 'MISSING' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_front_desk_confirmation' AND t.tgenabled = 'O')

  UNION ALL
  SELECT 8, 'OC1 helpers not executable by the browser roles', 'closed',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'qms\_oc1\_%'
          AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')))
      THEN 'OPEN' ELSE 'closed' END,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'qms\_oc1\_%'
          AND (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')))

  UNION ALL
  -- The WPS-A formula is the RR1 one: compare over every score and waiting time that matters.
  SELECT 9, 'qms_oc1_effective_priority equals qms_rr_effective_priority (when RR1 is installed)', 'equal',
    CASE WHEN pg_catalog.to_regprocedure('public.qms_rr_effective_priority(integer,timestamptz,timestamptz,boolean)') IS NULL THEN 'RR1 not installed'
      WHEN (SELECT pg_catalog.bool_and(public.qms_oc1_effective_priority(s, now() - m * interval '1 minute', now(), a)
          = public.qms_rr_effective_priority(s, now() - m * interval '1 minute', now(), a))
        FROM pg_catalog.generate_series(0, 4) AS s, pg_catalog.generate_series(-5, 45) AS m, (VALUES (true), (false)) AS v(a))
      THEN 'equal' ELSE 'DIFFERENT' END,
    pg_catalog.to_regprocedure('public.qms_rr_effective_priority(integer,timestamptz,timestamptz,boolean)') IS NULL
      OR (SELECT pg_catalog.bool_and(public.qms_oc1_effective_priority(s, now() - m * interval '1 minute', now(), a)
          = public.qms_rr_effective_priority(s, now() - m * interval '1 minute', now(), a))
        FROM pg_catalog.generate_series(0, 4) AS s, pg_catalog.generate_series(-5, 45) AS m, (VALUES (true), (false)) AS v(a))

  UNION ALL
  SELECT 10, 'information: doctors with more than one active visit now', 'any',
    COALESCE((SELECT pg_catalog.string_agg(x.d || ': ' || x.n::TEXT, ', ' ORDER BY x.d) FROM (
      SELECT public.qms_oc1_active_doctor(p.status::TEXT, p.service_type, p.counter_id, p.confirmed_at, p.confirmed_for,
        p.completed_at, p.created_at, public.qms_oc1_day_start()) AS d, pg_catalog.count(*) AS n
      FROM public.patients AS p WHERE p.status::TEXT IN ('serving', 'waiting')
      GROUP BY 1 HAVING pg_catalog.count(*) > 1) AS x WHERE x.d IS NOT NULL), 'none'), true
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
