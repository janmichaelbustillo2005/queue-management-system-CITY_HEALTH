-- EP1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with approval, only on the project
-- where 20261111-ep1-staff-display-name.sql was installed.
--
-- ORDER:
--   1. Deploy the backend version without EP1 and restart it. (The EP1 backend also keeps
--      working without the column: lists fall back to doctor_name and Edit Profile reports
--      that EP1 is not installed.)
--   2. Run this script. It drops the CHECK and the display_name column.
-- DATA LOSS: every display name set through Edit Profile is discarded. doctor_name (the
-- assignment), roles, passwords, archive state, sessions, patients and counters are not touched.
-- Never uses CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_display_name_check;
ALTER TABLE public.users DROP COLUMN IF EXISTS display_name;

COMMIT;
NOTIFY pgrst, 'reload schema';
