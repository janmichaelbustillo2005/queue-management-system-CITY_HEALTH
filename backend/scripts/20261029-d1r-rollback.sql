-- D1-R rollback. STATUS: PREPARED, NOT EXECUTED. Run only with separate approval, and only to undo
-- 20261029-d1r-records-shared.sql. Restores get_central_records to the exact Phase B.2 body
-- (copied verbatim from 20261023-phase-b2-records.sql). Touches no other object and no rows.
-- The backend needs no change: it retries without the "dispatch" key when the function refuses it.
BEGIN;
SET LOCAL lock_timeout = '5s';

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

NOTIFY pgrst, 'reload schema';
COMMIT;
