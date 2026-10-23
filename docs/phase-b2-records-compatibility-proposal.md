# Phase B.2 — Records compatibility proposal

> **Update 2026-10-23:** the approved contract is now prepared as installation artifacts under `backend/scripts/20261023-*`
> (still not installed). See [phase-b2-records-installation.md](phase-b2-records-installation.md), which lists where the
> prepared SQL deliberately differs from the draft in §5. This document is kept as the review record.

Status: **PROPOSAL ONLY. Not installed, not placed under `backend/scripts/`, not applied anywhere.**
The SQL is a review draft inside this document so no install script can run it. It was executed only in an
isolated in-memory PGlite database whose tables mirror the development project's exposed metadata.
Separate written approval is required before it becomes a migration. Date: 2026-10-23. Baseline: `main` @ `8222eac`
plus the uncommitted R1, R2, R2.1, S1, A7, F5 and Records-filter work.

## 1. Why Records does not work today

| # | Root cause | Evidence |
|---|---|---|
| 1 | Phase B is **not installed** on the development project. `get_central_records` and `staff_auth_activity` do not exist, so every `/api/records/*` call returns 503 "Records storage unavailable". | 2026-10-23 read-only metadata probe: `/rpc/get_central_records` absent from the OpenAPI document; `staff_auth_activity?select=id&limit=0` → 404 `PGRST205`. |
| 2 | Installed as written, it would still fail: `get_central_records` reads `patients.first_name` / `last_name`, which do not exist. All four categories share one SQL statement, so staff, accounts and activity fail too (42703 → 503). | Probe: `patients?select=first_name&limit=0` → 400 `42703` (same for `last_name`). PGlite reproduction: all four categories raise 42703. |
| 3 | Patient names are stored in `patients.id_num`. Since the first commit (`bc5b27d`) both registration routes write the entered full name to `id_num`; no code has ever written `first_name` / `last_name`. Rows written before this repository or by other tools cannot be characterised from source, so the proposal shows `id_num` as entered and never splits or rewrites it. | `routes/index.js` (`idNum: fullName`), `git log -S`. |
| 4 | `users.created_at` does not exist, but `getUsers` selects and orders by it, so the Superadmin user list fails against this project (it surfaces as the generic "queue database is unavailable" 503). | Probe: `users?select=created_at&limit=0` → 400 `42703`; `queueService.getUsers`, `pages/index.js:1059`. |
| 5 | Positions: any account with a non-empty `doctor_name` is labelled "Doctor", so a legacy Frontdesk account whose label is "Front Desk" is shown and filtered as a Doctor; Frontdesk is otherwise shown as "Admin". | `20261014-phase-b-records.sql` position `CASE`. |

## 2. Other contract mismatches found

* **Doctor filter (patients):** compares only the stored `counter_id`, so never-called waiting visits match no doctor. Analytics (`getFilteredPatients`) uses the stored assignment, else the service-to-doctor mapping. B.2 uses the Analytics rule and reports which one applied.
* **Doctor filter (staff/accounts):** exact text match on `doctor_name`; aliases such as `doctor 1` or `1` never match. B.2 resolves both sides to the counter.
* **Invalid input → 503:** the route accepts dates like `2026-02-31` (JavaScript `Date.parse` accepts them), and PostgreSQL then raises 22008, which the route reports as "storage unavailable". Invalid status, presence or position values return silently empty pages. B.2 raises `22023` and the route should map it to 400.
* **Error handling:** every RPC error becomes the same 503 message and nothing is logged, so operators cannot tell "not installed" from "bad request" from "database down". No database detail reaches the browser (keep it that way).
* **Pagination order:** `sort_id` is `id::text`, so ties sort `"10"` before `"9"`. B.2 orders by the numeric id.
* **Verify script:** `20261014-phase-b-verify.sql` inserts `first_name`, `last_name` and a NOT NULL `mobile_number`, so it cannot run on this project either. B.2 needs its own verify script.
* **Redesigned filter toolbar:** the keys it sends (`search, date, service, doctor, status, role, position, presence`) are all accepted by the route. One value changes with B.2: position `"Admin"` becomes `"Frontdesk"` (`frontend/lib/recordsFilters.js` `POSITION_OPTIONS`; a value change, not a UI redesign).

## 3. Cross-cutting finding (not Phase B): `no-show` is not a status on this project

The project's `queue_status` enum exposes only `waiting, serving, completed, cancelled`. The repository's base schema lacks `'no-show'` too and no migration adds it, so **marking a patient No-show cannot succeed on this project** (PostgreSQL rejects the enum value). Records' "No-show" status filter will simply match nothing until this is fixed. It needs its own approval:

```sql
-- Separate change, outside any transaction that uses the value. Additive, no row changes.
ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show';
```

## 4. Proposed contract (`get_central_records`, unchanged signature)

`public.get_central_records(p_category text, p_filters jsonb, p_page integer, p_limit integer) RETURNS jsonb` →
`{ rows, total, page, limit, observed_at }`. Only `service_role` may execute it.

| Category | Row fields | Filters |
|---|---|---|
| `patients` | `id, patient_name` (= `id_num` as entered), `queue_number, service_type, doctor, doctor_source` (`assigned` / `service` / `unresolved`), `priority_score, status, created_at, called_at, consultation_started_at, completed_at` | `search` (name/identifier as entered or ticket), `date` (Manila registration date), `service`, `doctor`, `status`, `visit` |
| `staff`, `accounts` | `id, display_name, role, position` (`Super Admin` / `Doctor` / `Frontdesk`), `doctor, doctor_resolved, staff_profile, account_status, online, authenticated, last_login, last_seen, created_at` (always `null`: not stored) | `search`, `role`, `position`, `doctor`, `presence` |
| `activity` | `id, account, event, occurred_at` | `account`, `date` |

No contact, birth, residency, PhilHealth, vulnerability, password or revision fields are returned.

Position rule: `superadmin` → Super Admin; `admin` with a blank doctor link or the legacy label `Front Desk` / `Frontdesk` → Frontdesk; any other `admin` → Doctor (`doctor_resolved = false` when the link names no counter).
Invalid category, page (1–100000), limit (1–100), date, status, role, position, presence, visit or doctor → `22023`.

## 5. Draft SQL (review only)

```sql
-- DRAFT. NOT A MIGRATION. DO NOT RUN. Phase B.2 supersedes 20261014-phase-b-records.sql,
-- which has never been installed on the development project.
-- Requires: Phase 2, Phase A, Phase 2.1, Phase 2.2. Writes no patient, user or session rows.
BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_auth_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id_num text NOT NULL,
  event text NOT NULL CHECK (event IN ('login', 'logout')),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX IF NOT EXISTS staff_auth_activity_user_time ON public.staff_auth_activity (user_id_num, occurred_at DESC);
ALTER TABLE public.staff_auth_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_auth_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.staff_auth_activity TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.staff_auth_activity_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.record_staff_login() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  INSERT INTO public.staff_auth_activity (user_id_num, event) VALUES (NEW.user_id_num, 'login');
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_staff_login() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS staff_login_activity ON public.staff_auth_sessions;
CREATE TRIGGER staff_login_activity AFTER INSERT ON public.staff_auth_sessions
  FOR EACH ROW EXECUTE FUNCTION public.record_staff_login();

-- Explicit, owner-bound logout only. Expiry, administrative revocation and account changes
-- (revoke_staff_user_sessions) are not logouts. Same signature and result as Phase A.
CREATE OR REPLACE FUNCTION public.revoke_staff_auth_session(p_session_id uuid, p_user_id_num text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  UPDATE public.staff_auth_sessions SET revoked_at = pg_catalog.clock_timestamp()
    WHERE session_id = p_session_id AND user_id_num = p_user_id_num AND revoked_at IS NULL;
  IF FOUND THEN
    INSERT INTO public.staff_auth_activity (user_id_num, event) VALUES (p_user_id_num, 'logout');
  END IF;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.revoke_staff_auth_session(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_auth_session(uuid, text) TO service_role;

-- The backend uses service_role; browsers never query these tables directly.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users, public.patients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.patients TO service_role;

CREATE OR REPLACE FUNCTION public.get_central_records(
  p_category text, p_filters jsonb DEFAULT '{}'::jsonb, p_page integer DEFAULT 1, p_limit integer DEFAULT 20
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  f jsonb := COALESCE(p_filters, '{}'::jsonb);
  v_search text := lower(btrim(COALESCE(f->>'search', '')));
  v_status text := COALESCE(f->>'status', '');
  v_service text := COALESCE(f->>'service', '');
  v_role text := COALESCE(f->>'role', '');
  v_position text := COALESCE(f->>'position', '');
  v_presence text := COALESCE(f->>'presence', '');
  v_account text := COALESCE(f->>'account', '');
  v_visit text := COALESCE(f->>'visit', '');
  v_date_text text := COALESCE(f->>'date', '');
  v_doctor_text text := btrim(COALESCE(f->>'doctor', ''));
  v_date date;
  v_doctor bigint;
  v_visit_id bigint;
  v_offset integer;
  result jsonb;
BEGIN
  IF p_category IS NULL OR p_category NOT IN ('patients', 'staff', 'accounts', 'activity')
     OR p_page IS NULL OR p_page < 1 OR p_page > 100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR jsonb_typeof(f) <> 'object'
     OR v_status NOT IN ('', 'waiting', 'serving', 'completed', 'cancelled', 'no-show')
     OR v_role NOT IN ('', 'admin', 'superadmin')
     OR v_position NOT IN ('', 'Super Admin', 'Doctor', 'Frontdesk')
     OR v_presence NOT IN ('', 'online', 'offline')
     OR (v_visit <> '' AND v_visit !~ '^[0-9]{1,18}$') THEN
    RAISE EXCEPTION 'Invalid records request' USING ERRCODE = '22023';
  END IF;
  IF v_date_text <> '' THEN
    IF v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END IF;
    BEGIN
      v_date := v_date_text::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END;
    IF to_char(v_date, 'YYYY-MM-DD') <> v_date_text THEN
      RAISE EXCEPTION 'Invalid records date' USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Same alias rule as the backend's resolveDoctorCounter; lowest counter id wins.
  IF v_doctor_text <> '' THEN
    SELECT c.id INTO v_doctor FROM public.counters AS c
      WHERE lower(btrim(c.id_num)) = lower(v_doctor_text) OR c.id::text = v_doctor_text
         OR lower(c.id_num) = CASE WHEN lower(v_doctor_text) ~ '^(doctor[[:space:]]*)?[0-9]+$'
             THEN 'doctor ' || (regexp_replace(lower(v_doctor_text), '^doctor[[:space:]]*', '')::numeric)::text END
      ORDER BY c.id LIMIT 1;
    IF v_doctor IS NULL THEN
      RAISE EXCEPTION 'Unknown doctor filter' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF v_visit <> '' THEN v_visit_id := v_visit::bigint; END IF;
  v_offset := (p_page - 1) * p_limit;

  IF p_category = 'patients' THEN
    WITH visits AS (
      SELECT p.*, assigned.id AS assigned_id, assigned.id_num AS assigned_name, routed.id AS routed_id, routed.id_num AS routed_name,
        NULLIF(btrim(COALESCE(p.counter_id, '')), '') IS NOT NULL AS has_assignment
      FROM public.patients AS p
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE lower(btrim(c.id_num)) = lower(btrim(p.counter_id)) OR c.id::text = btrim(p.counter_id)
           OR lower(c.id_num) = CASE WHEN lower(btrim(p.counter_id)) ~ '^(doctor[[:space:]]*)?[0-9]+$'
               THEN 'doctor ' || (regexp_replace(lower(btrim(p.counter_id)), '^doctor[[:space:]]*', '')::numeric)::text END
        ORDER BY c.id LIMIT 1
      ) AS assigned ON true
      -- Never-assigned visits follow getDoctorForService (unknown services route to Doctor 1).
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE c.id_num = CASE
          WHEN p.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
          WHEN p.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
          WHEN p.service_type = 'family_planning' THEN 'Doctor 3'
          ELSE 'Doctor 1' END
        ORDER BY c.id LIMIT 1
      ) AS routed ON true
    ), filtered AS (
      SELECT v.*,
        CASE WHEN v.has_assignment THEN v.assigned_id ELSE v.routed_id END AS effective_doctor
      FROM visits AS v
      WHERE (v_search = '' OR strpos(lower(COALESCE(v.id_num, '')), v_search) > 0 OR strpos(lower(v.queue_number), v_search) > 0)
        AND (v_status = '' OR v.status::text = v_status)
        AND (v_service = '' OR v.service_type = v_service)
        AND (v_visit_id IS NULL OR v.id = v_visit_id)
        AND (v_date IS NULL OR (v.created_at AT TIME ZONE 'Asia/Manila')::date = v_date)
    ), matched AS (
      SELECT * FROM filtered WHERE v_doctor IS NULL OR effective_doctor = v_doctor
    ), paged AS (
      SELECT * FROM matched ORDER BY created_at DESC, id DESC LIMIT p_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'patient_name', m.id_num, 'queue_number', m.queue_number, 'service_type', m.service_type,
        'doctor', CASE WHEN m.has_assignment THEN COALESCE(m.assigned_name, m.counter_id) ELSE m.routed_name END,
        'doctor_source', CASE WHEN NOT m.has_assignment THEN 'service' WHEN m.assigned_id IS NULL THEN 'unresolved' ELSE 'assigned' END,
        'priority_score', m.priority_score, 'status', m.status, 'created_at', m.created_at, 'called_at', m.called_at,
        'consultation_started_at', m.consultation_started_at, 'completed_at', m.completed_at
      ) ORDER BY m.created_at DESC, m.id DESC) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', clock_timestamp()
    ) INTO result;

  ELSIF p_category IN ('staff', 'accounts') THEN
    WITH identities AS (
      SELECT u.id_num, u.role::text AS role, u.doctor_name,
        CASE WHEN u.role::text = 'superadmin' THEN 'Super Admin'
             WHEN lower(btrim(COALESCE(u.doctor_name, ''))) IN ('', 'front desk', 'frontdesk') THEN 'Frontdesk'
             ELSE 'Doctor' END AS position,
        linked.id AS doctor_id, linked.id_num AS doctor_counter,
        max(s.created_at) AS last_login, max(s.last_seen_at) AS last_seen,
        COALESCE(bool_or(s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
          AND s.last_seen_at > clock_timestamp() - interval '75 seconds'), false) AS online,
        COALESCE(bool_or(s.revoked_at IS NULL AND s.expires_at > clock_timestamp()), false) AS authenticated
      FROM public.users AS u
      LEFT JOIN LATERAL (
        SELECT c.id, c.id_num FROM public.counters AS c
        WHERE lower(btrim(COALESCE(u.doctor_name, ''))) NOT IN ('', 'front desk', 'frontdesk')
          AND (lower(btrim(c.id_num)) = lower(btrim(u.doctor_name)) OR c.id::text = btrim(u.doctor_name)
            OR lower(c.id_num) = CASE WHEN lower(btrim(u.doctor_name)) ~ '^(doctor[[:space:]]*)?[0-9]+$'
                THEN 'doctor ' || (regexp_replace(lower(btrim(u.doctor_name)), '^doctor[[:space:]]*', '')::numeric)::text END)
        ORDER BY c.id LIMIT 1
      ) AS linked ON true
      LEFT JOIN public.staff_auth_sessions AS s ON s.user_id_num = u.id_num
      GROUP BY u.id_num, u.role, u.doctor_name, linked.id, linked.id_num
    ), matched AS (
      SELECT * FROM identities AS i
      WHERE (v_search = '' OR strpos(lower(i.id_num || ' ' || COALESCE(i.doctor_name, '')), v_search) > 0)
        AND (v_role = '' OR i.role = v_role)
        AND (v_position = '' OR i.position = v_position)
        AND (v_doctor IS NULL OR i.doctor_id = v_doctor)
        AND (v_presence = '' OR i.online = (v_presence = 'online'))
    ), paged AS (
      SELECT * FROM matched ORDER BY last_login DESC NULLS LAST, id_num LIMIT p_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id_num,
        'display_name', CASE WHEN m.position = 'Doctor' THEN COALESCE(m.doctor_counter, m.doctor_name) ELSE m.id_num END,
        'role', m.role, 'position', m.position,
        'doctor', CASE WHEN m.position = 'Doctor' THEN COALESCE(m.doctor_counter, m.doctor_name) END,
        'doctor_resolved', CASE WHEN m.position = 'Doctor' THEN m.doctor_id IS NOT NULL END,
        'staff_profile', m.id_num, 'account_status', 'Enabled (existing account)',
        'online', m.online, 'authenticated', m.authenticated, 'last_login', m.last_login, 'last_seen', m.last_seen,
        'created_at', NULL
      ) ORDER BY m.last_login DESC NULLS LAST, m.id_num) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', clock_timestamp()
    ) INTO result;

  ELSE
    WITH matched AS (
      SELECT a.* FROM public.staff_auth_activity AS a
      WHERE (v_account = '' OR a.user_id_num = v_account)
        AND (v_date IS NULL OR (a.occurred_at AT TIME ZONE 'Asia/Manila')::date = v_date)
    ), paged AS (
      SELECT * FROM matched ORDER BY occurred_at DESC, id DESC LIMIT p_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'account', m.user_id_num, 'event', m.event, 'occurred_at', m.occurred_at)
        ORDER BY m.occurred_at DESC, m.id DESC) FROM paged AS m), '[]'::jsonb),
      'total', (SELECT count(*) FROM matched), 'page', p_page, 'limit', p_limit, 'observed_at', clock_timestamp()
    ) INTO result;
  END IF;
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_central_records(text, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_central_records(text, jsonb, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
```

Notes: `pg_catalog` is always searched first, so built-ins resolve under `search_path = ''`. The doctor alias
rule copies `get_staff_doctor_presence` and `queueService.resolveDoctorCounter` (lowest counter id wins).

## 6. Node and frontend changes (after approval; not implemented)

* `backend/src/routes/records.js`: validate `date` as a real calendar date and `status` / `role` / `position` / `presence` / `visit` against the same lists (400 before any RPC). Map RPC errors: `22023`/`22007`/`22008` → 400 "Invalid records filter"; `PGRST202`, `PGRST205`, `42883`, `42P01`, `42703` → 503 "Records are not installed or not compatible with this database"; anything else → 503 "Records storage unavailable". Log only the route, category and SQLSTATE server-side; never send database text to the browser.
* `queueService.getUsers`: select `id_num, role, doctor_name` and order by `id_num`; no `created_at` (the column does not exist). `pages/index.js:1059`: show "Not recorded" instead of `new Date(undefined)`.
* `frontend/lib/recordsFilters.js`: position option `{ value: "Frontdesk", label: "Front desk" }` instead of `"Admin"`. Optionally label the patient column "Registered name / ID (as entered)" and show `doctor_source` ("routed by service" when not yet assigned). No layout change.
* Tests: route error-mapping and validation tests; B.2 PGlite suite (see §7); a B.2 verify script for the SQL Editor that creates synthetic rows with only the live columns and rolls back.

## 7. Installation plan (each step needs approval)

1. Approve this contract, especially: names shown exactly as stored in `id_num`; Frontdesk position rule; doctor filter = stored assignment, else service routing; `created_at` reported as not recorded.
2. Approve the separate `no-show` enum change (§3), independently of Records.
3. Turn §5 into `backend/scripts/2026xxxx-phase-b2-records.sql`, plus a read-only preflight and a rolled-back verify script; keep the original Phase B file unchanged as history and never install it.
4. Run the preflight on the development project (catalog only), then install B.2 in one transaction, then the verify script. Deploy the Node changes afterwards (the current route already fails closed with 503).
5. Order risk: re-applying Phase A after B.2 replaces `revoke_staff_auth_session` and silently stops logout recording; the verify script must check the installed body.

Rollback (no data loss): redeploy the previous backend; `DROP FUNCTION public.get_central_records(text, jsonb, integer, integer)`; restore Phase A's `revoke_staff_auth_session` body; drop the `staff_login_activity` trigger. Keep `staff_auth_activity` rows unless their removal is separately approved. RLS/grant statements match what the Oct 16 rollout already reported and are not rolled back.
