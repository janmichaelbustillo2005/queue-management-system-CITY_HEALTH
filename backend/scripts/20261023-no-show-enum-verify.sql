-- No-show enum verification. NOT a migration. Prepared, not executed. Repeatable.
-- Run on the explicitly identified NON-PRODUCTION project after 20261023-no-show-enum.sql
-- (committed). Writes one synthetic visit (queue number B2V-NS-001) and ROLLS BACK.
-- If Phase B.2 is installed it also checks that the Records No-show filter returns it.
BEGIN;
DO $verify$
DECLARE
  v_labels text[];
  v_id bigint;
  v_result jsonb;
BEGIN
  SELECT pg_catalog.array_agg(e.enumlabel::text ORDER BY e.enumsortorder) INTO v_labels
  FROM pg_catalog.pg_enum AS e WHERE e.enumtypid = 'public.queue_status'::regtype;
  IF NOT v_labels @> ARRAY['waiting', 'serving', 'completed', 'cancelled', 'no-show'] THEN
    RAISE EXCEPTION 'No-show verify: queue_status is %; no-show is not installed', v_labels;
  END IF;
  IF EXISTS (SELECT 1 FROM public.patients WHERE queue_number = 'B2V-NS-001') THEN
    RAISE EXCEPTION 'No-show verify: synthetic fixture already exists; investigate before running';
  END IF;
  INSERT INTO public.patients (id_num, queue_number, service_type, status, created_at)
    VALUES ('B2V No-show Synthetic', 'B2V-NS-001', 'consultation', 'no-show', '2001-02-03T05:00:00Z')
    RETURNING id INTO v_id;
  IF pg_catalog.to_regprocedure('public.get_central_records(text,jsonb,integer,integer)') IS NOT NULL THEN
    v_result := public.get_central_records('patients', '{"search":"B2V-NS-001","status":"no-show"}', 1, 20);
    IF (v_result->>'total')::int <> 1 OR (v_result->'rows'->0->>'id')::bigint <> v_id THEN
      RAISE EXCEPTION 'No-show verify: the Records No-show filter does not return a no-show visit';
    END IF;
  END IF;
END
$verify$;
SELECT 'No-show verification passed; the synthetic visit is rolled back' AS result;
ROLLBACK;
