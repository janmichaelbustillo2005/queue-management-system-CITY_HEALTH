-- Phase B.2 preflight. READ-ONLY, catalog only. NOT a migration. Prepared, not executed.
-- Reads no application rows, calls no application function and changes nothing; safe to run
-- any number of times, before or after installation. Run it in the SQL Editor of the
-- explicitly identified project as the role that would install B.2 (normally postgres).
--
-- One result set: gate, status, detail. Install 20261023-phase-b2-records.sql only when the
-- final "overall" row is PASS. FAIL blocks installation; WARN is an existing condition B.2
-- does not change and that needs its own decision; INFO describes the current state.
BEGIN TRANSACTION READ ONLY;
WITH
installer AS (
  SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user
),
required_columns(tab, col) AS (VALUES
  ('patients', 'id'), ('patients', 'id_num'), ('patients', 'queue_number'), ('patients', 'service_type'),
  ('patients', 'status'), ('patients', 'counter_id'), ('patients', 'priority_score'), ('patients', 'created_at'),
  ('patients', 'called_at'), ('patients', 'consultation_started_at'), ('patients', 'completed_at'),
  ('users', 'id_num'), ('users', 'role'), ('users', 'doctor_name'), ('users', 'auth_revision'),
  ('counters', 'id'), ('counters', 'id_num'),
  ('staff_auth_sessions', 'session_id'), ('staff_auth_sessions', 'user_id_num'), ('staff_auth_sessions', 'created_at'),
  ('staff_auth_sessions', 'last_seen_at'), ('staff_auth_sessions', 'expires_at'), ('staff_auth_sessions', 'revoked_at')
),
required_functions(signature) AS (VALUES
  ('public.create_staff_auth_session(uuid,text,text,text,uuid)'),
  ('public.validate_staff_auth_session(uuid,text,text,text)'),
  ('public.heartbeat_staff_auth_session(uuid,text,text,text)'),
  ('public.revoke_staff_auth_session(uuid,text)'),
  ('public.revoke_staff_user_sessions(text)'),
  ('public.get_staff_doctor_presence()')
),
read_tables(name) AS (VALUES ('patients'), ('users'), ('counters'), ('staff_auth_sessions')),
col AS (
  SELECT c.relname AS tab, a.attname AS col
  FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relname IN ('patients', 'users', 'counters', 'staff_auth_sessions', 'staff_auth_activity')
),
enum_labels AS (
  SELECT t.typname, pg_catalog.array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
  FROM pg_catalog.pg_type AS t JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
  JOIN pg_catalog.pg_enum AS e ON e.enumtypid = t.oid
  WHERE n.nspname = 'public' AND t.typname IN ('queue_status', 'user_role') GROUP BY t.typname
),
records_fn AS (
  SELECT p.prosrc, p.prosecdef, p.proconfig FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.get_central_records(text,jsonb,integer,integer)')
),
revoke_fn AS (
  SELECT p.prosrc, p.proowner FROM pg_catalog.pg_proc AS p
  WHERE p.oid = pg_catalog.to_regprocedure('public.revoke_staff_auth_session(uuid,text)')
),
checks(ord, gate, status, detail) AS (
  SELECT 1, 'read-only session',
    CASE WHEN pg_catalog.current_setting('transaction_read_only') = 'on' THEN 'PASS' ELSE 'FAIL' END,
    pg_catalog.current_database() || ' as ' || current_user || ', PostgreSQL ' || pg_catalog.current_setting('server_version')

  UNION ALL
  SELECT 10, 'table public.' || t.name, CASE WHEN pg_catalog.to_regclass('public.' || t.name) IS NULL THEN 'FAIL' ELSE 'PASS' END,
    CASE WHEN pg_catalog.to_regclass('public.' || t.name) IS NULL THEN 'missing (Phase A / base schema)' ELSE 'present' END
  FROM read_tables AS t

  UNION ALL
  SELECT 11, 'required columns',
    CASE WHEN pg_catalog.count(*) FILTER (WHERE c.col IS NULL) = 0 THEN 'PASS' ELSE 'FAIL' END,
    COALESCE('missing: ' || pg_catalog.string_agg(r.tab || '.' || r.col, ', ' ORDER BY r.tab, r.col) FILTER (WHERE c.col IS NULL),
      pg_catalog.count(*) || ' present (Phase 2 consultation_started_at and Phase A auth_revision included)')
  FROM required_columns AS r LEFT JOIN col AS c ON c.tab = r.tab AND c.col = r.col

  UNION ALL
  SELECT 12, 'Phase A function ' || f.signature,
    CASE WHEN pg_catalog.to_regprocedure(f.signature) IS NULL THEN 'FAIL' ELSE 'PASS' END,
    CASE WHEN pg_catalog.to_regprocedure(f.signature) IS NULL THEN 'missing' ELSE 'present' END
  FROM required_functions AS f

  UNION ALL
  SELECT 13, 'database roles anon, authenticated, service_role',
    CASE WHEN (SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')) = 3 THEN 'PASS' ELSE 'FAIL' END,
    'referenced by the migration''s REVOKE/GRANT statements'

  UNION ALL
  SELECT 14, 'enum user_role',
    CASE WHEN l.labels @> ARRAY['admin', 'superadmin'] THEN 'PASS' ELSE 'FAIL' END,
    COALESCE(pg_catalog.array_to_string(l.labels, ', '), 'type public.user_role not found')
  FROM (SELECT 1) AS one LEFT JOIN enum_labels AS l ON l.typname = 'user_role'

  UNION ALL
  SELECT 20, 'patients.first_name / last_name', 'INFO',
    CASE WHEN EXISTS (SELECT 1 FROM col WHERE tab = 'patients' AND col.col IN ('first_name', 'last_name'))
      THEN 'present, but not used: B.2 shows patients.id_num as stored'
      ELSE 'absent (expected): B.2 shows patients.id_num as stored' END

  UNION ALL
  SELECT 21, 'users.created_at', 'INFO',
    CASE WHEN EXISTS (SELECT 1 FROM col WHERE tab = 'users' AND col.col = 'created_at')
      THEN 'present, but not used: Records reports account creation as not recorded'
      ELSE 'absent (expected): Records and the user list show "Not recorded"' END

  UNION ALL
  SELECT 22, 'enum queue_status / no-show', 'INFO',
    COALESCE(pg_catalog.array_to_string(l.labels, ', '), 'type public.queue_status not found') ||
    CASE WHEN l.labels @> ARRAY['no-show'] THEN ' (No-show filter active)'
      ELSE ' (no-show absent: the No-show filter returns zero rows, not required by B.2)' END
  FROM (SELECT 1) AS one LEFT JOIN enum_labels AS l ON l.typname = 'queue_status'

  UNION ALL
  SELECT 30, 'current get_central_records', 'INFO',
    CASE WHEN NOT EXISTS (SELECT 1 FROM records_fn) THEN 'absent (expected before installation)'
      WHEN (SELECT pg_catalog.strpos(prosrc, 'doctor_source') > 0 FROM records_fn) THEN 'Phase B.2 installed'
      WHEN (SELECT pg_catalog.strpos(prosrc, 'first_name') > 0 FROM records_fn) THEN 'original Phase B (incompatible, B.2 replaces it)'
      ELSE 'unrecognised body: review before installing' END

  UNION ALL
  SELECT 31, 'current revoke_staff_auth_session body', 'INFO',
    CASE WHEN NOT EXISTS (SELECT 1 FROM revoke_fn) THEN 'absent'
      WHEN (SELECT pg_catalog.strpos(prosrc, 'staff_auth_activity') > 0 FROM revoke_fn) THEN 'records explicit logout (Phase B / B.2)'
      ELSE 'Phase A (does not record logout)' END

  UNION ALL
  SELECT 32, 'table public.staff_auth_activity',
    CASE WHEN pg_catalog.to_regclass('public.staff_auth_activity') IS NULL THEN 'INFO'
      WHEN (SELECT pg_catalog.array_agg(col.col::text ORDER BY col.col) FROM col WHERE tab = 'staff_auth_activity')
        = ARRAY['event', 'id', 'occurred_at', 'user_id_num'] THEN 'PASS'
      ELSE 'FAIL' END,
    CASE WHEN pg_catalog.to_regclass('public.staff_auth_activity') IS NULL THEN 'absent (B.2 creates it)'
      ELSE 'present: ' || COALESCE((SELECT pg_catalog.string_agg(col.col::text, ', ' ORDER BY col.col) FROM col WHERE tab = 'staff_auth_activity'), '') END

  UNION ALL
  SELECT 33, 'trigger staff_login_activity', 'INFO',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE NOT t.tgisinternal AND t.tgname = 'staff_login_activity'
        AND t.tgrelid = pg_catalog.to_regclass('public.staff_auth_sessions')) THEN 'present' ELSE 'absent (B.2 creates it)' END

  UNION ALL
  SELECT 40, 'installer may create in schema public',
    CASE WHEN pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN 'PASS' ELSE 'FAIL' END, current_user

  UNION ALL
  SELECT 41, 'installer owns ' || o.what,
    CASE WHEN o.owner IS NULL THEN 'INFO' WHEN pg_catalog.pg_has_role(current_user, o.owner, 'MEMBER') THEN 'PASS' ELSE 'FAIL' END,
    COALESCE('owner ' || pg_catalog.pg_get_userbyid(o.owner), 'absent')
  FROM (
    SELECT 'public.staff_auth_sessions (trigger)' AS what, (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.staff_auth_sessions')) AS owner
    UNION ALL SELECT 'public.revoke_staff_auth_session (replace)', (SELECT proowner FROM revoke_fn)
    UNION ALL SELECT 'public.staff_auth_activity (if present)', (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.staff_auth_activity'))
    UNION ALL SELECT 'public.get_central_records (if present)', (SELECT p.proowner FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure('public.get_central_records(text,jsonb,integer,integer)'))
  ) AS o

  -- The Records function runs as its owner (the installer). With RLS enabled and no policies,
  -- it sees rows only as the table owner without FORCE RLS, or as a BYPASSRLS/superuser role.
  UNION ALL
  SELECT 42, 'definer can read public.' || t.name,
    CASE WHEN c.oid IS NULL THEN 'FAIL'
      WHEN NOT c.relrowsecurity OR i.rolsuper OR i.rolbypassrls THEN 'PASS'
      WHEN pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER') AND NOT c.relforcerowsecurity THEN 'PASS'
      ELSE 'FAIL' END,
    CASE WHEN c.oid IS NULL THEN 'missing'
      ELSE 'RLS ' || CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END ||
        CASE WHEN c.relforcerowsecurity THEN ', FORCED' ELSE '' END || ', owner ' || pg_catalog.pg_get_userbyid(c.relowner) END
  FROM read_tables AS t CROSS JOIN installer AS i
  LEFT JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)

  -- Existing browser-role privileges. B.2 does not change them (approved: existing role
  -- permissions are preserved). Reported so a separate hardening decision can be made.
  UNION ALL
  SELECT 50, 'browser grants on public.' || t.name,
    CASE WHEN pg_catalog.has_table_privilege(r.rolname, c.oid, 'SELECT') OR pg_catalog.has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
      THEN 'WARN' ELSE 'PASS' END,
    r.rolname || ': SELECT ' || pg_catalog.has_table_privilege(r.rolname, c.oid, 'SELECT')::text ||
      ', TRUNCATE ' || pg_catalog.has_table_privilege(r.rolname, c.oid, 'TRUNCATE')::text ||
      ', RLS ' || CASE WHEN c.relrowsecurity THEN 'enabled' ELSE 'DISABLED' END || ' (unchanged by B.2)'
  FROM read_tables AS t JOIN pg_catalog.pg_class AS c ON c.oid = pg_catalog.to_regclass('public.' || t.name)
  JOIN pg_catalog.pg_roles AS r ON r.rolname IN ('anon', 'authenticated')

  UNION ALL
  SELECT 51, 'browser execute on Phase A / Records functions',
    CASE WHEN pg_catalog.count(*) FILTER (WHERE pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')) = 0 THEN 'PASS' ELSE 'WARN' END,
    COALESCE('executable by browser roles: ' || pg_catalog.string_agg(DISTINCT p.proname || ' (' || r.rolname || ')', ', ')
      FILTER (WHERE pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')), 'none')
  FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_roles AS r ON r.rolname IN ('anon', 'authenticated')
  WHERE n.nspname = 'public' AND p.proname IN ('create_staff_auth_session', 'validate_staff_auth_session', 'heartbeat_staff_auth_session',
    'revoke_staff_auth_session', 'revoke_staff_user_sessions', 'get_staff_doctor_presence', 'get_central_records', 'record_staff_login')
)
SELECT ord, gate, status, detail FROM checks
UNION ALL
SELECT 99, 'overall',
  CASE WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'FAIL') THEN 'FAIL' ELSE 'PASS' END,
  CASE WHEN EXISTS (SELECT 1 FROM checks WHERE status = 'FAIL') THEN 'do not install: resolve every FAIL row'
    ELSE 'prerequisites met, installation still needs separate approval' END
ORDER BY ord, gate;
COMMIT;
