-- D1-A shared-queue Call with WPS Aging: development post-install verification. READ ONLY; catalogs
-- only, no patient rows. Expected: 15 PASS rows, failed_count=0 and all_pass=true on every row.
-- Function body fingerprints normalize CRLF to LF and match the reviewed files. Rows 12-15
-- confirm that installing D1-A left D1 shared Call, C1 Call, W1 Cancel and F5 Requeue untouched.
-- Live behavior is covered by backend/test/i1-shared-wps-a-postgres.test.js on PostgreSQL 17.
BEGIN TRANSACTION READ ONLY;

WITH fn AS (
  SELECT p.oid, p.prokind, p.prorettype, p.proretset, p.prosecdef, p.proconfig, p.proowner, p.prosrc,
    p.proacl, l.lanname
  FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = pg_catalog.to_regprocedure('public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)')
), pinned(position, signature, source_md5) AS (
  VALUES
    (11, 'public.call_patient_visit_shared_wps_a(bigint,text,text,uuid,timestamptz,timestamptz,timestamptz)', 'e18c44897641a2d98d6ae3f9d78d17f0'),
    (12, 'public.call_patient_visit_shared(bigint,text,text,uuid,timestamptz,timestamptz)', '0ff5318ad880e54f4fb02183576fd4d0'),
    (13, 'public.call_patient_visit(bigint,text,text,uuid,timestamptz,timestamptz)', '1468f34221343673d93d34848da46f3f'),
    (14, 'public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)', '5efca5552ae5738e8cf5296e67ddbfc5'),
    (15, 'public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '4b5f3730bc828b73a167c462987d9084')
), role_contracts(position, role_name, may_execute) AS (
  VALUES (7, 'anon', false), (8, 'authenticated', false), (9, 'service_role', true)
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'call_patient_visit_shared_wps_a exists', 'plain function',
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
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 15 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
