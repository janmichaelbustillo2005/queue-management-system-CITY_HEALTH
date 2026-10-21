-- Phase B. Requires Phase A and consultation lifecycle migrations. Apply to development first.
-- No patient writes, new identities, backfilled activity, or queue behavior changes.
BEGIN;
CREATE TABLE IF NOT EXISTS public.staff_auth_activity (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id_num text NOT NULL,
 event text NOT NULL CHECK (event IN ('login','logout')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS staff_auth_activity_user_time ON public.staff_auth_activity(user_id_num, occurred_at DESC);
ALTER TABLE public.staff_auth_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_auth_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.staff_auth_activity TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.staff_auth_activity_id_seq TO service_role;
CREATE OR REPLACE FUNCTION public.record_staff_login() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 INSERT INTO public.staff_auth_activity(user_id_num,event) VALUES (NEW.user_id_num,'login');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.record_staff_login() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS staff_login_activity ON public.staff_auth_sessions;
CREATE TRIGGER staff_login_activity AFTER INSERT ON public.staff_auth_sessions FOR EACH ROW EXECUTE FUNCTION public.record_staff_login();
-- Only this owner-bound explicit logout RPC records logout. Administrative
-- revocation, credential changes, expiry and stale heartbeats do not.
CREATE OR REPLACE FUNCTION public.revoke_staff_auth_session(p_session_id uuid,p_user_id_num text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 UPDATE public.staff_auth_sessions SET revoked_at=clock_timestamp()
 WHERE session_id=p_session_id AND user_id_num=p_user_id_num AND revoked_at IS NULL;
 IF FOUND THEN INSERT INTO public.staff_auth_activity(user_id_num,event) VALUES(p_user_id_num,'logout'); END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.revoke_staff_auth_session(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_staff_auth_session(uuid,text) TO service_role;
-- Custom JWTs are validated by Express, not Supabase Auth. Browser database
-- roles must have no direct access to these raw identity and patient tables.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users, public.patients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.patients TO service_role;
CREATE OR REPLACE FUNCTION public.get_central_records(p_category text,p_filters jsonb DEFAULT '{}'::jsonb,p_page integer DEFAULT 1,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
 IF p_category NOT IN ('patients','staff','accounts','activity') OR p_page < 1 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid records request'; END IF;
 WITH patient_rows AS (
 SELECT jsonb_build_object('id',p.id,'patient_name',concat_ws(' ',p.first_name,p.last_name),
 'queue_number',p.queue_number,'service_type',p.service_type,'doctor',coalesce(c.id_num,p.counter_id),
 'priority_score',p.priority_score,'status',p.status,'created_at',p.created_at,'called_at',p.called_at,
 'consultation_started_at',to_jsonb(p)->'consultation_started_at','completed_at',p.completed_at) AS row,
 p.created_at AS sort_time, p.id::text AS sort_id
 FROM public.patients p LEFT JOIN LATERAL (SELECT c0.id_num FROM public.counters c0 WHERE c0.id::text=p.counter_id OR c0.id_num=p.counter_id ORDER BY (c0.id_num=p.counter_id) DESC LIMIT 1) c ON true
 WHERE p_category='patients'
 AND (coalesce(p_filters->>'search','')='' OR strpos(lower(concat_ws(' ',p.first_name,p.last_name,p.queue_number)),lower(p_filters->>'search'))>0)
 AND (coalesce(p_filters->>'status','')='' OR p.status::text=p_filters->>'status')
 AND (coalesce(p_filters->>'service','')='' OR p.service_type=p_filters->>'service')
 AND (coalesce(p_filters->>'doctor','')='' OR coalesce(c.id_num,p.counter_id)=p_filters->>'doctor')
 AND (coalesce(p_filters->>'visit','')='' OR p.id::text=p_filters->>'visit')
 AND (coalesce(p_filters->>'date','')='' OR (p.created_at AT TIME ZONE 'Asia/Manila')::date=(p_filters->>'date')::date)
 ), identities AS (
 SELECT u.id_num,u.role,u.doctor_name,
 max(s.created_at) AS last_login,max(s.last_seen_at) AS last_seen,
 coalesce(bool_or(s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-interval '75 seconds'),false) AS online,
 coalesce(bool_or(s.revoked_at IS NULL AND s.expires_at>clock_timestamp()),false) AS authenticated
 FROM public.users u LEFT JOIN public.staff_auth_sessions s ON s.user_id_num=u.id_num
 GROUP BY u.id_num,u.role,u.doctor_name
 ), account_rows AS (
 SELECT jsonb_build_object('id',u.id_num,'display_name',coalesce(u.doctor_name,u.id_num),'role',u.role,
 'position',CASE WHEN u.role::text='superadmin' THEN 'Super Admin' WHEN u.doctor_name IS NOT NULL THEN 'Doctor' ELSE 'Admin' END,
 'doctor',u.doctor_name,'staff_profile',u.id_num,'account_status','Enabled (existing account)',
 'online',u.online,'authenticated',u.authenticated,'last_login',u.last_login,'last_seen',u.last_seen,
 'created_at',null) AS row,u.last_login AS sort_time,u.id_num AS sort_id
 FROM identities u WHERE p_category IN ('staff','accounts')
 AND (coalesce(p_filters->>'search','')='' OR strpos(lower(concat_ws(' ',u.id_num,u.doctor_name)),lower(p_filters->>'search'))>0)
 AND (coalesce(p_filters->>'role','')='' OR u.role::text=p_filters->>'role')
 AND (coalesce(p_filters->>'position','')='' OR (CASE WHEN u.role::text='superadmin' THEN 'Super Admin' WHEN u.doctor_name IS NOT NULL THEN 'Doctor' ELSE 'Admin' END)=p_filters->>'position')
 AND (coalesce(p_filters->>'doctor','')='' OR u.doctor_name=p_filters->>'doctor')
 AND (coalesce(p_filters->>'presence','')='' OR u.online=(p_filters->>'presence'='online'))
 ), activity_rows AS (
 SELECT jsonb_build_object('id',a.id,'account',a.user_id_num,'event',a.event,'occurred_at',a.occurred_at) AS row,a.occurred_at AS sort_time,a.id::text AS sort_id
 FROM public.staff_auth_activity a WHERE p_category='activity'
 AND (coalesce(p_filters->>'account','')='' OR a.user_id_num=p_filters->>'account')
 AND (coalesce(p_filters->>'date','')='' OR (a.occurred_at AT TIME ZONE 'Asia/Manila')::date=(p_filters->>'date')::date)
 ), combined AS (SELECT * FROM patient_rows UNION ALL SELECT * FROM account_rows UNION ALL SELECT * FROM activity_rows),
 paged AS (SELECT * FROM combined ORDER BY sort_time DESC NULLS LAST,sort_id LIMIT p_limit OFFSET (p_page-1)*p_limit)
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(row ORDER BY sort_time DESC NULLS LAST,sort_id) FROM paged),'[]'::jsonb),
 'total',(SELECT count(*) FROM combined),'page',p_page,'limit',p_limit,'observed_at',clock_timestamp()) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.get_central_records(text,jsonb,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_central_records(text,jsonb,integer,integer) TO service_role;
COMMIT;

