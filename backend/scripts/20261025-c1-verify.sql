-- C1 atomic Call: development post-install verification. READ ONLY; catalogs only, no patient rows.
-- Expected: 14 PASS rows, failed_count=0 and all_pass=true on every row.
-- Function body fingerprints normalize CRLF to LF and match the approved files. Rows 12-14
-- confirm installation left the Phase 2 lifecycle and Phase 2.2 recovery functions untouched.
-- This verifies installation metadata and source, not live workflow behavior (that is covered
-- by backend/test/c1-atomic-call-concurrency.test.js on disposable PostgreSQL).
BEGIN TRANSACTION READ ONLY;

WITH fn AS (
  SELECT p.oid, p.prokind, p.prorettype, p.proretset, p.prosecdef, p.proconfig, p.proowner, p.prosrc,
    p.proacl, l.lanname
  FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = pg_catalog.to_regprocedure('public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)')
), pinned(position, signature, source_md5) AS (
  VALUES
    (11, 'public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)', '1468f34221343673d93d34848da46f3f'),
    (12, 'public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '290b271135dc8ea503bea6f10b839dac'),
    (13, 'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', 'ce7fd6bb1fc4aa5349200953883f48fe'),
    (14, 'public.complete_patient_consultation(bigint,text,text,timestamptz,text)', '0c1eff1969b2f5bdc299de86955d0a21')
), role_contracts(position, role_name, may_execute) AS (
  VALUES (7, 'anon', false), (8, 'authenticated', false), (9, 'service_role', true)
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'call_patient_visit exists', 'plain function',
    COALESCE((SELECT CASE WHEN f.prokind = 'f' THEN 'plain function' ELSE 'kind ' || f.prokind::TEXT END FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prokind = 'f' FROM fn AS f), false)
  UNION ALL
  SELECT 2, 'return type', 'public.patients, non-set',
    COALESCE((SELECT pg_catalog.format_type(f.prorettype, NULL) || CASE WHEN f.proretset THEN ', set' ELSE ', non-set' END FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prorettype = 'public.patients'::pg_catalog.regtype AND NOT f.proretset FROM fn AS f), false)
  UNION ALL
  SELECT 3, 'language', 'plpgsql', COALESCE((SELECT f.lanname::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.lanname = 'plpgsql' FROM fn AS f), false)
  UNION ALL
  SELECT 4, 'SECURITY DEFINER', 'true', COALESCE((SELECT f.prosecdef::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prosecdef FROM fn AS f), false)
  UNION ALL
  SELECT 5, 'function settings', 'lock_timeout=5s, search_path=""',
    COALESCE((SELECT pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.unnest(f.proconfig) ORDER BY 1), ', ') FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT ARRAY(SELECT pg_catalog.unnest(f.proconfig) ORDER BY 1) = ARRAY['lock_timeout=5s', 'search_path=""'] FROM fn AS f), false)
  UNION ALL
  SELECT 6, 'PUBLIC has no EXECUTE', 'false',
    COALESCE((SELECT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') FROM fn AS f), false)
  UNION ALL
  SELECT r.position, r.role_name || ' EXECUTE', r.may_execute::TEXT,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = r.role_name) THEN 'MISSING ROLE'
      WHEN NOT EXISTS (SELECT 1 FROM fn) THEN 'MISSING FUNCTION'
      ELSE (SELECT pg_catalog.has_function_privilege(r.role_name, f.oid, 'EXECUTE')::TEXT FROM fn AS f) END,
    COALESCE(EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = r.role_name)
      AND (SELECT pg_catalog.has_function_privilege(r.role_name, f.oid, 'EXECUTE') = r.may_execute FROM fn AS f), false)
  FROM role_contracts AS r
  UNION ALL
  SELECT 10, 'patients_rotate_visit_revision trigger', 'enabled',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' THEN 'enabled' ELSE 'disabled' END FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)
  UNION ALL
  SELECT d.position, d.signature || ' source', d.source_md5,
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = d.source_md5 FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), false)
  FROM pinned AS d
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 14 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
