-- AR1: Staff account archiving (soft delete), restore, and permanent deletion from Archives only.
-- STATUS: DRAFT FOR REVIEW. NOT INSTALLED on any hosted project. Applying it to a Supabase
-- project needs separate written approval. Run 20261110-ar1-preflight.sql first.
-- Requires Phase A (users.auth_revision, staff_auth_sessions, revoke_staff_user_sessions and the
-- staff_auth_revoke_account_change trigger) and the account_cancellation_requests table.
--
-- ADDITIVE ONLY. Adds two nullable columns and one CHECK to public.users and seven functions (four callable by service_role, three internal).
-- Replaces no existing function, alters no existing column, and updates no patient, counter,
-- queue, session or cancellation row on install. Existing accounts stay active (archived_at NULL).
--
-- Model:
--   * Archived = users.archived_at IS NOT NULL. The row, its id_num, password hash, role and
--     doctor assignment are kept unchanged, so Restore reuses the same account.
--   * Archiving rotates users.auth_revision. Phase A's staff_auth_revoke_account_change trigger
--     then revokes every session of the account, and any login verified before the archive
--     commits is refused by create_staff_auth_session (revision mismatch). The backend refuses
--     new logins for archived accounts; sessions are also revoked explicitly below.
--   * Permanent deletion is only possible for an ARCHIVED account. Existing foreign keys are
--     honoured (no CASCADE is added or forced; Phase A's staff_auth_sessions FK already cascades
--     the account's session rows). Patients, queue history, patient_assignment_history,
--     staff_auth_activity and cancellation requests reference staff by text and are kept.
--   * Approving a doctor's cancellation request archives the account in the same transaction
--     as the request update; it never deletes it.
--   * Only an ACTIVE Superadmin may act. Every function takes all Superadmin row locks first, in
--     id_num order, so two Superadmins acting on each other serialize, and the last active
--     Superadmin can never be archived.
--
-- Lock order: account_cancellation_requests row (approve only) -> users (Superadmins in id order,
-- then the target) -> staff_auth_sessions (through the Phase A trigger). Phase A and RR1 take one
-- users row FOR SHARE then sessions, so there is no cycle.
-- Errors: 22023 bad arguments, 42501 actor is not an active Superadmin, P0002 not found,
-- P0001 not allowed in the current state, 23503 still referenced by a foreign key (delete).
-- Rollback: 20261110-ar1-rollback.sql (read its notes first).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS archived_by VARCHAR(100);
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = 'public.users'::pg_catalog.regclass AND c.conname = 'users_archive_state_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_archive_state_check
      CHECK (archived_at IS NOT NULL OR archived_by IS NULL);
  END IF;
END
$constraint$;
COMMENT ON COLUMN public.users.archived_at IS
  'AR1: when the staff account was archived (soft-deleted). NULL = active. Archived accounts cannot sign in and are listed only in Staff Archives.';
COMMENT ON COLUMN public.users.archived_by IS
  'AR1: id_num of the Superadmin who archived the account (directly or by approving a cancellation request). NULL while active.';

-- ---------------------------------------------------------------------------------------------
-- Internal helpers (no API grants; called only by the SECURITY DEFINER functions below)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.qms_ar1_lock_actor(p_actor TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF p_actor IS NULL OR pg_catalog.btrim(p_actor) = '' THEN
    RAISE EXCEPTION 'The acting account is required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.users AS u WHERE u.role::TEXT = 'superadmin' ORDER BY u.id_num FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.users AS u
      WHERE u.id_num = p_actor AND u.role::TEXT = 'superadmin' AND u.archived_at IS NULL) THEN
    RAISE EXCEPTION 'Only an active Superadmin can archive, restore or delete staff accounts' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.qms_ar1_account_json(p_user public.users)
RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id_num', p_user.id_num, 'role', p_user.role::TEXT, 'doctor_name', p_user.doctor_name,
    'archived_at', p_user.archived_at, 'archived_by', p_user.archived_by);
$function$;

-- Archives one ACTIVE account. The caller must already hold qms_ar1_lock_actor's locks.
CREATE OR REPLACE FUNCTION public.qms_ar1_archive_locked(p_id_num TEXT, p_actor TEXT)
RETURNS public.users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF p_id_num = p_actor THEN
    RAISE EXCEPTION 'You cannot archive your own account while signed in with it.' USING ERRCODE = 'P0001';
  END IF;
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_id_num FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_user.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This account is already archived.' USING ERRCODE = 'P0001';
  END IF;
  IF v_user.role::TEXT = 'superadmin' AND NOT EXISTS (SELECT 1 FROM public.users AS u
      WHERE u.role::TEXT = 'superadmin' AND u.archived_at IS NULL AND u.id_num <> p_id_num) THEN
    RAISE EXCEPTION 'This is the last active Superadmin account. Create another Superadmin before archiving it.' USING ERRCODE = 'P0001';
  END IF;
  -- Rotating auth_revision fires staff_auth_revoke_account_change: every session of the account
  -- is revoked and a login verified before this commit can no longer create a session.
  UPDATE public.users AS u
    SET archived_at = pg_catalog.clock_timestamp(), archived_by = p_actor,
        auth_revision = pg_catalog.gen_random_uuid()
    WHERE u.id_num = p_id_num
    RETURNING u.* INTO v_user;
  PERFORM public.revoke_staff_user_sessions(p_id_num);
  RETURN v_user;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- API functions (service_role only)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_staff_account(p_id_num TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF p_id_num IS NULL OR pg_catalog.btrim(p_id_num) = '' THEN
    RAISE EXCEPTION 'An account ID is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.qms_ar1_lock_actor(p_actor);
  RETURN public.qms_ar1_account_json(public.qms_ar1_archive_locked(p_id_num, p_actor));
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_staff_account(p_id_num TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  IF p_id_num IS NULL OR pg_catalog.btrim(p_id_num) = '' THEN
    RAISE EXCEPTION 'An account ID is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.qms_ar1_lock_actor(p_actor);
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_id_num FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_user.archived_at IS NULL THEN
    RAISE EXCEPTION 'This account is not archived.' USING ERRCODE = 'P0001';
  END IF;
  -- Same row, id_num, credentials, role and assignment. Revoked sessions stay revoked: the
  -- account must sign in again.
  UPDATE public.users AS u SET archived_at = NULL, archived_by = NULL
    WHERE u.id_num = p_id_num
    RETURNING u.* INTO v_user;
  RETURN public.qms_ar1_account_json(v_user);
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_archived_staff_account(p_id_num TEXT, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_result JSONB;
BEGIN
  IF p_id_num IS NULL OR pg_catalog.btrim(p_id_num) = '' THEN
    RAISE EXCEPTION 'An account ID is required' USING ERRCODE = '22023';
  END IF;
  PERFORM public.qms_ar1_lock_actor(p_actor);
  IF p_id_num = p_actor THEN
    RAISE EXCEPTION 'You cannot delete your own account while signed in with it.' USING ERRCODE = 'P0001';
  END IF;
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_id_num FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff account not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_user.archived_at IS NULL THEN
    RAISE EXCEPTION 'Only archived accounts can be permanently deleted. Archive the account first.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_cancellation_requests AS r
      WHERE r.doctor_id_num = p_id_num AND r.status::TEXT = 'pending') THEN
    RAISE EXCEPTION 'This account has a pending cancellation request. Approve or reject it before permanently deleting the account.' USING ERRCODE = 'P0001';
  END IF;
  v_result := public.qms_ar1_account_json(v_user);
  -- Plain DELETE: any foreign key that restricts it raises 23503 and nothing is removed.
  DELETE FROM public.users AS u WHERE u.id_num = p_id_num;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_account_cancellation_request(
  p_request_id BIGINT, p_actor TEXT, p_admin_notes TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_request public.account_cancellation_requests%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_outcome TEXT;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A cancellation request ID is required' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO v_request FROM public.account_cancellation_requests AS r
    WHERE r.id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cancellation request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status::TEXT <> 'pending' THEN
    RAISE EXCEPTION 'Only pending cancellation requests can be processed' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.qms_ar1_lock_actor(p_actor);
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = v_request.doctor_id_num FOR UPDATE;
  IF NOT FOUND THEN
    v_outcome := 'account_not_found';
  ELSIF v_user.archived_at IS NOT NULL THEN
    v_outcome := 'already_archived';
  ELSE
    PERFORM public.qms_ar1_archive_locked(v_request.doctor_id_num, p_actor);
    v_outcome := 'archived';
  END IF;
  UPDATE public.account_cancellation_requests AS r
    SET status = 'approved', processed_at = pg_catalog.clock_timestamp(), processed_by = p_actor,
        admin_notes = NULLIF(pg_catalog.btrim(COALESCE(p_admin_notes, '')), '')
    WHERE r.id = p_request_id
    RETURNING r.* INTO v_request;
  RETURN pg_catalog.jsonb_build_object('request', pg_catalog.to_jsonb(v_request), 'account_outcome', v_outcome);
END;
$function$;

COMMENT ON FUNCTION public.archive_staff_account(TEXT, TEXT) IS
  'AR1: soft-delete an active staff account (keeps the row) and revoke its sessions. Active Superadmin only.';
COMMENT ON FUNCTION public.restore_staff_account(TEXT, TEXT) IS
  'AR1: return an archived staff account to active. Same row; sessions revoked at archive stay revoked.';
COMMENT ON FUNCTION public.delete_archived_staff_account(TEXT, TEXT) IS
  'AR1: permanently delete an ARCHIVED staff account. Refuses active accounts, the caller, and accounts with a pending cancellation request.';
COMMENT ON FUNCTION public.approve_account_cancellation_request(BIGINT, TEXT, TEXT) IS
  'AR1: approve a pending doctor cancellation request and archive (never delete) the account in one transaction.';

REVOKE ALL ON FUNCTION public.qms_ar1_lock_actor(TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.qms_ar1_account_json(public.users) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.qms_ar1_archive_locked(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_staff_account(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_staff_account(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_archived_staff_account(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_account_cancellation_request(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_staff_account(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_staff_account(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_archived_staff_account(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_account_cancellation_request(BIGINT, TEXT, TEXT) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
