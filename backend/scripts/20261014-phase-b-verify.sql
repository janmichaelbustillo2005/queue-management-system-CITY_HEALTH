-- Run only on an approved NON-PRODUCTION project after Phase A, Phase 2 and B.
-- All fixtures and changes roll back. No credentials or real patients are used.
BEGIN;
INSERT INTO public.users(id_num,password,role,doctor_name)
VALUES ('phase-b-test-admin','not-a-real-credential','admin','Doctor B Test');
INSERT INTO public.patients(id_num,first_name,last_name,mobile_number,queue_number,service_type,status)
VALUES ('phase-b-test-patient','PhaseB','Fixture','00000000000','B-TEST-TICKET','phase-b-test-service','completed');
DO $$
DECLARE revision uuid; sid uuid := gen_random_uuid(); result jsonb;
BEGIN
 SELECT auth_revision INTO revision FROM public.users WHERE id_num='phase-b-test-admin';
 PERFORM public.create_staff_auth_session(sid,'phase-b-test-admin','admin','Doctor B Test',revision);
 result := public.get_central_records('patients','{"search":"B-TEST-TICKET","service":"phase-b-test-service","status":"completed"}',1,20);
 IF (result->>'total')::integer <> 1 OR result->'rows'->0->>'patient_name' <> 'PhaseB Fixture' THEN RAISE EXCEPTION 'Patient filtering/name mismatch'; END IF;
 IF result->'rows'->0 ? 'mobile_number' OR result->'rows'->0 ? 'id_num' THEN RAISE EXCEPTION 'Sensitive patient field exposed'; END IF;
 result := public.get_central_records('accounts','{"search":"phase-b-test-admin","presence":"online"}',1,20);
 IF (result->>'total')::integer <> 1 THEN RAISE EXCEPTION 'Online identity mismatch'; END IF;
 IF result->'rows'->0 ? 'password' OR result->'rows'->0 ? 'auth_revision' THEN RAISE EXCEPTION 'Credential exposed'; END IF;
 UPDATE public.staff_auth_sessions SET last_seen_at=clock_timestamp()-interval '76 seconds' WHERE session_id=sid;
 result := public.get_central_records('accounts','{"search":"phase-b-test-admin","presence":"offline"}',1,20);
 IF (result->>'total')::integer <> 1 OR NOT (result->'rows'->0->>'authenticated')::boolean THEN RAISE EXCEPTION 'Presence confused with authentication'; END IF;
 IF (SELECT count(*) FROM public.staff_auth_activity WHERE user_id_num='phase-b-test-admin' AND event='logout') <> 0 THEN RAISE EXCEPTION 'Heartbeat generated logout'; END IF;
 PERFORM public.revoke_staff_auth_session(sid,'phase-b-test-admin');
 PERFORM public.revoke_staff_auth_session(sid,'phase-b-test-admin');
 IF (SELECT count(*) FROM public.staff_auth_activity WHERE user_id_num='phase-b-test-admin' AND event='logout') <> 1 THEN RAISE EXCEPTION 'Explicit logout not idempotent'; END IF;
 PERFORM public.create_staff_auth_session(gen_random_uuid(),'phase-b-test-admin','admin','Doctor B Test',revision);
 PERFORM public.revoke_staff_user_sessions('phase-b-test-admin');
 IF (SELECT count(*) FROM public.staff_auth_activity WHERE user_id_num='phase-b-test-admin' AND event='logout') <> 1 THEN RAISE EXCEPTION 'Administrative revocation generated logout'; END IF;
 IF has_function_privilege('anon','public.get_central_records(text,jsonb,integer,integer)','EXECUTE') OR has_function_privilege('authenticated','public.get_central_records(text,jsonb,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Browser RPC access exposed'; END IF;
 IF has_table_privilege('anon','public.patients','SELECT') OR has_table_privilege('authenticated','public.users','SELECT') THEN RAISE EXCEPTION 'Raw records access exposed'; END IF;
END $$;
ROLLBACK;
