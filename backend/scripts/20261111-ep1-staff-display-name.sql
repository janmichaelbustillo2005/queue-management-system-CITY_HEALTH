-- EP1: Staff display name for Superadmin "Edit Profile" in Staff Management.
-- STATUS: DRAFT FOR REVIEW. NOT INSTALLED on any hosted project. Applying it to a Supabase
-- project needs separate written approval. Run 20261111-ep1-preflight.sql first.
--
-- ADDITIVE ONLY. Adds one nullable column and one CHECK to public.users. Replaces no function,
-- alters no existing column, and updates no row on install (every display_name starts NULL, so
-- Staff Management keeps showing doctor_name until a Superadmin sets a display name).
--
-- Why a separate column: users.doctor_name is not a label. It is the doctor/front-desk
-- assignment that queue calling, consultation, transfers and RR1 dispatch match against
-- ('Doctor 1'..'Doctor 3', or blank/'Front Desk'), and Phase A revokes the account's sessions
-- when it changes. display_name is presentation only: nothing routes on it, and it is NOT in
-- the staff_auth_revoke_account_change column list, so editing it signs nobody out.
--
-- Rollback: 20261111-ep1-rollback.sql (drops the column and any display names set).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS display_name VARCHAR(100);
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.users'::REGCLASS AND c.conname = 'users_display_name_check') THEN
    -- NULL means "not set". A set value is trimmed, non-empty and has no control characters.
    ALTER TABLE public.users ADD CONSTRAINT users_display_name_check CHECK (
      display_name IS NULL OR (
        display_name = pg_catalog.btrim(display_name)
        AND pg_catalog.char_length(display_name) BETWEEN 1 AND 100
        AND display_name !~ '[[:cntrl:]]'
      )
    );
  END IF;
END
$constraint$;

COMMIT;
NOTIFY pgrst, 'reload schema';
