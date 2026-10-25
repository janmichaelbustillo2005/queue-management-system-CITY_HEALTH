-- F5 rollback. STATUS: PREPARED, NOT EXECUTED. Run only with separate approval, and only to undo
-- 20261022-f5-requeue-terminal-recovery.sql on the project it was installed on.
--
-- Removes exactly public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ,
-- TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT). It never touches recover_patient_visit
-- (Phase 2.2), which F5 calls. No backend change is needed: the current backend detects the
-- missing function (PGRST202) and re-queues through recover_patient_visit, except a visit that a
-- counter still points at, which it refuses with 503 instead of leaving the pointer stale.
-- Patients, counters, users, sessions, grants on tables, C1, W1 and Phase B.2 are not touched.
-- Refuses (nothing dropped) if any database object depends on the function or another function
-- body calls it. Never uses CASCADE. Safe to run more than once.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $rollback$
DECLARE
  v_fn REGPROCEDURE := pg_catalog.to_regprocedure(
    'public.requeue_patient_visit(bigint,text,text,uuid,text,timestamptz,timestamptz,timestamptz,timestamptz,text,text)');
  v_dependents TEXT;
  v_callers TEXT;
BEGIN
  IF v_fn IS NULL THEN
    RAISE NOTICE 'F5 rollback: requeue_patient_visit is not installed; nothing to remove';
    RETURN;
  END IF;
  SELECT pg_catalog.string_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_dependents
    FROM pg_catalog.pg_depend AS d
    WHERE d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid = v_fn AND d.deptype IN ('n', 'a');
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::TEXT, ', ') INTO v_callers
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid <> v_fn AND p.prosrc ~ '\mrequeue_patient_visit\M';
  IF v_dependents IS NOT NULL OR v_callers IS NOT NULL THEN
    RAISE EXCEPTION 'F5 rollback refused: dependents [%], callers [%]. Review separately; do not use CASCADE.',
      COALESCE(v_dependents, 'none'), COALESCE(v_callers, 'none');
  END IF;
END
$rollback$;
DROP FUNCTION IF EXISTS public.requeue_patient_visit(BIGINT, TEXT, TEXT, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);
NOTIFY pgrst, 'reload schema';
COMMIT;
