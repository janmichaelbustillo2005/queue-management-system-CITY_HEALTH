-- EP1 staff display name: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261111-ep1-staff-display-name.sql. Expected: 4 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'users.id_num', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'id_num') THEN 'present' ELSE 'MISSING COLUMN' END,
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'id_num')

  UNION ALL
  SELECT 2, 'users.doctor_name (assignment, left unchanged)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'doctor_name') THEN 'present' ELSE 'MISSING COLUMN' END,
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'doctor_name')

  UNION ALL
  -- display_name must not be in the Phase A trigger's column list, or editing it would sign the
  -- account out. The trigger is UPDATE OF password, role, doctor_name, id_num, auth_revision.
  SELECT 3, 'staff_auth_revoke_account_change does not watch display_name', 'not watched',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::SMALLINT[])
        WHERE t.tgrelid = pg_catalog.to_regclass('public.users') AND a.attname = 'display_name')
      THEN 'WATCHED' ELSE 'not watched' END,
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::SMALLINT[])
        WHERE t.tgrelid = pg_catalog.to_regclass('public.users') AND a.attname = 'display_name')

  UNION ALL
  SELECT 4, 'users.display_name not yet present', 'absent',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'display_name') THEN 'already present' ELSE 'absent' END,
    NOT EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'display_name')
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
