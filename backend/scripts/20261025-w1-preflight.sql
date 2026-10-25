-- W1 atomic Cancel: development prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261025-w1-atomic-cancel.sql, as the role that will install it (the Supabase SQL
-- editor's postgres role). Expected final result: 28 PASS rows, failed_count=0 and all_pass=true.
-- The first result is an inventory: aggregate counts only, no patient identifiers. Non-zero
-- counts do not block installation; review them with the Health Office before testing (the
-- function never repairs existing rows, except that a repeat Cancel of an already cancelled
-- visit releases a stale pointer to it). It also reports whether queue_status has 'no-show'
-- (either answer is supported; No-show stays disabled until its own migration is approved).
BEGIN TRANSACTION READ ONLY;

SELECT 'counter points at a non-serving visit' AS condition, pg_catalog.count(*) AS rows
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.status::TEXT <> 'serving'
UNION ALL
SELECT 'counter points at a cancelled visit (a repeat Cancel releases it)', pg_catalog.count(*)
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.status::TEXT = 'cancelled'
UNION ALL
SELECT 'visit pointed at by more than one counter', pg_catalog.count(*)
  FROM (SELECT c.current_patient_id FROM public.counters AS c WHERE c.current_patient_id IS NOT NULL
        GROUP BY c.current_patient_id HAVING pg_catalog.count(*) > 1) AS d
UNION ALL
SELECT 'serving visit with an assignment but no matching counter', pg_catalog.count(*)
  FROM public.patients AS p
  WHERE p.status::TEXT = 'serving' AND p.counter_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p.id AND c.id_num = p.counter_id)
UNION ALL
SELECT 'legacy serving visit without an assignment (Frontdesk/Superadmin cancel only)', pg_catalog.count(*)
  FROM public.patients AS p WHERE p.status::TEXT = 'serving' AND p.counter_id IS NULL
UNION ALL
SELECT 'queue_status has the no-show label (1 = yes, 0 = no)', pg_catalog.count(*)
  FROM pg_catalog.pg_enum AS e
  WHERE e.enumtypid = pg_catalog.to_regtype('public.queue_status') AND e.enumlabel = 'no-show';

WITH expected_columns(position, table_name, column_name, data_type) AS (
  VALUES
    (1, 'patients', 'id', 'bigint'),
    (2, 'patients', 'status', 'USER-DEFINED'),
    (3, 'patients', 'service_type', 'character varying'),
    (4, 'patients', 'counter_id', 'character varying'),
    (5, 'patients', 'created_at', 'timestamp with time zone'),
    (6, 'patients', 'called_at', 'timestamp with time zone'),
    (7, 'patients', 'consultation_started_at', 'timestamp with time zone'),
    (8, 'patients', 'completed_at', 'timestamp with time zone'),
    (9, 'patients', 'reason', 'text'),
    (10, 'patients', 'visit_state_revision', 'uuid'),
    (11, 'counters', 'id', 'bigint'),
    (12, 'counters', 'id_num', 'character varying'),
    (13, 'counters', 'current_patient_id', 'bigint'),
    (14, 'users', 'role', 'USER-DEFINED'),
    (15, 'users', 'doctor_name', 'character varying'),
    (16, 'staff_auth_sessions', 'session_id', 'uuid'),
    (17, 'staff_auth_sessions', 'revoked_at', 'timestamp with time zone'),
    (18, 'staff_auth_sessions', 'expires_at', 'timestamp with time zone')
), required_functions(position, signature) AS (
  VALUES
    (19, 'public.validate_staff_auth_session(uuid,text,text,text)'),
    (20, 'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)'),
    (21, 'public.complete_patient_consultation(bigint,text,text,timestamptz,text)')
), rls_tables(position, table_name) AS (
  VALUES (24, 'patients'), (25, 'counters'), (26, 'users'), (27, 'staff_auth_sessions')
), checks(position, check_name, expected, actual, passed) AS (
  -- Text and varchar are both accepted for text columns (synthetic test schemas use text).
  SELECT e.position, e.table_name || '.' || e.column_name, e.data_type,
    COALESCE(c.data_type, 'MISSING COLUMN'),
    COALESCE(c.data_type = e.data_type OR (e.data_type = 'character varying' AND c.data_type = 'text')
      OR (e.data_type = 'text' AND c.data_type = 'character varying'), false)
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c ON c.table_schema = 'public'
    AND c.table_name = e.table_name AND c.column_name = e.column_name

  UNION ALL
  SELECT f.position, f.signature, 'present',
    CASE WHEN pg_catalog.to_regprocedure(f.signature) IS NULL THEN 'MISSING FUNCTION' ELSE 'present' END,
    pg_catalog.to_regprocedure(f.signature) IS NOT NULL
  FROM required_functions AS f

  UNION ALL
  SELECT 22, 'no other cancel_patient_visit / qms_resolve_doctor_counter overload',
    'none, or exactly the W1 signatures',
    (SELECT COALESCE(pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::TEXT, ', '), 'none')
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('cancel_patient_visit', 'qms_resolve_doctor_counter')),
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('cancel_patient_visit', 'qms_resolve_doctor_counter')
        AND p.oid NOT IN (
          COALESCE(pg_catalog.to_regprocedure('public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)')::OID, 0::OID),
          COALESCE(pg_catalog.to_regprocedure('public.qms_resolve_doctor_counter(text)')::OID, 0::OID)))

  UNION ALL
  SELECT 23, 'patients_rotate_visit_revision trigger', 'enabled BEFORE UPDATE FOR EACH ROW',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
        THEN 'enabled BEFORE UPDATE FOR EACH ROW' ELSE 'wrong definition or disabled' END
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)

  UNION ALL
  -- The function runs as its owner (postgres). Without FORCE ROW LEVEL SECURITY a table owner
  -- bypasses RLS; with FORCE, every lookup silently finds nothing and Cancel fails closed.
  SELECT r.position, r.table_name || ' readable by the function owner', 'owner is postgres (or BYPASSRLS), FORCE RLS off',
    COALESCE((SELECT 'owner ' || pg_catalog.pg_get_userbyid(c.relowner) || ', FORCE RLS ' ||
        CASE WHEN c.relforcerowsecurity THEN 'on' ELSE 'off' END
      FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.' || r.table_name)), 'MISSING TABLE'),
    COALESCE((SELECT NOT c.relforcerowsecurity AND (pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = 'postgres' AND (g.rolbypassrls OR g.rolsuper)))
      FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.' || r.table_name)), false)
  FROM rls_tables AS r

  UNION ALL
  SELECT 28, 'installer may assign ownership to postgres; roles anon, authenticated, service_role exist',
    'true, 3',
    (SELECT pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER')::TEXT FROM pg_catalog.pg_roles AS g WHERE g.rolname = 'postgres')
      || ', ' || (SELECT pg_catalog.count(*)::TEXT FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')),
    COALESCE((SELECT pg_catalog.pg_has_role(current_user, 'postgres', 'MEMBER') FROM pg_catalog.pg_roles AS g WHERE g.rolname = 'postgres'), false)
      AND (SELECT pg_catalog.count(*) = 3 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 28 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
