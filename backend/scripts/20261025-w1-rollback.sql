-- W1 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with separate approval, and only to undo
-- 20261025-w1-atomic-cancel.sql on the project it was installed on.
--
-- Removes exactly public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT,
-- TEXT) and then its internal helper public.qms_resolve_doctor_counter(TEXT), in that order (the
-- Cancel body calls the helper; plpgsql records no catalog dependency for that call). With the
-- current backend, Cancel then fails closed: waiting visits that no counter points at still
-- cancel; a serving visit, or any visit a counter points at, answers 503 "needs the W1 database
-- migration ... Nothing was changed". Patients, counters, users, sessions, grants on tables, C1,
-- F5 and Phase B.2 are not touched. Refuses (nothing dropped) if any database object depends on
-- either function or any other function body calls them. Never uses CASCADE. Safe to run more
-- than once.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE
  v_fn REGPROCEDURE := pg_catalog.to_regprocedure('public.cancel_patient_visit(bigint,uuid,text,text,text,uuid,text,text,text)');
  v_helper REGPROCEDURE := pg_catalog.to_regprocedure('public.qms_resolve_doctor_counter(text)');
  v_dependents TEXT;
  v_callers TEXT;
BEGIN
  IF v_fn IS NULL AND v_helper IS NULL THEN
    RAISE NOTICE 'W1 rollback: cancel_patient_visit and qms_resolve_doctor_counter are not installed; nothing to remove';
    RETURN;
  END IF;
  SELECT pg_catalog.string_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_dependents
    FROM pg_catalog.pg_depend AS d
    WHERE d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid IN (v_fn, v_helper)
      AND d.deptype IN ('n', 'a');
  -- The only expected caller of the helper is cancel_patient_visit, removed first below.
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::TEXT, ', ') INTO v_callers
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid IS DISTINCT FROM v_fn AND p.oid IS DISTINCT FROM v_helper
      AND (p.prosrc ~ '\mcancel_patient_visit\M' OR p.prosrc ~ '\mqms_resolve_doctor_counter\M');
  IF v_dependents IS NOT NULL OR v_callers IS NOT NULL THEN
    RAISE EXCEPTION 'W1 rollback refused: dependents [%], callers [%]. Review separately; do not use CASCADE.',
      COALESCE(v_dependents, 'none'), COALESCE(v_callers, 'none');
  END IF;
END
$rollback$;
DROP FUNCTION IF EXISTS public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.qms_resolve_doctor_counter(TEXT);
NOTIFY pgrst, 'reload schema';
COMMIT;
