-- Phase B.2 post-installation verification. NOT a migration. Prepared, not executed.
-- Run only after 20261023-phase-b2-records.sql, on the explicitly identified NON-PRODUCTION
-- project, as the installing role. Everything it writes is synthetic (prefix b2-verify / B2V)
-- and is ROLLED BACK: no patient, user, counter, session or activity row survives. Only
-- identity-sequence values are consumed (gaps in ids), which PostgreSQL never rolls back.
-- Uses only columns that exist on the installed schema (no first_name, last_name or
-- users.created_at) and works with or without 'no-show' in queue_status. Repeatable.
--
-- Success: one row "Phase B.2 verification passed". Failure: an error naming the check;
-- the transaction is then aborted and nothing is kept.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $verify$
DECLARE
  c_fn constant text := 'public.get_central_records(text,jsonb,integer,integer)';
  v_doctor_counter constant text := 'B2V Doctor';
  v_role text;
  v_revision uuid;
  v_session uuid;
  v_result jsonb;
  v_row jsonb;
  v_bad jsonb;
  v_key text;
  v_count bigint;
  v_routed text;
BEGIN
  -- 1. Installed objects, bodies and security boundaries.
  IF pg_catalog.to_regprocedure(c_fn) IS NULL OR pg_catalog.to_regclass('public.staff_auth_activity') IS NULL THEN
    RAISE EXCEPTION 'B.2 verify: Phase B.2 is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(c_fn) AND pg_catalog.strpos(prosrc, 'doctor_source') > 0) THEN
    RAISE EXCEPTION 'B.2 verify: get_central_records is not the Phase B.2 body (original Phase B?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = 'public.revoke_staff_auth_session(uuid,text)'::regprocedure
      AND pg_catalog.strpos(prosrc, 'staff_auth_activity') > 0) THEN
    RAISE EXCEPTION 'B.2 verify: revoke_staff_auth_session has the Phase A body; was Phase A re-applied after B.2?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'staff_login_activity' AND NOT tgisinternal
      AND tgenabled <> 'D' AND tgrelid = 'public.staff_auth_sessions'::regclass) THEN
    RAISE EXCEPTION 'B.2 verify: login trigger missing or disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p
      WHERE p.oid IN (pg_catalog.to_regprocedure(c_fn), 'public.revoke_staff_auth_session(uuid,text)'::regprocedure, 'public.record_staff_login()'::regprocedure)
        AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT ('search_path=""' = ANY (p.proconfig)))) THEN
    RAISE EXCEPTION 'B.2 verify: a B.2 function is not SECURITY DEFINER with an empty search_path';
  END IF;
  IF pg_catalog.has_function_privilege('anon', c_fn, 'EXECUTE') OR pg_catalog.has_function_privilege('authenticated', c_fn, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', c_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.revoke_staff_auth_session(uuid,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.revoke_staff_auth_session(uuid,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', 'public.revoke_staff_auth_session(uuid,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', 'public.record_staff_login()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.record_staff_login()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', 'public.record_staff_login()', 'EXECUTE') THEN
    RAISE EXCEPTION 'B.2 verify: function execute privileges are not service_role-only';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.staff_auth_activity', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.staff_auth_activity', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.staff_auth_activity', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.staff_auth_activity'::regclass)
     OR pg_catalog.has_sequence_privilege('anon', pg_catalog.pg_get_serial_sequence('public.staff_auth_activity', 'id'), 'USAGE,SELECT,UPDATE')
     OR pg_catalog.has_sequence_privilege('authenticated', pg_catalog.pg_get_serial_sequence('public.staff_auth_activity', 'id'), 'USAGE,SELECT,UPDATE') THEN
    RAISE EXCEPTION 'B.2 verify: staff_auth_activity is exposed beyond service_role SELECT';
  END IF;

  -- 2. Synthetic fixtures (rolled back). Refuse to run over leftovers.
  IF EXISTS (SELECT 1 FROM public.users WHERE id_num LIKE 'b2-verify-%')
     OR EXISTS (SELECT 1 FROM public.patients WHERE queue_number LIKE 'B2V-%')
     OR EXISTS (SELECT 1 FROM public.counters WHERE id_num = v_doctor_counter) THEN
    RAISE EXCEPTION 'B.2 verify: synthetic fixture names already exist; investigate before running';
  END IF;
  INSERT INTO public.counters (id_num) VALUES (v_doctor_counter);
  INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
    ('b2-verify-doctor', 'b2-verify-not-a-credential', 'admin', v_doctor_counter),
    ('b2-verify-frontdesk', 'b2-verify-not-a-credential', 'admin', 'Front Desk'),
    ('b2-verify-blank', 'b2-verify-not-a-credential', 'admin', NULL);
  -- Manila 2001-02-03 12:00; far outside real data so date filters are deterministic.
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, created_at) VALUES
    ('B2V Synthetic Name', 'B2V-001', 'consultation', 'completed', v_doctor_counter, '2001-02-03T04:00:00Z'),
    ('B2V-ID-123', 'B2V-002', 'family_planning', 'waiting', NULL, '2001-02-03T04:00:01Z'),
    ('B2V Unresolved', 'B2V-003', 'consultation', 'cancelled', 'B2V Missing Doctor', '2001-02-03T04:00:02Z');

  -- 3. Patients: name as stored, whitelist, filters, routing.
  v_result := public.get_central_records('patients', '{"search":"b2v synthetic"}', 1, 20);
  IF (v_result->>'total')::int <> 1 OR v_result->'rows'->0->>'patient_name' <> 'B2V Synthetic Name' THEN
    RAISE EXCEPTION 'B.2 verify: patient name is not shown exactly as stored in id_num';
  END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-","date":"2001-02-03"}', 1, 20);
  IF (v_result->>'total')::int <> 3 THEN RAISE EXCEPTION 'B.2 verify: search/date filter mismatch'; END IF;
  FOR v_row IN SELECT pg_catalog.jsonb_array_elements(v_result->'rows') LOOP
    FOR v_key IN SELECT pg_catalog.jsonb_object_keys(v_row) LOOP
      IF v_key NOT IN ('id', 'patient_name', 'queue_number', 'service_type', 'doctor', 'doctor_source', 'priority_score', 'status',
          'created_at', 'called_at', 'consultation_started_at', 'completed_at') THEN
        RAISE EXCEPTION 'B.2 verify: unexpected patient field %', v_key;
      END IF;
    END LOOP;
  END LOOP;
  IF (v_result->'rows'->0->>'queue_number') <> 'B2V-003' THEN RAISE EXCEPTION 'B.2 verify: newest-first ordering mismatch'; END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-","doctor":"b2v doctor"}', 1, 20);
  IF (v_result->>'total')::int <> 1 OR v_result->'rows'->0->>'doctor_source' <> 'assigned' THEN
    RAISE EXCEPTION 'B.2 verify: stored doctor assignment filter mismatch';
  END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-002"}', 1, 20);
  SELECT c.id_num INTO v_routed FROM public.counters AS c WHERE c.id_num = 'Doctor 3' ORDER BY c.id LIMIT 1;
  IF v_result->'rows'->0->>'doctor_source' <> 'service' OR (v_result->'rows'->0->>'doctor') IS DISTINCT FROM v_routed THEN
    RAISE EXCEPTION 'B.2 verify: unassigned visit is not reported as routed by service';
  END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-003"}', 1, 20);
  IF v_result->'rows'->0->>'doctor_source' <> 'unresolved' OR v_result->'rows'->0->>'doctor' <> 'B2V Missing Doctor' THEN
    RAISE EXCEPTION 'B.2 verify: unresolved stored assignment mismatch';
  END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-","status":"no-show"}', 1, 20);
  IF (v_result->>'total')::int <> 0 THEN RAISE EXCEPTION 'B.2 verify: No-show filter mismatch'; END IF;
  v_result := public.get_central_records('patients', '{"search":"B2V-"}', 2, 2);
  IF (v_result->>'total')::int <> 3 OR pg_catalog.jsonb_array_length(v_result->'rows') <> 1 OR v_result->'rows'->0->>'queue_number' <> 'B2V-001' THEN
    RAISE EXCEPTION 'B.2 verify: pagination mismatch';
  END IF;

  -- 4. Invalid input is a validation error (22023), never a storage failure.
  FOREACH v_bad IN ARRAY ARRAY['{"status":"bogus"}', '{"date":"2026-02-31"}', '{"date":"23-10-2026"}', '{"position":"Admin"}',
      '{"presence":"maybe"}', '{"role":"root"}', '{"visit":"abc"}', '{"doctor":"B2V Nobody"}', '{"unknown":"x"}', '{"search":5}', '[]']::jsonb[] LOOP
    BEGIN
      PERFORM public.get_central_records('patients', v_bad, 1, 20);
      RAISE EXCEPTION 'B.2 verify: invalid filter accepted: %', v_bad USING ERRCODE = 'P0001';
    EXCEPTION WHEN invalid_parameter_value THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM public.get_central_records('patients', '{}', 1, 101);
    RAISE EXCEPTION 'B.2 verify: limit 101 accepted' USING ERRCODE = 'P0001';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- 5. Staff/accounts: positions, doctor link, not-recorded creation date, no credentials.
  v_result := public.get_central_records('accounts', '{"search":"b2-verify-"}', 1, 20);
  IF (v_result->>'total')::int <> 3 THEN RAISE EXCEPTION 'B.2 verify: account search mismatch'; END IF;
  FOR v_row IN SELECT pg_catalog.jsonb_array_elements(v_result->'rows') LOOP
    IF v_row ? 'password' OR v_row ? 'auth_revision' OR v_row->'created_at' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'B.2 verify: account row exposes credentials or invents a creation date';
    END IF;
    IF (v_row->>'id', v_row->>'position') NOT IN (('b2-verify-doctor', 'Doctor'), ('b2-verify-frontdesk', 'Frontdesk'), ('b2-verify-blank', 'Frontdesk')) THEN
      RAISE EXCEPTION 'B.2 verify: position mismatch for %', v_row->>'id';
    END IF;
  END LOOP;
  v_result := public.get_central_records('staff', '{"search":"b2-verify-","doctor":"B2V DOCTOR"}', 1, 20);
  IF (v_result->>'total')::int <> 1 OR v_result->'rows'->0->>'doctor_resolved' <> 'true' THEN
    RAISE EXCEPTION 'B.2 verify: staff doctor filter mismatch';
  END IF;

  -- 6. Phase A compatibility and activity recording.
  SELECT u.role::text, u.auth_revision INTO v_role, v_revision FROM public.users AS u WHERE u.id_num = 'b2-verify-doctor';
  v_session := pg_catalog.gen_random_uuid();
  PERFORM public.create_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter, v_revision);
  PERFORM public.validate_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter);
  PERFORM public.revoke_staff_auth_session(v_session, 'b2-verify-doctor');
  IF NOT public.revoke_staff_auth_session(v_session, 'b2-verify-doctor') THEN
    RAISE EXCEPTION 'B.2 verify: repeated logout no longer returns true';
  END IF;
  BEGIN
    PERFORM public.validate_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter);
    RAISE EXCEPTION 'B.2 verify: a logged-out session still validates' USING ERRCODE = 'P0001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Administrative revocation and account changes revoke sessions but are not logouts.
  v_session := pg_catalog.gen_random_uuid();
  PERFORM public.create_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter, v_revision);
  PERFORM public.revoke_staff_user_sessions('b2-verify-doctor');
  SELECT u.auth_revision INTO v_revision FROM public.users AS u WHERE u.id_num = 'b2-verify-doctor';
  v_session := pg_catalog.gen_random_uuid();
  PERFORM public.create_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter, v_revision);
  UPDATE public.users SET password = 'b2-verify-changed' WHERE id_num = 'b2-verify-doctor';
  BEGIN
    PERFORM public.validate_staff_auth_session(v_session, 'b2-verify-doctor', v_role, v_doctor_counter);
    RAISE EXCEPTION 'B.2 verify: an account change no longer invalidates sessions' USING ERRCODE = 'P0001';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  v_result := public.get_central_records('activity', '{"account":"b2-verify-doctor"}', 1, 20);
  SELECT pg_catalog.count(*) FILTER (WHERE e->>'event' = 'logout') INTO v_count FROM pg_catalog.jsonb_array_elements(v_result->'rows') AS e;
  IF (v_result->>'total')::int <> 4 OR v_count <> 1 THEN
    RAISE EXCEPTION 'B.2 verify: expected 3 logins and exactly 1 explicit logout, got % events and % logouts', v_result->>'total', v_count;
  END IF;
END
$verify$;
SELECT 'Phase B.2 verification passed; all synthetic fixtures are rolled back' AS result;
ROLLBACK;
