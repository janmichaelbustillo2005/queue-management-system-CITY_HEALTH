-- AR1 staff archiving: prerequisite preflight. READ ONLY; changes nothing.
-- Run before 20261110-ar1-staff-archive.sql. Expected: 8 rows, every passed = true,
-- failed_count = 0, all_pass = true.
BEGIN TRANSACTION READ ONLY;

WITH checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'users.id_num', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'id_num') THEN 'present' ELSE 'MISSING COLUMN' END,
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'id_num')

  UNION ALL
  SELECT 2, 'users.auth_revision (Phase A)', 'uuid',
    COALESCE((SELECT c.data_type FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'auth_revision'), 'MISSING COLUMN'),
    EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'auth_revision' AND c.data_type = 'uuid')

  UNION ALL
  SELECT 3, 'revoke_staff_user_sessions(text) (Phase A)', 'present',
    CASE WHEN pg_catalog.to_regprocedure('public.revoke_staff_user_sessions(text)') IS NULL THEN 'MISSING FUNCTION' ELSE 'present' END,
    pg_catalog.to_regprocedure('public.revoke_staff_user_sessions(text)') IS NOT NULL

  UNION ALL
  SELECT 4, 'staff_auth_revoke_account_change trigger (Phase A)', 'present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.users')
      AND t.tgname = 'staff_auth_revoke_account_change' AND t.tgenabled <> 'D') THEN 'present' ELSE 'MISSING TRIGGER' END,
    EXISTS (SELECT 1 FROM pg_catalog.pg_trigger AS t WHERE t.tgrelid = pg_catalog.to_regclass('public.users')
      AND t.tgname = 'staff_auth_revoke_account_change' AND t.tgenabled <> 'D')

  UNION ALL
  SELECT 5, 'account_cancellation_requests table', 'present',
    CASE WHEN pg_catalog.to_regclass('public.account_cancellation_requests') IS NULL THEN 'MISSING TABLE' ELSE 'present' END,
    pg_catalog.to_regclass('public.account_cancellation_requests') IS NOT NULL

  UNION ALL
  SELECT 6, 'at least one Superadmin account', '>= 1',
    (SELECT pg_catalog.count(*)::TEXT FROM public.users AS u WHERE u.role::TEXT = 'superadmin'),
    EXISTS (SELECT 1 FROM public.users AS u WHERE u.role::TEXT = 'superadmin')

  UNION ALL
  SELECT 7, 'users.archived_at / archived_by not yet present', 'absent',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name IN ('archived_at', 'archived_by')) THEN 'already present' ELSE 'absent' END,
    NOT EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name IN ('archived_at', 'archived_by'))

  UNION ALL
  SELECT 8, 'AR1 functions not yet installed', 'absent',
    CASE WHEN pg_catalog.to_regprocedure('public.archive_staff_account(text,text)') IS NULL
          AND pg_catalog.to_regprocedure('public.delete_archived_staff_account(text,text)') IS NULL
          AND pg_catalog.to_regprocedure('public.approve_account_cancellation_request(bigint,text,text)') IS NULL
      THEN 'absent' ELSE 'already present' END,
    pg_catalog.to_regprocedure('public.archive_staff_account(text,text)') IS NULL
      AND pg_catalog.to_regprocedure('public.delete_archived_staff_account(text,text)') IS NULL
      AND pg_catalog.to_regprocedure('public.approve_account_cancellation_request(bigint,text,text)') IS NULL
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 8 AS all_pass
FROM checks AS c
ORDER BY c.position;

ROLLBACK;
