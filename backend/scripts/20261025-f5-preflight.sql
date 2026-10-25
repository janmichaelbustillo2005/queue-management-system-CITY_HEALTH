-- F5 safe Requeue: development prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261022-f5-requeue-terminal-recovery.sql, as the role that will install it (the
-- Supabase SQL editor's postgres role). Expected final result: 22 PASS rows, failed_count=0 and
-- all_pass=true on every row.
-- The first result is an inventory: aggregate counts only, no patient identifiers. Non-zero
-- counts do not block installation; review them with the Health Office before testing. F5 never
-- repairs existing rows during installation; after installation a Requeue of a terminal visit
-- releases a stale counter pointer to that visit (and only to that visit). It also reports
-- whether queue_status has 'no-show' (either answer is supported; No-show stays disabled until
-- its own migration is approved).
BEGIN TRANSACTION READ ONLY;

SELECT 'counter points at a cancelled, no-show or completed visit (a Requeue releases it)' AS condition,
    pg_catalog.count(*) AS rows
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.status::TEXT IN ('cancelled', 'no-show', 'completed')
UNION ALL
SELECT 'counter points at a waiting visit (Phase 2.1 reservation; Requeue refuses waiting visits)', pg_catalog.count(*)
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.status::TEXT = 'waiting'
UNION ALL
SELECT 'legacy completed visit without a consultation start (still re-queueable, policy pending)', pg_catalog.count(*)
  FROM public.patients AS p WHERE p.status::TEXT = 'completed' AND p.consultation_started_at IS NULL
UNION ALL
SELECT 'queue_status has the no-show label (1 = yes, 0 = no)', pg_catalog.count(*)
  FROM pg_catalog.pg_enum AS e
  WHERE e.enumtypid = pg_catalog.to_regtype('public.queue_status') AND e.enumlabel = 'no-show';

WITH expected_columns(position, table_name, column_name, data_type) AS (
  VALUES
    (1, 'patients', 'id', 'bigint'),
    (2, 'patients', 'status', 'USER-DEFINED'),
    (3, 'patients', 'created_at', 'timestamp with time zone'),
    (4, 'patients', 'called_at', 'timestamp with time zone'),
    (5, 'patients', 'consultation_started_at', 'timestamp with time zone'),
    (6, 'patients', 'completed_at', 'timestamp with time zone'),
    (7, 'patients', 'counter_id', 'character varying'),
    (8, 'patients', 'reason', 'text'),
    (9, 'patients', 'visit_state_revision', 'uuid'),
    (10, 'counters', 'id', 'bigint'),
    (11, 'counters', 'current_patient_id', 'bigint'),
    (12, 'users', 'role', 'USER-DEFINED')
), pinned(position, signature, source_md5) AS (
  -- F5 delegates to the Phase 2.2 body (20261014-phase22-undo-waiting.sql, pinned by
  -- 20261015-phase22-verify.sql); its eligibility guard depends on that body's status check.
  VALUES
    (13, 'public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '290b271135dc8ea503bea6f10b839dac'),
    (14, 'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', 'ce7fd6bb1fc4aa5349200953883f48fe')
), rls_tables(position, table_name) AS (
  VALUES (17, 'patients'), (18, 'counters'), (19, 'users')
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
  SELECT d.position, d.signature || ' source', d.source_md5,
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = d.source_md5 FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), false)
  FROM pinned AS d

  UNION ALL
  SELECT 15, 'no other requeue_patient_visit overload', 'none, or exactly the F5 signature',
    (SELECT COALESCE(pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::TEXT, ', '), 'none')
      FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'requeue_patient_visit'),
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'requeue_patient_visit'
        AND p.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
          'public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)')::OID)

  UNION ALL
  SELECT 16, 'patients_rotate_visit_revision trigger', 'enabled BEFORE UPDATE FOR EACH ROW',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
        THEN 'enabled BEFORE UPDATE FOR EACH ROW' ELSE 'wrong definition or disabled' END
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)

  UNION ALL
  -- The function runs as its owner (the installer, postgres). Without FORCE ROW LEVEL SECURITY a
  -- table owner bypasses RLS; with FORCE, every lookup silently finds nothing and Requeue fails.
  SELECT r.position, r.table_name || ' readable by the function owner', 'owner is postgres (or BYPASSRLS), FORCE RLS off',
    COALESCE((SELECT 'owner ' || pg_catalog.pg_get_userbyid(c.relowner) || ', FORCE RLS ' ||
        CASE WHEN c.relforcerowsecurity THEN 'on' ELSE 'off' END
      FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.' || r.table_name)), 'MISSING TABLE'),
    COALESCE((SELECT NOT c.relforcerowsecurity AND (pg_catalog.pg_get_userbyid(c.relowner) = 'postgres'
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = 'postgres' AND (g.rolbypassrls OR g.rolsuper)))
      FROM pg_catalog.pg_class AS c WHERE c.oid = pg_catalog.to_regclass('public.' || r.table_name)), false)
  FROM rls_tables AS r

  UNION ALL
  SELECT 20, 'installer is postgres (function owner)', 'postgres',
    current_user::TEXT, current_user = 'postgres'

  UNION ALL
  SELECT 21, 'roles anon, authenticated, service_role', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')),
    (SELECT pg_catalog.count(*) = 3 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))

  UNION ALL
  SELECT 22, 'counters Doctor 1, Doctor 2, Doctor 3', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
    (SELECT pg_catalog.count(*) = 3 FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 22 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
