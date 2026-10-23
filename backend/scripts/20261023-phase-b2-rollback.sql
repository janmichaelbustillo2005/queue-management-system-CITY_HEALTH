-- Phase B.2 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with separate approval, and
-- only to undo 20261023-phase-b2-records.sql on the project it was installed on.
--
-- Deploy the previous backend first or together: without get_central_records the Records
-- API answers 503 (fails closed). Logins, sessions, heartbeats and logouts keep working.
--
-- Restores Phase A's revoke_staff_auth_session body exactly as in
-- 20261012-phase-a-auth-presence.sql, removes the login trigger, its function and the
-- Records function. Keeps public.staff_auth_activity and its rows: deleting audit history
-- needs its own approval. Writes no patient, user, counter or session rows and changes no
-- grants on existing tables. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS staff_login_activity ON public.staff_auth_sessions;
DROP FUNCTION IF EXISTS public.record_staff_login();
DROP FUNCTION IF EXISTS public.get_central_records(text, jsonb, integer, integer);

CREATE OR REPLACE FUNCTION public.revoke_staff_auth_session(p_session_id UUID, p_user_id_num TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  -- Idempotent and owner-bound; never changes last_seen or any queue state.
  UPDATE public.staff_auth_sessions AS s SET revoked_at = pg_catalog.clock_timestamp()
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num AND s.revoked_at IS NULL;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
