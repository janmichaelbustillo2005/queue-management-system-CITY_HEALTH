-- D1-R Records (shared dispatch): prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261029-d1r-records-shared.sql. Expected: 7 PASS rows, failed_count=0, all_pass=true.
BEGIN TRANSACTION READ ONLY;

WITH fn AS (
  SELECT p.oid, p.prosrc, p.prosecdef, p.proconfig, p.proowner
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.get_central_records(text,jsonb,integer,integer)')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'get_central_records exists', 'present',
    COALESCE((SELECT 'present' FROM fn), 'MISSING FUNCTION'), EXISTS (SELECT 1 FROM fn)
  UNION ALL
  SELECT 2, 'installed body is Phase B.2 (reports doctor_source)', 'true',
    COALESCE((SELECT (pg_catalog.strpos(f.prosrc, 'doctor_source') > 0)::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.strpos(f.prosrc, 'doctor_source') > 0 FROM fn AS f), false)
  UNION ALL
  SELECT 3, 'D1-R not yet installed (no dispatch key)', 'false',
    COALESCE((SELECT (pg_catalog.strpos(f.prosrc, 'v_dispatch') > 0)::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.strpos(f.prosrc, 'v_dispatch') = 0 FROM fn AS f), false)
  UNION ALL
  SELECT 4, 'SECURITY DEFINER, search_path=""', 'true',
    COALESCE((SELECT (f.prosecdef AND f.proconfig = ARRAY['search_path=""'])::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prosecdef AND f.proconfig = ARRAY['search_path=""'] FROM fn AS f), false)
  UNION ALL
  SELECT 5, 'service_role may execute', 'true',
    COALESCE((SELECT pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE')::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.has_function_privilege('service_role', f.oid, 'EXECUTE') FROM fn AS f), false)
  UNION ALL
  SELECT 6, 'public.staff_auth_activity (Phase B.2)', 'present',
    CASE WHEN pg_catalog.to_regclass('public.staff_auth_activity') IS NULL THEN 'MISSING TABLE' ELSE 'present' END,
    pg_catalog.to_regclass('public.staff_auth_activity') IS NOT NULL
  UNION ALL
  SELECT 7, 'counters Doctor 1, Doctor 2, Doctor 3', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
    (SELECT pg_catalog.count(*) = 3 FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 7 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
