-- PH1: Doctor Patient History - who produced a cancelled or no-show outcome.
-- STATUS: DRAFT FOR REVIEW. NOT INSTALLED on any hosted project. Applying it to a Supabase
-- project needs separate written approval. Run 20261114-ph1-preflight.sql first, then
-- 20261114-ph1-verify.sql after.
--
-- ADDITIVE ONLY. Creates one append-only table. Replaces no function, adds no trigger, alters no
-- existing table or column and updates no row: public.patients, the W1 cancel function, FC1/OC1
-- confirmation, RR1 round robin and every Call function are untouched.
--
-- Why it is needed: a visit stores its final status, its doctor (counter_id) and completed_at, but
-- not WHO cancelled it or marked it no-show. A Doctor, the Front Desk and the Superadmin can all
-- do both, so a cancelled visit assigned to Doctor 1 may have been cancelled by the Front Desk.
-- Completed visits need nothing new: only the assigned doctor can complete a consultation.
--
-- How it is written: after a Cancel or No-show commits, the backend inserts one row naming the
-- authenticated account (its stable id_num), its kind and, for a doctor, its doctor counter.
-- A row describes exactly one outcome: (patient_id, outcome, outcome_at = patients.completed_at at
-- that moment). If the visit is later undone, re-queued and ends again, its new completed_at no
-- longer matches, so an old row can never be applied to a newer outcome. A visit whose row is
-- missing (outcomes before this table existed, or an insert that failed after the outcome
-- committed) is simply not attributed to any doctor; nothing is guessed.
--
-- Rollback: 20261114-ph1-rollback.sql (drops the table and the attributions recorded in it).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- No foreign key: like patient_assignment_history, the record outlives any later archive/clear.
CREATE TABLE IF NOT EXISTS public.patient_outcome_attribution (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id BIGINT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('cancelled', 'no-show')),
  outcome_at TIMESTAMPTZ NOT NULL,
  actor_id_num TEXT NOT NULL CHECK (pg_catalog.btrim(actor_id_num) <> ''),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('doctor', 'frontdesk', 'superadmin')),
  actor_doctor TEXT CHECK (actor_doctor IN ('Doctor 1', 'Doctor 2', 'Doctor 3')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT patient_outcome_attribution_doctor_check CHECK ((actor_role = 'doctor') = (actor_doctor IS NOT NULL)),
  CONSTRAINT patient_outcome_attribution_once UNIQUE (patient_id, outcome, outcome_at)
);
COMMENT ON TABLE public.patient_outcome_attribution IS
  'PH1: the authenticated staff account that produced a cancelled or no-show outcome, written by the backend after the outcome committed. One row per outcome (patient_id, outcome, outcome_at = patients.completed_at). Read by Doctor Patient History. Not backfilled.';
CREATE INDEX IF NOT EXISTS patient_outcome_attribution_doctor_idx
  ON public.patient_outcome_attribution (actor_doctor, patient_id) WHERE actor_role = 'doctor';

ALTER TABLE public.patient_outcome_attribution ENABLE ROW LEVEL SECURITY;
-- Browsers never read or write this table. The backend (service_role) only inserts and reads:
-- an attribution is never edited or deleted, so the history cannot be rewritten afterwards.
REVOKE ALL ON TABLE public.patient_outcome_attribution FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.patient_outcome_attribution TO service_role;
REVOKE ALL ON SEQUENCE public.patient_outcome_attribution_id_seq FROM PUBLIC, anon, authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';
