-- RR1 round-robin dispatch: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261109-rr1-round-robin-dispatch.sql. Expected: 20 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

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
    (10, 'counters', 'is_online', 'boolean'),
    (11, 'counters', 'current_patient_id', 'bigint'),
    (12, 'staff_auth_sessions', 'last_seen_at', 'timestamp with time zone')
), checks(position, check_name, expected, actual, passed) AS (
  SELECT e.position, e.table_name || '.' || e.column_name, e.data_type,
    COALESCE(c.data_type, 'MISSING COLUMN'),
    COALESCE(c.data_type = e.data_type OR (e.data_type = 'character varying' AND c.data_type = 'text'), false)
  FROM expected_columns AS e
  LEFT JOIN information_schema.columns AS c ON c.table_schema = 'public'
    AND c.table_name = e.table_name AND c.column_name = e.column_name

  UNION ALL
  SELECT 13, 'get_staff_doctor_presence() (Phase A, 75-second window)', 'present',
    CASE WHEN pg_catalog.to_regprocedure('public.get_staff_doctor_presence()') IS NULL THEN 'MISSING FUNCTION' ELSE 'present' END,
    pg_catalog.to_regprocedure('public.get_staff_doctor_presence()') IS NOT NULL

  UNION ALL
  SELECT 14, 'patients_rotate_visit_revision trigger (Phase 2.1)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_rotate_visit_revision' AND t.tgenabled <> 'D') THEN 'present' ELSE 'MISSING TRIGGER' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.patients')
      AND t.tgname = 'patients_rotate_visit_revision' AND t.tgenabled <> 'D')

  UNION ALL
  SELECT 15, 'counters Doctor 1, Doctor 2, Doctor 3', '3',
    (SELECT pg_catalog.count(*)::TEXT FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
    (SELECT pg_catalog.count(*) = 3 FROM public.counters AS c WHERE c.id_num IN ('Doctor 1', 'Doctor 2', 'Doctor 3'))

  UNION ALL
  SELECT 16, 'RR1 objects not yet installed', 'absent',
    CASE WHEN pg_catalog.to_regclass('public.patient_assignment_history') IS NULL
          AND pg_catalog.to_regclass('public.doctor_rotation_state') IS NULL
          AND pg_catalog.to_regprocedure('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)') IS NULL
      THEN 'absent' ELSE 'already present' END,
    pg_catalog.to_regclass('public.patient_assignment_history') IS NULL
      AND pg_catalog.to_regclass('public.doctor_rotation_state') IS NULL
      AND pg_catalog.to_regprocedure('public.dispatch_round_robin(timestamptz,timestamptz,timestamptz,boolean)') IS NULL

  -- Phase 2 consultation lifecycle (the status view reports consultation start).
  UNION ALL
  SELECT 17, 'patients.consultation_started_at (Phase 2)', 'timestamp with time zone',
    COALESCE((SELECT c.data_type FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = 'consultation_started_at'), 'MISSING COLUMN'),
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'patients' AND c.column_name = 'consultation_started_at' AND c.data_type = 'timestamp with time zone')

  -- Existing rows must already satisfy the two unique indexes the migration adds.
  UNION ALL
  SELECT 18, 'no visit is pointed at by two doctor counters', '0',
    (SELECT pg_catalog.count(*)::TEXT FROM (SELECT c.current_patient_id FROM public.counters AS c
      WHERE c.current_patient_id IS NOT NULL GROUP BY 1 HAVING pg_catalog.count(*) > 1) AS d),
    NOT EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id IS NOT NULL
      GROUP BY c.current_patient_id HAVING pg_catalog.count(*) > 1)

  UNION ALL
  SELECT 19, 'no doctor has two serving visits', '0',
    (SELECT pg_catalog.count(*)::TEXT FROM (SELECT p.counter_id FROM public.patients AS p
      WHERE p.status::TEXT = 'serving' AND p.counter_id IS NOT NULL GROUP BY 1 HAVING pg_catalog.count(*) > 1) AS d),
    NOT EXISTS (SELECT 1 FROM public.patients AS p WHERE p.status::TEXT = 'serving' AND p.counter_id IS NOT NULL
      GROUP BY p.counter_id HAVING pg_catalog.count(*) > 1)

  -- The migration adds a unique index on patients.queue_number (ticket numbers are never reused).
  UNION ALL
  SELECT 20, 'no ticket number is used by two visits', '0',
    (SELECT pg_catalog.count(*)::TEXT FROM (SELECT p.queue_number FROM public.patients AS p
      GROUP BY 1 HAVING pg_catalog.count(*) > 1) AS d),
    NOT EXISTS (SELECT 1 FROM public.patients AS p GROUP BY p.queue_number HAVING pg_catalog.count(*) > 1)
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 20 AS all_pass
FROM checks AS c ORDER BY c.position;
COMMIT;
