-- W1 atomic Cancel: post-installation verification. NOT a migration. Prepared, not executed
-- on any Supabase project. Run only after 20261025-w1-atomic-cancel.sql, on the explicitly
-- identified NON-PRODUCTION project, as the installing role, while no clinic activity is running
-- (the behavioral check locks every counter for a few milliseconds, as every Cancel does).
-- Everything it writes is synthetic (prefix w1v / W1V) and is ROLLED BACK: no patient, user,
-- counter, session or activity row survives. Only identity-sequence values are consumed (gaps
-- in ids), which PostgreSQL never rolls back. Works with or without 'no-show' in queue_status.
-- Repeatable.
--
-- Success: one row "W1 verification passed". Failure: an error naming the check; the
-- transaction is then aborted and nothing is kept.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $verify$
DECLARE
  c_fn CONSTANT TEXT := 'public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)';
  c_helper CONSTANT TEXT := 'public.qms_resolve_doctor_counter(text)';
  v_fn RECORD;
  v_role TEXT;
  v_check RECORD;
  v_counter_a BIGINT;
  v_counter_b BIGINT;
  v_patient_a public.patients%ROWTYPE;
  v_patient_b public.patients%ROWTYPE;
  v_after public.patients%ROWTYPE;
  v_repeat public.patients%ROWTYPE;
  v_session_frontdesk UUID := gen_random_uuid();
  v_session_doctor_b UUID := gen_random_uuid();
  v_session_revoked UUID := gen_random_uuid();
  v_code TEXT;
BEGIN
  -- 1. Installed objects and security boundaries.
  SELECT p.oid, p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
      p.prorettype, p.proretset, l.lanname,
      pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) AS source_md5
    INTO v_fn
    FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure(c_fn);
  IF NOT FOUND THEN RAISE EXCEPTION 'W1 verify: cancel_patient_visit is not installed'; END IF;
  IF NOT v_fn.prosecdef OR v_fn.lanname <> 'plpgsql' OR v_fn.owner <> 'postgres'
     OR v_fn.prorettype <> 'public.patients'::pg_catalog.regtype OR v_fn.proretset
     OR ARRAY(SELECT pg_catalog.unnest(v_fn.proconfig) ORDER BY 1) <> ARRAY['lock_timeout=5s', 'search_path=""'] THEN
    RAISE EXCEPTION 'W1 verify: cancel_patient_visit definition differs (SECURITY DEFINER, plpgsql, owner postgres, returns patients, settings)';
  END IF;
  IF v_fn.source_md5 <> '5efca5552ae5738e8cf5296e67ddbfc5' THEN
    RAISE EXCEPTION 'W1 verify: cancel_patient_visit body is not the reviewed W1 body (md5 %)', v_fn.source_md5;
  END IF;
  IF pg_catalog.to_regprocedure(c_helper) IS NULL
     OR (SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
         WHERE p.oid = pg_catalog.to_regprocedure(c_helper)) <> '8602dd6b4ea1a0fa130522413930b378'
     OR (SELECT p.prosecdef FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure(c_helper)) THEN
    RAISE EXCEPTION 'W1 verify: qms_resolve_doctor_counter is missing, SECURITY DEFINER or not the reviewed body';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.has_function_privilege(v_role, v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege(v_role, pg_catalog.to_regprocedure(c_helper), 'EXECUTE') THEN
      RAISE EXCEPTION 'W1 verify: % may execute a W1 function', v_role;
    END IF;
  END LOOP;
  IF NOT pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(c_helper), 'EXECUTE') THEN
    RAISE EXCEPTION 'W1 verify: service_role must execute cancel_patient_visit and must not execute the helper';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.aclexplode((SELECT p.proacl FROM pg_catalog.pg_proc AS p WHERE p.oid = v_fn.oid)) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'W1 verify: PUBLIC may execute cancel_patient_visit';
  END IF;
  -- Installing W1 must leave the Phase 2.2 recovery and Phase 2 lifecycle bodies untouched.
  FOR v_check IN SELECT * FROM (VALUES
      ('public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '290b271135dc8ea503bea6f10b839dac'),
      ('public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', 'ce7fd6bb1fc4aa5349200953883f48fe'),
      ('public.complete_patient_consultation(bigint,text,text,timestamptz,text)', '0c1eff1969b2f5bdc299de86955d0a21')
    ) AS pinned(signature, source_md5) LOOP
    IF (SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
        WHERE p.oid = pg_catalog.to_regprocedure(v_check.signature)) IS DISTINCT FROM v_check.source_md5 THEN
      RAISE EXCEPTION 'W1 verify: % is missing or changed', v_check.signature;
    END IF;
  END LOOP;

  -- 2. Behavior on synthetic rows (rolled back below).
  INSERT INTO public.counters (id_num) VALUES ('W1V Doctor A') RETURNING id INTO v_counter_a;
  INSERT INTO public.counters (id_num) VALUES ('W1V Doctor B') RETURNING id INTO v_counter_b;
  INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
    ('w1v-frontdesk', 'w1v-synthetic-not-a-hash', 'admin', NULL),
    ('w1v-doctor-a', 'w1v-synthetic-not-a-hash', 'admin', 'W1V Doctor A'),
    ('w1v-doctor-b', 'w1v-synthetic-not-a-hash', 'admin', 'W1V Doctor B');
  PERFORM public.create_staff_auth_session(v_session_frontdesk, 'w1v-frontdesk', 'admin', NULL,
    (SELECT u.auth_revision FROM public.users AS u WHERE u.id_num = 'w1v-frontdesk'));
  PERFORM public.create_staff_auth_session(v_session_doctor_b, 'w1v-doctor-b', 'admin', 'W1V Doctor B',
    (SELECT u.auth_revision FROM public.users AS u WHERE u.id_num = 'w1v-doctor-b'));
  PERFORM public.create_staff_auth_session(v_session_revoked, 'w1v-doctor-a', 'admin', 'W1V Doctor A',
    (SELECT u.auth_revision FROM public.users AS u WHERE u.id_num = 'w1v-doctor-a'));
  UPDATE public.staff_auth_sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE session_id = v_session_revoked;
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at)
    VALUES ('W1V synthetic A', 'W1V-0001', 'w1v-synthetic', 'serving', 'W1V Doctor A', pg_catalog.clock_timestamp())
    RETURNING * INTO v_patient_a;
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at)
    VALUES ('W1V synthetic B', 'W1V-0002', 'w1v-synthetic', 'serving', 'W1V Doctor B', pg_catalog.clock_timestamp())
    RETURNING * INTO v_patient_b;
  UPDATE public.counters SET current_patient_id = v_patient_a.id WHERE id = v_counter_a;
  UPDATE public.counters SET current_patient_id = v_patient_b.id WHERE id = v_counter_b;

  -- Refusals change nothing (each runs in its own subtransaction).
  FOR v_check IN SELECT * FROM (VALUES
      ('cross-doctor', v_session_doctor_b, 'w1v-doctor-b', 'W1V Doctor B', v_patient_a.visit_state_revision, 'Synthetic', '42501'),
      ('revoked session', v_session_revoked, 'w1v-doctor-a', 'W1V Doctor A', v_patient_a.visit_state_revision, 'Synthetic', '28000'),
      ('forged role', v_session_frontdesk, 'w1v-frontdesk', 'superadmin', v_patient_a.visit_state_revision, 'Synthetic', '28000'),
      ('stale revision', v_session_frontdesk, 'w1v-frontdesk', NULL, gen_random_uuid(), 'Synthetic', '40001'),
      ('blank reason', v_session_frontdesk, 'w1v-frontdesk', NULL, v_patient_a.visit_state_revision, '  ', '22023')
    ) AS refusal(label, session_id, user_id_num, claim, revision, reason, code) LOOP
    v_code := NULL;
    BEGIN
      PERFORM public.cancel_patient_visit(v_patient_a.id, v_check.session_id, v_check.user_id_num,
        CASE WHEN v_check.claim = 'superadmin' THEN 'superadmin' ELSE 'admin' END,
        CASE WHEN v_check.claim = 'superadmin' THEN NULL ELSE v_check.claim END,
        v_check.revision, 'serving', v_check.reason, NULL);
    EXCEPTION WHEN OTHERS THEN
      v_code := SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM v_check.code THEN
      RAISE EXCEPTION 'W1 verify: % expected SQLSTATE %, got %', v_check.label, v_check.code, COALESCE(v_code, 'success');
    END IF;
  END LOOP;
  IF (SELECT p.visit_state_revision FROM public.patients AS p WHERE p.id = v_patient_a.id) <> v_patient_a.visit_state_revision
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_a) IS DISTINCT FROM v_patient_a.id THEN
    RAISE EXCEPTION 'W1 verify: a refused cancel changed the patient or its counter';
  END IF;

  -- Success: patient and its counter change together; the other doctor's pair is untouched.
  v_after := public.cancel_patient_visit(v_patient_a.id, v_session_frontdesk, 'w1v-frontdesk', 'admin', NULL,
    v_patient_a.visit_state_revision, 'serving', '  W1 verification  ', NULL);
  IF v_after.status::TEXT <> 'cancelled' OR v_after.reason <> 'W1 verification' OR v_after.completed_at IS NULL
     OR v_after.visit_state_revision = v_patient_a.visit_state_revision
     OR v_after.called_at IS DISTINCT FROM v_patient_a.called_at OR v_after.created_at IS DISTINCT FROM v_patient_a.created_at
     OR v_after.counter_id IS DISTINCT FROM 'W1V Doctor A'
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_a) IS NOT NULL
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_b) IS DISTINCT FROM v_patient_b.id
     OR (SELECT p.visit_state_revision FROM public.patients AS p WHERE p.id = v_patient_b.id) <> v_patient_b.visit_state_revision THEN
    RAISE EXCEPTION 'W1 verify: a successful cancel did not change exactly the patient and its own counter';
  END IF;
  -- An idempotent repeat writes nothing.
  v_repeat := public.cancel_patient_visit(v_patient_a.id, v_session_frontdesk, 'w1v-frontdesk', 'admin', NULL,
    v_after.visit_state_revision, 'cancelled', 'Repeat', NULL);
  IF v_repeat.visit_state_revision <> v_after.visit_state_revision OR v_repeat.reason <> 'W1 verification' THEN
    RAISE EXCEPTION 'W1 verify: a repeat cancel rewrote the cancelled visit';
  END IF;
END
$verify$;
SELECT 'W1 verification passed' AS result;
ROLLBACK;
