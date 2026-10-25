-- C1 atomic Call: development prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261025-c1-atomic-call.sql. Expected final result: 19 PASS rows,
-- failed_count=0 and all_pass=true on every row.
-- The first result is a patient/counter consistency inventory: aggregate counts only, no patient
-- identifiers. Non-zero counts do not block installation; review them with the Health Office
-- before testing (the function never repairs existing rows).
BEGIN TRANSACTION READ ONLY;

SELECT 'counter points at a non-serving visit' AS condition, pg_catalog.count(*) AS rows
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.status::TEXT <> 'serving'
UNION ALL
SELECT 'counter points at a visit assigned to another doctor', pg_catalog.count(*)
  FROM public.counters AS c JOIN public.patients AS p ON p.id = c.current_patient_id
  WHERE p.counter_id IS DISTINCT FROM c.id_num
UNION ALL
SELECT 'serving visit with an assignment but no matching counter', pg_catalog.count(*)
  FROM public.patients AS p
  WHERE p.status::TEXT = 'serving' AND p.counter_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p.id AND c.id_num = p.counter_id)
UNION ALL
SELECT 'legacy serving visit without an assignment (blocks its service doctor)', pg_catalog.count(*)
  FROM public.patients AS p WHERE p.status::TEXT = 'serving' AND p.counter_id IS NULL
UNION ALL
SELECT 'legacy waiting visit holding a Phase 2.1 reservation', pg_catalog.count(*)
  FROM public.patients AS p WHERE p.status::TEXT = 'waiting' AND p.counter_id IS NOT NULL;

WITH expected_columns(position, table_name, column_name, data_type) AS (
  VALUES
    (1, 'patients', 'id', 'bigint'),
    (2, 'patients', 'status', 'USER-DEFINED'),
    (3, 'patients', 'service_type', 'character varying'),
    (4, 'patients', 'counter_id', 'character varying'),
    (5, 'patients', 'created_at', 'timestamp with time zone'),
    (6, 'patients', 'called_at', 'timestamp with time zone'),
    (7, 'patients', 'completed_at', 'timestamp with time zone'),
    (8, 'patients', 'priority_score', 'integer'),
    (9, 'patients', 'visit_state_revision', 'uuid'),
    (10, 'counters', 'id_num', 'character varying'),
    (11, 'counters', 'is_online', 'boolean'),
    (12, 'counters', 'current_patient_id', 'bigint'),
    (13, 'users', 'role', 'USER-DEFINED'),
    (14, 'users', 'doctor_name', 'character varying')
), required_functions(position, signature) AS (
  VALUES
    (15, 'public.start_patient_consultation(bigint,text,text,timestamptz)'),
    (16, 'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)')
), checks(position, check_name, expected, actual, passed) AS (
  -- Text and varchar are both accepted for text columns (synthetic test schemas use text).
  SELECT e.position, e.table_name || '.' || e.column_name, e.data_type,
    COALESCE(c.data_type, 'MISSING COLUMN'),
    COALESCE(c.data_type = e.data_type OR (e.data_type = 'character varying' AND c.data_type = 'text'), false)
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c ON c.table_schema = 'public'
    AND c.table_name = e.table_name AND c.column_name = e.column_name

  UNION ALL
  SELECT f.position, f.signature, 'present',
    CASE WHEN pg_catalog.to_regprocedure(f.signature) IS NULL THEN 'MISSING FUNCTION' ELSE 'present' END,
    pg_catalog.to_regprocedure(f.signature) IS NOT NULL
  FROM required_functions AS f

  UNION ALL
  SELECT 17, 'patients_rotate_visit_revision trigger', 'enabled BEFORE UPDATE FOR EACH ROW',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
        THEN 'enabled BEFORE UPDATE FOR EACH ROW' ELSE 'wrong definition or disabled' END
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16
      FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)

  UNION ALL
  SELECT 18, 'counters Doctor 1, Doctor 2, Doctor 3', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
    (SELECT pg_catalog.count(*) = 3 FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))

  UNION ALL
  SELECT 19, 'roles anon, authenticated, service_role', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role')),
    (SELECT pg_catalog.count(*) = 3 FROM pg_catalog.pg_roles AS r WHERE r.rolname IN ('anon', 'authenticated', 'service_role'))
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 19 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
