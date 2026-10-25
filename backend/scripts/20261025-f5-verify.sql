-- F5 safe Requeue: post-installation verification. NOT a migration. Prepared, not executed on
-- any Supabase project. Run only after 20261022-f5-requeue-terminal-recovery.sql, on the
-- explicitly identified NON-PRODUCTION project, as the installing role, while no clinic
-- activity is running (the behavioral check locks every counter for a few milliseconds, as
-- every Requeue does).
-- Everything the behavioral check writes is synthetic (prefix f5v / F5V) and is ROLLED BACK: no
-- patient, user, counter or session row survives. Only identity-sequence values are consumed
-- (gaps in ids), which PostgreSQL never rolls back. Works with or without 'no-show' in
-- queue_status. Repeatable.
--
-- Success: 17 PASS rows, failed_count=0 and all_pass=true on every row. Failure of the
-- behavioral check: an error naming the check; the transaction is then aborted and nothing is
-- kept. Function body fingerprints normalize CRLF to LF and match the approved files.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $verify$
DECLARE
  c_fn CONSTANT TEXT := 'public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)';
  v_counter_a BIGINT;
  v_counter_b BIGINT;
  v_cancelled public.patients%ROWTYPE;
  v_serving public.patients%ROWTYPE;
  v_waiting public.patients%ROWTYPE;
  v_consulted public.patients%ROWTYPE;
  v_after public.patients%ROWTYPE;
  v_check RECORD;
  v_code TEXT;
BEGIN
  IF pg_catalog.to_regprocedure(c_fn) IS NULL THEN
    RAISE EXCEPTION 'F5 verify: requeue_patient_visit is not installed';
  END IF;

  INSERT INTO public.counters (id_num) VALUES ('F5V Doctor A') RETURNING id INTO v_counter_a;
  INSERT INTO public.counters (id_num) VALUES ('F5V Doctor B') RETURNING id INTO v_counter_b;
  INSERT INTO public.users (id_num, password, role, doctor_name) VALUES
    ('f5v-frontdesk', 'f5v-synthetic-not-a-hash', 'admin', NULL);
  -- A cancelled visit that a counter still (stalely) points at: the case F5 exists for.
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at, completed_at, reason)
    VALUES ('F5V synthetic cancelled', 'F5V-0001', 'f5v-synthetic', 'cancelled', 'F5V Doctor A',
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), 'F5V original reason')
    RETURNING * INTO v_cancelled;
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at)
    VALUES ('F5V synthetic serving', 'F5V-0002', 'f5v-synthetic', 'serving', 'F5V Doctor B', pg_catalog.clock_timestamp())
    RETURNING * INTO v_serving;
  INSERT INTO public.patients (id_num, queue_number, service_type, status)
    VALUES ('F5V synthetic waiting', 'F5V-0003', 'f5v-synthetic', 'waiting')
    RETURNING * INTO v_waiting;
  INSERT INTO public.patients (id_num, queue_number, service_type, status, counter_id, called_at,
      consultation_started_at, completed_at)
    VALUES ('F5V synthetic consulted', 'F5V-0004', 'f5v-synthetic', 'completed', 'F5V Doctor A',
      pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp())
    RETURNING * INTO v_consulted;
  UPDATE public.counters SET current_patient_id = v_cancelled.id WHERE id = v_counter_a;
  UPDATE public.counters SET current_patient_id = v_serving.id WHERE id = v_counter_b;

  -- Refusals change nothing (each runs in its own subtransaction).
  FOR v_check IN SELECT * FROM (VALUES
      ('serving visit', v_serving.id, 'requeue', 'f5v-frontdesk', v_serving.visit_state_revision, 'serving',
        v_serving.created_at, v_serving.called_at, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, 'F5V Doctor B', 'P0001'),
      ('waiting visit', v_waiting.id, 'requeue', 'f5v-frontdesk', v_waiting.visit_state_revision, 'waiting',
        v_waiting.created_at, NULL, NULL, NULL, NULL, 'P0001'),
      ('completed consultation', v_consulted.id, 'requeue', 'f5v-frontdesk', v_consulted.visit_state_revision, 'completed',
        v_consulted.created_at, v_consulted.called_at, v_consulted.consultation_started_at, v_consulted.completed_at, 'F5V Doctor A', 'P0001'),
      ('undo action', v_cancelled.id, 'undo', 'f5v-frontdesk', v_cancelled.visit_state_revision, 'cancelled',
        v_cancelled.created_at, v_cancelled.called_at, NULL, v_cancelled.completed_at, 'F5V Doctor A', '22023'),
      ('non-staff account', v_cancelled.id, 'requeue', 'f5v-no-such-account', v_cancelled.visit_state_revision, 'cancelled',
        v_cancelled.created_at, v_cancelled.called_at, NULL, v_cancelled.completed_at, 'F5V Doctor A', '42501'),
      ('stale revision', v_cancelled.id, 'requeue', 'f5v-frontdesk', gen_random_uuid(), 'cancelled',
        v_cancelled.created_at, v_cancelled.called_at, NULL, v_cancelled.completed_at, 'F5V Doctor A', '40001')
    ) AS refusal(label, patient_id, action, user_id_num, revision, status, created_at, called_at, started_at,
      completed_at, counter_id, code) LOOP
    v_code := NULL;
    BEGIN
      PERFORM public.requeue_patient_visit(v_check.patient_id, v_check.action, v_check.user_id_num, v_check.revision,
        v_check.status, v_check.created_at, v_check.called_at, v_check.started_at, v_check.completed_at,
        v_check.counter_id, 'F5V refused');
    EXCEPTION WHEN OTHERS THEN
      v_code := SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM v_check.code THEN
      RAISE EXCEPTION 'F5 verify: % expected SQLSTATE %, got %', v_check.label, v_check.code, COALESCE(v_code, 'success');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.patients AS p
        JOIN (VALUES (v_cancelled.id, v_cancelled.visit_state_revision), (v_serving.id, v_serving.visit_state_revision),
          (v_waiting.id, v_waiting.visit_state_revision), (v_consulted.id, v_consulted.visit_state_revision)) AS s(id, revision)
          ON s.id = p.id
        WHERE p.visit_state_revision IS DISTINCT FROM s.revision)
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_a) IS DISTINCT FROM v_cancelled.id
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_b) IS DISTINCT FROM v_serving.id THEN
    RAISE EXCEPTION 'F5 verify: a refused requeue changed a patient or a counter';
  END IF;

  -- Success: the cancelled visit is waiting again AND its stale pointer is released, together;
  -- the other doctor's serving visit and counter are untouched.
  v_after := public.requeue_patient_visit(v_cancelled.id, 'requeue', 'f5v-frontdesk', v_cancelled.visit_state_revision,
    'cancelled', v_cancelled.created_at, v_cancelled.called_at, NULL, v_cancelled.completed_at, 'F5V Doctor A', 'F5V requeue');
  IF v_after.status::TEXT <> 'waiting' OR v_after.called_at IS NOT NULL OR v_after.counter_id IS NOT NULL
     OR v_after.consultation_started_at IS NOT NULL OR v_after.completed_at IS NOT NULL
     OR v_after.reason IS DISTINCT FROM 'F5V requeue'
     OR v_after.visit_state_revision = v_cancelled.visit_state_revision
     OR v_after.created_at <= v_cancelled.created_at
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_a) IS NOT NULL
     OR (SELECT c.current_patient_id FROM public.counters AS c WHERE c.id = v_counter_b) IS DISTINCT FROM v_serving.id
     OR (SELECT p.visit_state_revision FROM public.patients AS p WHERE p.id = v_serving.id) <> v_serving.visit_state_revision THEN
    RAISE EXCEPTION 'F5 verify: a successful requeue did not change exactly the visit and release its own pointer';
  END IF;
  -- A replay with the old snapshot is refused and writes nothing.
  v_code := NULL;
  BEGIN
    PERFORM public.requeue_patient_visit(v_cancelled.id, 'requeue', 'f5v-frontdesk', v_cancelled.visit_state_revision,
      'cancelled', v_cancelled.created_at, v_cancelled.called_at, NULL, v_cancelled.completed_at, 'F5V Doctor A', 'F5V replay');
  EXCEPTION WHEN OTHERS THEN
    v_code := SQLSTATE;
  END;
  IF v_code IS DISTINCT FROM '40001'
     OR (SELECT p.visit_state_revision FROM public.patients AS p WHERE p.id = v_cancelled.id) <> v_after.visit_state_revision THEN
    RAISE EXCEPTION 'F5 verify: a replayed requeue was not refused with 40001 (got %)', COALESCE(v_code, 'success');
  END IF;
END
$verify$;

WITH fn AS (
  SELECT p.oid, p.prokind, p.prorettype, p.proretset, p.prosecdef, p.proconfig, p.proowner, p.prosrc,
    p.proacl, l.lanname
  FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
  WHERE p.oid = pg_catalog.to_regprocedure('public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)')
), pinned(position, signature, source_md5) AS (
  VALUES
    (12, 'public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '4b5f3730bc828b73a167c462987d9084'),
    (13, 'public.recover_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', '290b271135dc8ea503bea6f10b839dac'),
    (14, 'public.undo_patient_visit_waiting(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)', 'ce7fd6bb1fc4aa5349200953883f48fe'),
    (15, 'public.complete_patient_consultation(bigint,text,text,timestamptz,text)', '0c1eff1969b2f5bdc299de86955d0a21')
), role_contracts(position, role_name, may_execute) AS (
  VALUES (8, 'anon', false), (9, 'authenticated', false), (10, 'service_role', true)
), checks(position, check_name, expected, actual, passed) AS (
  SELECT 1, 'requeue_patient_visit exists', 'plain function',
    COALESCE((SELECT CASE WHEN f.prokind = 'f' THEN 'plain function' ELSE 'kind ' || f.prokind::TEXT END FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prokind = 'f' FROM fn AS f), false)
  UNION ALL
  SELECT 2, 'return type', 'public.patients, non-set',
    COALESCE((SELECT pg_catalog.format_type(f.prorettype, NULL) || CASE WHEN f.proretset THEN ', set' ELSE ', non-set' END FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prorettype = 'public.patients'::pg_catalog.regtype AND NOT f.proretset FROM fn AS f), false)
  UNION ALL
  SELECT 3, 'language', 'plpgsql', COALESCE((SELECT f.lanname::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.lanname = 'plpgsql' FROM fn AS f), false)
  UNION ALL
  SELECT 4, 'SECURITY DEFINER', 'true', COALESCE((SELECT f.prosecdef::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT f.prosecdef FROM fn AS f), false)
  UNION ALL
  SELECT 5, 'function settings', 'search_path=""',
    COALESCE((SELECT pg_catalog.array_to_string(ARRAY(SELECT pg_catalog.unnest(f.proconfig) ORDER BY 1), ', ') FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT ARRAY(SELECT pg_catalog.unnest(f.proconfig) ORDER BY 1) = ARRAY['search_path=""'] FROM fn AS f), false)
  UNION ALL
  SELECT 6, 'owner', 'postgres', COALESCE((SELECT pg_catalog.pg_get_userbyid(f.proowner)::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.pg_get_userbyid(f.proowner) = 'postgres' FROM fn AS f), false)
  UNION ALL
  SELECT 7, 'PUBLIC has no EXECUTE', 'false',
    COALESCE((SELECT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')::TEXT FROM fn AS f), 'MISSING FUNCTION'),
    COALESCE((SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) AS a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') FROM fn AS f), false)
  UNION ALL
  SELECT r.position, r.role_name || ' EXECUTE', r.may_execute::TEXT,
    CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = r.role_name) THEN 'MISSING ROLE'
      WHEN NOT EXISTS (SELECT 1 FROM fn) THEN 'MISSING FUNCTION'
      ELSE (SELECT pg_catalog.has_function_privilege(r.role_name, f.oid, 'EXECUTE')::TEXT FROM fn AS f) END,
    COALESCE(EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS g WHERE g.rolname = r.role_name)
      AND (SELECT pg_catalog.has_function_privilege(r.role_name, f.oid, 'EXECUTE') = r.may_execute FROM fn AS f), false)
  FROM role_contracts AS r
  UNION ALL
  SELECT 11, 'patients_rotate_visit_revision trigger', 'enabled',
    COALESCE((SELECT CASE WHEN t.tgenabled <> 'D' THEN 'enabled' ELSE 'disabled' END FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), 'MISSING TRIGGER'),
    COALESCE((SELECT t.tgenabled <> 'D' FROM pg_catalog.pg_trigger AS t
      WHERE t.tgrelid = pg_catalog.to_regclass('public.patients') AND t.tgname = 'patients_rotate_visit_revision'), false)
  UNION ALL
  SELECT d.position, d.signature || ' source', d.source_md5,
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), 'MISSING FUNCTION'),
    COALESCE((SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) = d.source_md5 FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(d.signature)), false)
  FROM pinned AS d
  UNION ALL
  SELECT 16, 'exactly one requeue_patient_visit overload', '1',
    (SELECT pg_catalog.count(*)::TEXT FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'requeue_patient_visit'),
    (SELECT pg_catalog.count(*) = 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'requeue_patient_visit')
  UNION ALL
  -- Reached only if the behavioral DO block above raised nothing.
  SELECT 17, 'behavioral check (synthetic rows, rolled back)', 'passed', 'passed', true
)
SELECT c.position, c.check_name, c.expected, c.actual, c.passed,
  pg_catalog.count(*) FILTER (WHERE NOT c.passed) OVER () AS failed_count,
  pg_catalog.bool_and(c.passed) OVER () AND pg_catalog.count(*) OVER () = 17 AS all_pass
FROM checks AS c ORDER BY c.position;
ROLLBACK;
