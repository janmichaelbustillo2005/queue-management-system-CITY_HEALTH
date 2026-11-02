-- D1-R Records (shared dispatch): post-install verification. Inserts two synthetic visits inside
-- this transaction and ROLLS BACK at the end: nothing is kept. Any failure raises an exception.
-- Expected final result: one row, result = 'D1-R verification passed'.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $verify$
DECLARE
  c_fn constant text := 'public.get_central_records(text,jsonb,integer,integer)';
  v_result jsonb;
  v_row jsonb;
  v_uncalled bigint;
  v_treated bigint;
BEGIN
  IF (SELECT pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\r\n', E'\n')) FROM pg_catalog.pg_proc AS p
      WHERE p.oid = pg_catalog.to_regprocedure(c_fn)) IS DISTINCT FROM 'b92dbefe03b63d0b4ef92997af0649cd' THEN
    RAISE EXCEPTION 'D1-R verify: get_central_records is not the reviewed D1-R body';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p WHERE p.oid = pg_catalog.to_regprocedure(c_fn)
      AND p.prosecdef AND p.proconfig = ARRAY['search_path=""'])
     OR NOT pg_catalog.has_function_privilege('service_role', c_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', c_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', c_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'D1-R verify: security settings or grants changed';
  END IF;

  INSERT INTO public.patients (queue_number, id_num, service_type, status, priority_score)
    VALUES ('D1RV-001', 'd1r verify uncalled', 'prenatal', 'waiting', 1) RETURNING id INTO v_uncalled;
  INSERT INTO public.patients (queue_number, id_num, service_type, status, counter_id, priority_score,
      called_at, consultation_started_at, completed_at)
    VALUES ('D1RV-002', 'd1r verify treated', 'prenatal', 'completed', 'Doctor 1', 1,
      pg_catalog.clock_timestamp() - interval '10 minutes', pg_catalog.clock_timestamp() - interval '9 minutes',
      pg_catalog.clock_timestamp()) RETURNING id INTO v_treated;

  -- Without the key (and with 'service'): Phase B.2 behaviour, the uncalled visit is routed by service.
  FOREACH v_result IN ARRAY ARRAY[
    public.get_central_records('patients', '{"search":"d1r verify"}', 1, 20),
    public.get_central_records('patients', '{"search":"d1r verify","dispatch":"service"}', 1, 20)] LOOP
    SELECT r INTO v_row FROM pg_catalog.jsonb_array_elements(v_result->'rows') AS r WHERE (r->>'id')::bigint = v_uncalled;
    IF v_row->>'doctor' IS DISTINCT FROM 'Doctor 2' OR v_row->>'doctor_source' IS DISTINCT FROM 'service' THEN
      RAISE EXCEPTION 'D1-R verify: service routing changed: %', v_row;
    END IF;
  END LOOP;
  IF (public.get_central_records('patients', '{"search":"d1r verify","doctor":"Doctor 2"}', 1, 20)->>'total')::int <> 1 THEN
    RAISE EXCEPTION 'D1-R verify: the service-mode doctor filter changed';
  END IF;

  -- Shared dispatch: the uncalled visit has no doctor; the treated visit keeps its stored doctor.
  v_result := public.get_central_records('patients', '{"search":"d1r verify","dispatch":"shared"}', 1, 20);
  SELECT r INTO v_row FROM pg_catalog.jsonb_array_elements(v_result->'rows') AS r WHERE (r->>'id')::bigint = v_uncalled;
  IF v_row ? 'doctor' IS NOT TRUE OR pg_catalog.jsonb_typeof(v_row->'doctor') <> 'null'
     OR v_row->>'doctor_source' IS DISTINCT FROM 'unassigned' OR v_row->>'service_type' IS DISTINCT FROM 'prenatal' THEN
    RAISE EXCEPTION 'D1-R verify: shared dispatch did not report an unassigned visit: %', v_row;
  END IF;
  SELECT r INTO v_row FROM pg_catalog.jsonb_array_elements(v_result->'rows') AS r WHERE (r->>'id')::bigint = v_treated;
  IF v_row->>'doctor' IS DISTINCT FROM 'Doctor 1' OR v_row->>'doctor_source' IS DISTINCT FROM 'assigned' THEN
    RAISE EXCEPTION 'D1-R verify: shared dispatch changed a stored doctor: %', v_row;
  END IF;
  IF (public.get_central_records('patients', '{"search":"d1r verify","dispatch":"shared","doctor":"Doctor 2"}', 1, 20)->>'total')::int <> 0
     OR (public.get_central_records('patients', '{"search":"d1r verify","dispatch":"shared","doctor":"Doctor 1"}', 1, 20)->>'total')::int <> 1 THEN
    RAISE EXCEPTION 'D1-R verify: the shared-dispatch doctor filter must match stored doctors only';
  END IF;

  BEGIN
    PERFORM public.get_central_records('patients', '{"dispatch":"automatic"}', 1, 20);
    RAISE EXCEPTION 'D1-R verify: an unknown dispatch value was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END
$verify$;
SELECT 'D1-R verification passed' AS result;
ROLLBACK;
