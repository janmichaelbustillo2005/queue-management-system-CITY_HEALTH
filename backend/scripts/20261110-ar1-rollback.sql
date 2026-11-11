-- AR1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261110-ar1-staff-archive.sql was installed.
--
-- ORDER:
--   1. While the AR1 backend is still running, restore or permanently delete every archived
--      account (Staff Management > Archives). The pre-AR1 backend does not know about archiving:
--      an account left archived would appear active again and could sign in. This script
--      therefore REFUSES to run while any account is archived.
--   2. Deploy the backend version without AR1 and restart it.
--   3. Run this script. It drops the seven AR1 functions, the CHECK and the two columns.
-- Patient, counter, session and cancellation request rows are not touched. Never uses CASCADE.
-- Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns AS c WHERE c.table_schema = 'public'
      AND c.table_name = 'users' AND c.column_name = 'archived_at') THEN
    IF EXISTS (SELECT 1 FROM public.users AS u WHERE u.archived_at IS NOT NULL) THEN
      RAISE EXCEPTION 'AR1 rollback refused: % account(s) are still archived. Restore or permanently delete them first.',
        (SELECT pg_catalog.count(*) FROM public.users AS u WHERE u.archived_at IS NOT NULL);
    END IF;
  END IF;
END
$rollback$;

DROP FUNCTION IF EXISTS public.approve_account_cancellation_request(BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.delete_archived_staff_account(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.restore_staff_account(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.archive_staff_account(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qms_ar1_archive_locked(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qms_ar1_account_json(public.users);
DROP FUNCTION IF EXISTS public.qms_ar1_lock_actor(TEXT);
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_archive_state_check;
ALTER TABLE public.users DROP COLUMN IF EXISTS archived_by;
ALTER TABLE public.users DROP COLUMN IF EXISTS archived_at;

COMMIT;
NOTIFY pgrst, 'reload schema';
