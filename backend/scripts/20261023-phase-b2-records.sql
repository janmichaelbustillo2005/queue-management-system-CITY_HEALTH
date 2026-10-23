-- Phase B.2: Records compatibility with the installed schema.
-- STATUS: PREPARED AND VERIFIED IN ISOLATION ONLY. NOT INSTALLED. Installing it on any
-- Supabase project needs separate written approval. Never execute the original
-- schema/seeding SQL.
--
-- Supersedes 20261014-phase-b-records.sql, which is kept unchanged as history and must
-- never be installed: it reads patients.first_name / last_name, which do not exist.
--
-- Order: 20261023-phase-b2-preflight.sql (read-only) -> this file (one execution, one
-- transaction) -> 20261023-phase-b2-verify.sql (rolls back). Rollback:
-- 20261023-phase-b2-rollback.sql. See docs/phase-b2-records-installation.md.
--
-- Requires Phase 2 (patients.consultation_started_at) and Phase A (staff sessions). Does
-- NOT require 'no-show' in public.queue_status: the No-show filter matches nothing until the
-- separate 20261023-no-show-enum.sql is approved and installed.
--
-- Writes no patient, user, counter or session rows and backfills no activity. Does not
-- change grants or RLS on any existing table. Patient names are shown exactly as stored in
-- patients.id_num. Activity starts when this migration is installed.
BEGIN;
-- Creating the login trigger locks staff_auth_sessions briefly; never wait behind a long
-- transaction while logins queue up. On timeout nothing is installed; retry when quiet.
SET LOCAL lock_timeout = '5s';

-- Dependency gate. PL/pgSQL bodies are not checked against the schema when created, which
-- is how the original Phase B installed cleanly and then failed on every call. Fail here.
DO $gate$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_item text;
BEGIN
  FOREACH v_item IN ARRAY ARRAY['public.patients', 'public.users', 'public.counters', 'public.staff_auth_sessions'] LOOP
    IF pg_catalog.to_regclass(v_item) IS NULL THEN v_missing := v_missing || v_item; END IF;
  END LOOP;
  FOREACH v_item IN ARRAY ARRAY[
    'public.create_staff_auth_session(uuid,text,text,text,uuid)',
    'public.validate_staff_auth_session(uuid,text,text,text)',
    'public.revoke_staff_auth_session(uuid,text)',
    'public.revoke_staff_user_sessions(text)'] LOOP
    IF pg_catalog.to_regprocedure(v_item) IS NULL THEN v_missing := v_missing || v_item; END IF;
  END LOOP;
  SELECT v_missing || COALESCE(pg_catalog.array_agg(e.tab || '.' || e.col ORDER BY e.tab, e.col), ARRAY[]::text[])
    INTO v_missing
  FROM (VALUES
    ('patients', 'id'), ('patients', 'id_num'), ('patients', 'queue_number'), ('patients', 'service_type'),
    ('patients', 'status'), ('patients', 'counter_id'), ('patients', 'priority_score'), ('patients', 'created_at'),
    ('patients', 'called_at'), ('patients', 'consultation_started_at'), ('patients', 'completed_at'),
    ('users', 'id_num'), ('users', 'role'), ('users', 'doctor_name'),
    ('counters', 'id'), ('counters', 'id_num'),
    ('staff_auth_sessions', 'session_id'), ('staff_auth_sessions', 'user_id_num'), ('staff_auth_sessions', 'created_at'),
    ('staff_auth_sessions', 'last_seen_at'), ('staff_auth_sessions', 'expires_at'), ('staff_auth_sessions', 'revoked_at')
  ) AS e(tab, col)
  WHERE pg_catalog.to_regclass('public.' || e.tab) IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = pg_catalog.to_regclass('public.' || e.tab) AND a.attname = e.col AND a.attnum > 0 AND NOT a.attisdropped);
  IF pg_catalog.cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Phase B.2 prerequisites missing: %', pg_catalog.array_to_string(v_missing, ', ')
      USING ERRCODE = '55000', HINT = 'Install Phase 2 and Phase A first. Nothing was installed.';
  END IF;
  -- A pre-existing activity table (only possible if the original Phase B was installed)
  -- must have exactly the expected columns; anything else needs review, not reuse.
  IF pg_catalog.to_regclass('public.staff_auth_activity') IS NOT NULL AND (
    SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = pg_catalog.to_regclass('public.staff_auth_activity') AND a.attnum > 0 AND NOT a.attisdropped
  ) IS DISTINCT FROM ARRAY['event', 'id', 'occurred_at', 'user_id_num'] THEN
    RAISE EXCEPTION 'public.staff_auth_activity exists with an unexpected shape' USING ERRCODE = '55000',
      HINT = 'Review the existing table before installing Phase B.2. Nothing was installed.';
  END IF;
END
$gate$;

-- Login/logout activity. Written only by the SECURITY DEFINER functions below.
CREATE TABLE IF NOT EXISTS public.staff_auth_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id_num text NOT NULL,
  event text NOT NULL CHECK (event IN ('login', 'logout')),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
COMMENT ON TABLE public.staff_auth_activity IS
  'Phase B.2 staff login and explicit-logout events, written only by record_staff_login and revoke_staff_auth_session. Secondary to staff_auth_sessions, which remains the authoritative session record. Not backfilled.';
CREATE INDEX IF NOT EXISTS staff_auth_activity_user_time ON public.staff_auth_activity (user_id_num, occurred_at DESC);
CREATE INDEX IF NOT EXISTS staff_auth_activity_time ON public.staff_auth_activity (occurred_at DESC, id DESC);
ALTER TABLE public.staff_auth_activity ENABLE ROW LEVEL SECURITY;
-- Supabase default privileges grant new tables and sequences to anon and authenticated.
-- Browsers never read this table; the backend reads it only through get_central_records.
REVOKE ALL ON TABLE public.staff_auth_activity FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_auth_activity TO service_role;
DO $sequence$
DECLARE v_sequence text := pg_catalog.pg_get_serial_sequence('public.staff_auth_activity', 'id');
BEGIN
  IF v_sequence IS NULL THEN
    RAISE EXCEPTION 'public.staff_auth_activity.id has no identity sequence' USING ERRCODE = '55000';
  END IF;
  -- Quoted by regclass output, never by string concatenation of an identifier.
  EXECUTE pg_catalog.format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role', v_sequence::regclass);
END
$sequence$;

-- Activity-storage policy (both events): staff_auth_sessions is the authoritative record of
-- a sign-in (created_at) and of a revocation (revoked_at). Activity is a secondary audit
-- view of it. A failure to write activity therefore never blocks sign-in (Phase A login
-- behaviour is unchanged) and never keeps a session alive after logout. The failure is
-- reported as a server-side WARNING with its SQLSTATE only.
CREATE OR REPLACE FUNCTION public.record_staff_login()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  BEGIN
    INSERT INTO public.staff_auth_activity (user_id_num, event, occurred_at)
      VALUES (NEW.user_id_num, 'login', NEW.created_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Phase B.2: login activity not recorded (SQLSTATE %)', SQLSTATE;
  END;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_staff_login() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS staff_login_activity ON public.staff_auth_sessions;
CREATE TRIGGER staff_login_activity AFTER INSERT ON public.staff_auth_sessions
  FOR EACH ROW EXECUTE FUNCTION public.record_staff_login();

-- Same signature, result, owner binding and idempotency as Phase A; the UPDATE is Phase A's
-- statement unchanged. Only this explicit logout records 'logout', once per session. Expiry,
-- heartbeat timeout, account changes and revoke_staff_user_sessions are not logouts.
-- Re-running the Phase A migration after this file restores Phase A's body and silently
-- stops logout recording; 20261023-phase-b2-verify.sql detects that.
CREATE OR REPLACE FUNCTION public.revoke_staff_auth_session(p_session_id UUID, p_user_id_num TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  -- Idempotent and owner-bound; never changes last_seen or any queue state.
  UPDATE public.staff_auth_sessions AS s SET revoked_at = pg_catalog.clock_timestamp()
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num AND s.revoked_at IS NULL;
  IF FOUND THEN
    -- Revocation always wins: an activity failure must never keep a session alive.
    BEGIN
      INSERT INTO public.staff_auth_activity (user_id_num, event) VALUES (p_user_id_num, 'logout');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Phase B.2: logout activity not recorded (SQLSTATE %)', SQLSTATE;
    END;
  END IF;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_auth_session(UUID, TEXT) TO service_role;

-- Records read model. Signature unchanged from Phase B: (category, filters, page, limit) ->
-- { rows, total, page, limit, observed_at }. Returns a fixed whitelist of fields: no contact,
-- birth, residency, PhilHealth, vulnerability, reason, password or revision data.
-- Invalid input raises SQLSTATE 22023 (the API answers 400), never a storage failure.
-- Built-ins resolve from pg_catalog, which is always searched first; every relation is
-- schema-qualified and nothing is executed dynamically.
CREATE OR REPLACE FUNCTION public.get_central_records(
  p_category text, p_filters jsonb DEFAULT '{}'::jsonb, p_page integer DEFAULT 1, p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  f jsonb := COALESCE(p_filters, '{}'::jsonb);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_search text;
  v_status text;
  v_service text;
  v_role text;
  v_position text;
  v_presence text;
  v_account text;
  v_visit text;
  v_date_text text;
  v_doctor_text text;
  v_date date;
  v_doctor bigint;
  v_visit_id bigint;
  v_offset integer;
  result jsonb;
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('patients', 'staff', 'accounts', 'activity')
     OR p_page IS NULL OR p_page NOT BETWEEN 1 AND 100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR pg_catalog.jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'Invalid records request' USING ERRCODE = '22023';
  END IF;
  -- Only the keys the API sends, each a string of at most 100 characters.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(f) AS e(key, value)
    WHERE e.key NOT IN ('search', 'status', 'service', 'doctor', 'date', 'role', 'presence', 'account', 'visit', 'position')
       OR pg_catalog.jsonb_typeof(e.value) <> 'string' OR pg_catalog.length(e.value #>> '{}') > 100
  ) THEN
    RAISE EXCEPTION 'Invalid records filter' USING ERRCODE = '22023';
  END IF;
  v_search := pg_catalog.lower(pg_catalog.btrim(COALESCE(f->>'search', '')));
  v_status := COALESCE(f->>'status', '');
  v_service := COALESCE(f->>'service', '');
  v_role := COALESCE(f->>'role', '');
  v_position := COALESCE(f->>'position', '');
  v_presence := COALESCE(f->>'presence', '');
  v_account := COALESCE(f->>'account', '');
  v_visit := COALESCE(f->>'visit', '');
  v_date_text := COALESCE(f->>'date', '');
  v_doctor_text := pg_catalog.btrim(COALESCE(f->>'doctor', ''));
  -- 'no-show' is accepted even where public.queue_status lacks it: status is compared as
  -- text, so that filter matches nothing until the separate enum migration is installed.
  IF v_status NOT IN ('', 'waiting', 'serving', 'completed', 'cancelled', 'no-show')
     OR v_role NOT IN ('', 'admin', 'superadmin')
     OR v_position NOT IN ('', 'Super Admin', 'Doctor', 'Frontdesk')
     OR v_presence NOT IN ('', 'online', 'offline')
     OR (v_visit <> '' AND v_visit !~ '^[0-9]{1,18}$') THEN
    RAISE EXCEPTION 'Invalid records filter' USING ERRCODE = '22023';
  END IF;
  IF v_date_text <> '' THEN
    IF v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_date := v_date_text::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END;
    -- Rejects dates PostgreSQL would otherwise normalise.
    IF pg_catalog.to_char(v_date, 'YYYY-MM-DD') <> v_date_text THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Same alias rule as queueService.resolveDoctorCounter and get_staff_doctor_presence:
  -- name (case/space-insensitive), counter id, or "doctor N"/"N"; lowest counter id wins.
  IF v_doctor_text <> '' THEN
    SELECT c.id INTO v_doctor FROM public.counters AS c
      WHERE pg_catalog.lower(pg_catalog.btrim(c.id_num)) = pg_catalog.lower(v_doctor_text) OR c.id::text = v_doctor_text
         OR pg_catalog.lower(c.id_num) = CASE WHEN pg_catalog.lower(v_doctor_text) ~ '^(doctor[[:space:]]*)?[0-9]+$'
             THEN 'doctor ' || (pg_catalog.regexp_replace(pg_catalog.lower(v_doctor_text), '^doctor[[:space:]]*', '')::numeric)::text END
      ORDER BY c.id LIMIT 1;
    IF v_doctor IS NULL THEN
      RAISE EXCEPTION 'Unknown doctor filter' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_visit <> '' THEN v_visit_id := v_visit::bigint; END IF;
  v_offset := (p_page - 1) * p_limit;

  IF p_category = 'patients' THEN
    WITH visits AS (
      SELECT p.id, p.id_num, p.queue_number, p.service_type, p.status, p.counter_id, p.priority_score,
        p.created_at, p.called_at, p.consultation_started_at, p.completed_at,
        assigned.id AS assigned_id, assigned.id_num AS assigned_name, routed.id AS routed_id, routed.id_num AS routed_name,
        NULLIF(pg_catalog.btrim(COALESCE(p.counter_id, '')), '') IS NOT NULL AS has_assignment
      FROM public.patients AS p
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE pg_catalog.lower(pg_catalog.btrim(c.id_num)) = pg_catalog.lower(pg_catalog.btrim(p.counter_id))
           OR c.id::text = pg_catalog.btrim(p.counter_id)
           OR pg_catalog.lower(c.id_num) = CASE WHEN pg_catalog.lower(pg_catalog.btrim(p.counter_id)) ~ '^(doctor[[:space:]]*)?[0-9]+$'
               THEN 'doctor ' || (pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(p.counter_id)), '^doctor[[:space:]]*', '')::numeric)::text END
        ORDER BY c.id LIMIT 1
      ) AS assigned ON true
      -- A visit with no stored assignment follows queueService.getDoctorForService
      -- (unknown services route to Doctor 1). Reported as doctor_source = 'service'.
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE c.id_num = CASE
          WHEN p.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN p.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN p.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1' END
        ORDER BY c.id LIMIT 1
      ) AS routed ON true
    ), matched AS (
      SELECT v.* FROM visits AS v
      WHERE (v_search = '' OR pg_catalog.strpos(pg_catalog.lower(COALESCE(v.id_num, '')), v_search) > 0
             OR pg_catalog.strpos(pg_catalog.lower(COALESCE(v.queue_number, '')), v_search) > 0)
        AND (v_status = '' OR v.status::text = v_status)
        AND (v_service = '' OR v.service_type = v_service)
        AND (v_visit_id IS NULL OR v.id = v_visit_id)
        AND (v_date IS NULL OR (v.created_at AT TIME ZONE 'Asia/Manila')::date = v_date)
        -- An unresolvable stored assignment is never re-routed by service.
        AND (v_doctor IS NULL OR CASE WHEN v.has_assignment THEN v.assigned_id ELSE v.routed_id END = v_doctor)
    ), paged AS (
      SELECT * FROM matched ORDER BY created_at DESC, id DESC LIMIT p_limit OFFSET v_offset
    )
    SELECT pg_catalog.jsonb_build_object(
      'rows', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'patient_name', m.id_num, 'queue_number', m.queue_number, 'service_type', m.service_type,
        'doctor', CASE WHEN m.has_assignment THEN COALESCE(m.assigned_name, m.counter_id) ELSE m.routed_name END,
        'doctor_source', CASE WHEN NOT m.has_assignment THEN 'service' WHEN m.assigned_id IS NULL THEN 'unresolved' ELSE 'assigned' END,
        'priority_score', m.priority_score, 'status', m.status, 'created_at', m.created_at, 'called_at', m.called_at,
        'consultation_started_at', m.consultation_started_at, 'completed_at', m.completed_at
      ) ORDER BY m.created_at DESC, m.id DESC) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT pg_catalog.count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', v_now
    ) INTO result;

  ELSIF p_category IN ('staff', 'accounts') THEN
    -- Position follows queueService.isFrontdeskAssignment: role superadmin -> Super Admin;
    -- role admin with a blank assignment or the legacy "Front Desk" label -> Frontdesk;
    -- any other admin -> Doctor (doctor_resolved = false when the label names no counter).
    WITH identities AS (
      SELECT u.id_num, u.role::text AS role, u.doctor_name,
        CASE WHEN u.role::text = 'superadmin' THEN 'Super Admin'
             WHEN pg_catalog.lower(pg_catalog.btrim(COALESCE(u.doctor_name, ''))) IN ('', 'front desk', 'frontdesk') THEN 'Frontdesk'
             ELSE 'Doctor' END AS position,
        linked.id AS doctor_id, linked.id_num AS doctor_counter,
        pg_catalog.max(s.created_at) AS last_login, pg_catalog.max(s.last_seen_at) AS last_seen,
        -- Same 75-second presence rule as get_staff_doctor_presence.
        COALESCE(pg_catalog.bool_or(s.revoked_at IS NULL AND s.expires_at > v_now
          AND s.last_seen_at >= v_now - interval '75 seconds'), false) AS online,
        COALESCE(pg_catalog.bool_or(s.revoked_at IS NULL AND s.expires_at > v_now), false) AS authenticated
      FROM public.users AS u
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE u.role::text = 'admin'
          AND pg_catalog.lower(pg_catalog.btrim(COALESCE(u.doctor_name, ''))) NOT IN ('', 'front desk', 'frontdesk')
          AND (pg_catalog.lower(pg_catalog.btrim(c.id_num)) = pg_catalog.lower(pg_catalog.btrim(u.doctor_name))
            OR c.id::text = pg_catalog.btrim(u.doctor_name)
            OR pg_catalog.lower(c.id_num) = CASE WHEN pg_catalog.lower(pg_catalog.btrim(u.doctor_name)) ~ '^(doctor[[:space:]]*)?[0-9]+$'
                THEN 'doctor ' || (pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(u.doctor_name)), '^doctor[[:space:]]*', '')::numeric)::text END)
        ORDER BY c.id LIMIT 1
      ) AS linked ON true
      LEFT JOIN public.staff_auth_sessions AS s ON s.user_id_num = u.id_num
      GROUP BY u.id_num, u.role, u.doctor_name, linked.id, linked.id_num
    ), matched AS (
      SELECT * FROM identities AS i
      WHERE (v_search = '' OR pg_catalog.strpos(pg_catalog.lower(i.id_num || ' ' || COALESCE(i.doctor_name, '')), v_search) > 0)
        AND (v_role = '' OR i.role = v_role)
        AND (v_position = '' OR i.position = v_position)
        AND (v_doctor IS NULL OR i.doctor_id = v_doctor)
        AND (v_presence = '' OR i.online = (v_presence = 'online'))
    ), paged AS (
      SELECT * FROM matched ORDER BY last_login DESC NULLS LAST, id_num LIMIT p_limit OFFSET v_offset
    )
    SELECT pg_catalog.jsonb_build_object(
      'rows', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id_num,
        'display_name', CASE WHEN m.position = 'Doctor' THEN COALESCE(m.doctor_counter, m.doctor_name) ELSE m.id_num END,
        'role', m.role, 'position', m.position,
        'doctor', CASE WHEN m.position = 'Doctor' THEN COALESCE(m.doctor_counter, m.doctor_name) END,
        'doctor_resolved', CASE WHEN m.position = 'Doctor' THEN m.doctor_id IS NOT NULL END,
        'staff_profile', m.id_num, 'account_status', 'Enabled (existing account)',
        'online', m.online, 'authenticated', m.authenticated, 'last_login', m.last_login, 'last_seen', m.last_seen,
        -- users has no creation timestamp; the UI shows "Not recorded".
        'created_at', NULL
      ) ORDER BY m.last_login DESC NULLS LAST, m.id_num) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT pg_catalog.count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', v_now
    ) INTO result;

  ELSE
    WITH matched AS (
      SELECT a.id, a.user_id_num, a.event, a.occurred_at FROM public.staff_auth_activity AS a
      WHERE (v_account = '' OR a.user_id_num = v_account)
        AND (v_date IS NULL OR (a.occurred_at AT TIME ZONE 'Asia/Manila')::date = v_date)
    ), paged AS (
      SELECT * FROM matched ORDER BY occurred_at DESC, id DESC LIMIT p_limit OFFSET v_offset
    )
    SELECT pg_catalog.jsonb_build_object(
      'rows', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'account', m.user_id_num, 'event', m.event, 'occurred_at', m.occurred_at
      ) ORDER BY m.occurred_at DESC, m.id DESC) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT pg_catalog.count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', v_now
    ) INTO result;
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_central_records(text, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_central_records(text, jsonb, integer, integer) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';
