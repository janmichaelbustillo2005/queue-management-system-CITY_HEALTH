-- RES1 residency review report (READ ONLY).
--
-- Since RES1, a new patient's residency must be
--   "[<Purok / Street / House No.>, ]Brgy. <Barangay>, Cabadbaran City, Agusan del Norte"
-- with one of the 31 barangays of Cabadbaran City (backend/src/lib/residency.js). This report
-- checks that shape; the backend also refuses a detail that repeats a barangay, city or province.
-- Addresses saved before RES1 are kept exactly as they were: this report only lists them for
-- an administrator to review. It changes no table, no row and no address.
--
-- Run each query on its own in the Supabase SQL editor (it shows the last result only).
-- Query 1 needs the patient-records migration (patient_records table); query 2 does not.

-- 1. Permanent patient records whose saved address is not a RES1 Cabadbaran City address.
WITH res1 AS (
  SELECT '^[[:space:],]*((.*[^,[:space:]].*)[[:space:]]*,[[:space:]]*)?((brgy|bgy)(\.[[:space:]]*|[[:space:]]+)|barangay[[:space:]]+)?('
    || 'antonio luna|bay-ang|bayabas|caasinan|cabinet|calamba|calibunan|comagascas|concepcion|del pilar|'
    || 'katugasan|kauswagan|la union|mabini|mahaba|'
    || 'poblacion 1|poblacion 2|poblacion 3|poblacion 4|poblacion 5|poblacion 6|'
    || 'poblacion 7|poblacion 8|poblacion 9|poblacion 10|poblacion 11|poblacion 12|'
    || 'puting bato|sanghan|soriano|tolosa'
    || ')[[:space:]]*,[[:space:]]*cabadbaran city[[:space:]]*,[[:space:]]*agusan del norte[[:space:]]*$' AS pattern
)
SELECT r.id,
       r.patient_code,
       r.full_name,
       r.residency AS saved_address,
       CASE WHEN coalesce(btrim(r.residency), '') = '' THEN 'No address recorded'
            ELSE 'Not a Cabadbaran City barangay address' END AS review_reason,
       r.created_at
FROM public.patient_records r, res1
WHERE coalesce(r.residency, '') !~* res1.pattern
ORDER BY r.created_at, r.id;

-- 2. How many queue visits (history, never changed) carry such an address, by kind.
WITH res1 AS (
  SELECT '^[[:space:],]*((.*[^,[:space:]].*)[[:space:]]*,[[:space:]]*)?((brgy|bgy)(\.[[:space:]]*|[[:space:]]+)|barangay[[:space:]]+)?('
    || 'antonio luna|bay-ang|bayabas|caasinan|cabinet|calamba|calibunan|comagascas|concepcion|del pilar|'
    || 'katugasan|kauswagan|la union|mabini|mahaba|'
    || 'poblacion 1|poblacion 2|poblacion 3|poblacion 4|poblacion 5|poblacion 6|'
    || 'poblacion 7|poblacion 8|poblacion 9|poblacion 10|poblacion 11|poblacion 12|'
    || 'puting bato|sanghan|soriano|tolosa'
    || ')[[:space:]]*,[[:space:]]*cabadbaran city[[:space:]]*,[[:space:]]*agusan del norte[[:space:]]*$' AS pattern
)
SELECT CASE WHEN coalesce(btrim(p.residency), '') = '' THEN 'No address recorded'
            WHEN p.residency ~* res1.pattern THEN 'RES1 Cabadbaran City address'
            ELSE 'Not a Cabadbaran City barangay address' END AS address_kind,
       count(*) AS visits
FROM public.patients p, res1
GROUP BY 1
ORDER BY 1;
