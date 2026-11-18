-- NS1 verify (read-only). Run after 20261118-ns1-remove-not-present.sql. Every row should read 'ok'.
SELECT 1 AS check_no, 'set_patient_presence removed' AS check_name,
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'set_patient_presence') THEN 'ok' ELSE 'STILL PRESENT' END AS result
UNION ALL
SELECT 2, 'no patient marked Not Present',
  -- to_jsonb keeps this valid on a database that never had the OC1 columns.
  CASE WHEN (SELECT count(*) FROM public.patients AS p
      WHERE pg_catalog.to_jsonb(p) ->> 'not_present_at' IS NOT NULL OR pg_catalog.to_jsonb(p) ->> 'not_present_by' IS NOT NULL) = 0
    THEN 'ok' ELSE 'ROWS STILL SET ASIDE' END
UNION ALL
SELECT 3, 'OC1 confirmation function and guards kept',
  CASE WHEN (SELECT count(DISTINCT p.proname) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('confirm_next_patient_visit', 'qms_oc1_guard_confirmation',
        'qms_guard_front_desk_confirmation')) = 3 THEN 'ok'
    WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_next_patient_visit') THEN 'ok (OC1 not installed)'
    ELSE 'MISSING' END
UNION ALL
SELECT 4, 'patient rows unchanged in number (compare with your preflight count)',
  'info: ' || (SELECT count(*) FROM public.patients) || ' patients'
ORDER BY 1;
