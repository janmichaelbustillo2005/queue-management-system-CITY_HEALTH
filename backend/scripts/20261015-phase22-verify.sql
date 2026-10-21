-- Phase 2.2 development post-install verification. Catalogs only; no patient rows.
-- Expected: exactly 56 PASS rows, failed_count=0 and all_pass=true on every row.
-- RLS inventory is first; installation checks are the final tabular result.
-- Missing prerequisites produce FAIL rows, including absent tables/functions/roles.
-- Function body fingerprints normalize CRLF to LF and match the approved files.
-- These checks verify installation metadata/source, not live workflow behavior.
BEGIN TRANSACTION READ ONLY;
-- Compare this inventory with preflight; checks remain last for SQL Editor.
SELECT n.nspname AS schema_name, c.relname AS table_name,
  c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;

WITH settings AS (
  SELECT 'postinstall'::text AS verification_mode
), expected_columns(position, column_name, data_type, is_nullable, default_rule) AS (
  VALUES
    (1, 'id', 'bigint', 'NO', 'any'),
    (2, 'status', 'USER-DEFINED', 'NO', 'any'),
    (3, 'created_at', 'timestamp with time zone', 'NO', 'any'),
    (4, 'counter_id', 'character varying', 'YES', 'any'),
    (5, 'called_at', 'timestamp with time zone', 'YES', 'any'),
    (6, 'consultation_started_at', 'timestamp with time zone', 'YES', 'none'),
    (7, 'completed_at', 'timestamp with time zone', 'YES', 'any'),
    (8, 'reason', 'text', 'YES', 'any'),
    (9, 'visit_state_revision', 'uuid', 'NO', 'uuid')
), function_contracts(position, function_name, signature, identity_arguments, default_count) AS (
  VALUES
    (1, 'start_patient_consultation',
      'public.start_patient_consultation(bigint,text,text,timestamptz)',
      'p_patient_id bigint, p_doctor_name text, p_user_id_num text, p_accepted_at timestamp with time zone', 0),
    (2, 'complete_patient_consultation',
      'public.complete_patient_consultation(bigint,text,text,timestamptz,text)',
      'p_patient_id bigint, p_doctor_name text, p_user_id_num text, p_expected_started_at timestamp with time zone, p_reason text', 1),
    (3, 'recover_patient_visit',
      'public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)',
      'p_patient_id bigint, p_action text, p_user_id_num text, p_expected_revision uuid, p_expected_status text, p_expected_created_at timestamp with time zone, p_expected_called_at timestamp with time zone, p_expected_started_at timestamp with time zone, p_expected_completed_at timestamp with time zone, p_expected_counter_id text, p_reason text', 1),
    (4, 'undo_patient_visit_waiting',
      'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)',
      'p_patient_id bigint, p_action text, p_user_id_num text, p_expected_revision uuid, p_expected_status text, p_expected_created_at timestamp with time zone, p_expected_called_at timestamp with time zone, p_expected_started_at timestamp with time zone, p_expected_completed_at timestamp with time zone, p_expected_counter_id text, p_reason text', 1)
), functions AS (
  SELECT f.*, p.oid AS function_oid, p.prorettype, p.proretset, p.prokind,
    p.prosecdef, p.proconfig, p.proacl, p.proowner, p.proargmodes,
    p.pronargdefaults, p.proargdefaults, p.prosrc
  FROM function_contracts AS f
  CROSS JOIN settings AS s
  LEFT JOIN pg_catalog.pg_proc AS p ON p.oid = pg_catalog.to_regprocedure(f.signature)
  WHERE s.verification_mode = 'postinstall' OR f.function_name <> 'undo_patient_visit_waiting'
), role_contracts(role_position, role_name, may_execute) AS (
  VALUES (1, 'anon', false), (2, 'authenticated', false), (3, 'service_role', true)
), roles AS (
  SELECT r.*, p.oid AS role_oid FROM role_contracts AS r
  LEFT JOIN pg_catalog.pg_roles AS p ON p.rolname = r.role_name
), expected_sources(function_name, source_md5) AS (
  VALUES ('recover_patient_visit', '290b271135dc8ea503bea6f10b839dac'),
    ('undo_patient_visit_waiting', 'ce7fd6bb1fc4aa5349200953883f48fe')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT e.position, 'patients.' || e.column_name,
    e.data_type || ', nullable=' || e.is_nullable || ', default=' || e.default_rule,
    CASE WHEN c.column_name IS NULL THEN 'MISSING COLUMN' ELSE
      c.data_type || ', nullable=' || c.is_nullable || ', default=' || COALESCE(c.column_default, 'none') END,
    COALESCE(c.data_type = e.data_type AND c.is_nullable = e.is_nullable AND
      CASE e.default_rule WHEN 'none' THEN c.column_default IS NULL
        WHEN 'uuid' THEN c.column_default LIKE '%gen_random_uuid()%'
        ELSE true END, false)
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c ON c.table_schema = 'public'
    AND c.table_name = 'patients' AND c.column_name = e.column_name

  UNION ALL
  SELECT 10 + f.position * 10, f.function_name || ' arguments', f.identity_arguments,
    COALESCE(pg_catalog.pg_get_function_identity_arguments(f.function_oid), 'MISSING FUNCTION'),
    COALESCE(f.prokind = 'f' AND f.proargmodes IS NULL AND
      pg_catalog.pg_get_function_identity_arguments(f.function_oid) = f.identity_arguments, false)
  FROM functions AS f

  UNION ALL
  SELECT 11 + f.position * 10, f.function_name || ' return type', 'public.patients, non-set',
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION'
      ELSE pg_catalog.format_type(f.prorettype, NULL) || ', set=' || f.proretset::text END,
    COALESCE(f.prorettype = pg_catalog.to_regtype('public.patients') AND NOT f.proretset, false)
  FROM functions AS f

  UNION ALL
  SELECT 12 + f.position * 10, f.function_name || ' SECURITY DEFINER', 'true',
    COALESCE(f.prosecdef::text, 'MISSING FUNCTION'), COALESCE(f.prosecdef, false)
  FROM functions AS f

  UNION ALL
  SELECT 13 + f.position * 10, f.function_name || ' empty search_path', 'search_path=""',
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION' ELSE COALESCE(f.proconfig::text, 'unset') END,
    COALESCE(f.proconfig @> ARRAY['search_path=""']::text[], false)
  FROM functions AS f

  UNION ALL
  SELECT 14 + f.position * 10, f.function_name || ' defaults',
    CASE WHEN f.default_count = 0 THEN '0 defaults' ELSE '1 default: NULL::text' END,
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION' ELSE
      f.pronargdefaults::text || ' defaults: ' || COALESCE(pg_catalog.pg_get_expr(f.proargdefaults, 0), 'none') END,
    COALESCE(f.pronargdefaults = f.default_count AND (f.default_count = 0 OR
      pg_catalog.pg_get_expr(f.proargdefaults, 0) = 'NULL::text'), false)
  FROM functions AS f

  UNION ALL
  SELECT 15 + f.position * 10, f.function_name || ' / PUBLIC EXECUTE', 'false',
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION' ELSE EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')::text END,
    f.function_oid IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  FROM functions AS f

  UNION ALL
  SELECT 15 + f.position * 10 + r.role_position, f.function_name || ' / ' || r.role_name || ' EXECUTE',
    r.may_execute::text,
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION' WHEN r.role_oid IS NULL THEN 'MISSING ROLE'
      ELSE pg_catalog.has_function_privilege(r.role_oid, f.function_oid, 'EXECUTE')::text END,
    CASE WHEN f.function_oid IS NULL OR r.role_oid IS NULL THEN false
      ELSE pg_catalog.has_function_privilege(r.role_oid, f.function_oid, 'EXECUTE') = r.may_execute END
  FROM functions AS f CROSS JOIN roles AS r

  UNION ALL
  SELECT 19 + f.position * 10, f.function_name || ' service_role-only grants',
    'EXECUTE grantees limited to owner and service_role',
    CASE WHEN f.function_oid IS NULL THEN 'MISSING FUNCTION' ELSE COALESCE(f.proacl::text, 'default ACL') END,
    f.function_oid IS NOT NULL AND EXISTS (SELECT 1 FROM roles WHERE role_name = 'service_role' AND role_oid IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
        WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> f.proowner
          AND a.grantee IS DISTINCT FROM (SELECT role_oid FROM roles WHERE role_name = 'service_role'))
  FROM functions AS f

  UNION ALL
  SELECT 70, 'revision update trigger', 'enabled BEFORE UPDATE FOR EACH ROW, unfiltered, canonical function',
    COALESCE((SELECT pg_catalog.pg_get_triggerdef(t.oid) || ', enabled=' || t.tgenabled::text
      FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
        AND t.tgname = 'patients_rotate_visit_revision' AND NOT t.tgisinternal), 'MISSING TRIGGER'),
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
        AND t.tgname = 'patients_rotate_visit_revision' AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A') AND t.tgtype::integer = 19
        AND t.tgattr::text = '' AND t.tgqual IS NULL
        AND t.tgfoid = pg_catalog.to_regprocedure('public.rotate_patient_visit_revision()'))

  UNION ALL
  SELECT 71, 'revision rotation function', 'trigger, empty search_path, approved unconditional UUID rotation',
    COALESCE((SELECT pg_catalog.format_type(p.prorettype, NULL) || ', config=' || COALESCE(p.proconfig::text, 'unset')
      || ', source_md5=' || pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n'))
      FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.rotate_patient_visit_revision()')),
      'MISSING FUNCTION'),
    EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure('public.rotate_patient_visit_revision()')
        AND p.prokind = 'f' AND p.prorettype = pg_catalog.to_regtype('pg_catalog.trigger') AND NOT p.proretset
        AND p.proconfig @> ARRAY['search_path=""']::text[]
        AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = '7c90658a95ae45b361c391bd51237ef3')

  UNION ALL
  SELECT 80 + e.position, e.table_name || ' RLS enabled', 'true',
    CASE WHEN c.oid IS NULL THEN 'MISSING TABLE' ELSE c.relrowsecurity::text END,
    COALESCE(c.relkind IN ('r', 'p') AND c.relrowsecurity, false)
  FROM (VALUES (1, 'patients'), (2, 'counters'), (3, 'users')) AS e(position, table_name)
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || e.table_name)

  UNION ALL
  SELECT 90 + f.position, f.function_name || ' approved Phase 2.2 source', e.source_md5,
    COALESCE(pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r\n', E'\n')), 'MISSING FUNCTION'),
    COALESCE(pg_catalog.md5(pg_catalog.replace(f.prosrc, E'\r\n', E'\n')) = e.source_md5, false)
  FROM expected_sources AS e
  JOIN functions AS f ON f.function_name = e.function_name
  CROSS JOIN settings AS s WHERE s.verification_mode = 'postinstall'
)
SELECT s.verification_mode, c.check_name, c.expected, c.actual,
  CASE WHEN c.passed THEN 'PASS' ELSE 'FAIL' END AS result,
  CASE WHEN s.verification_mode = 'postinstall' THEN 56 ELSE 44 END AS expected_check_count,
  pg_catalog.count(*) OVER () AS check_count,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () =
    CASE WHEN s.verification_mode = 'postinstall' THEN 56 ELSE 44 END AS all_pass
FROM checks AS c CROSS JOIN settings AS s ORDER BY c.position;
COMMIT;
