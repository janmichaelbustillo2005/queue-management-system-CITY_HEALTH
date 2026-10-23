# R2.1 — Cancel atomicity proposal, revision 2 (after design review)

Status: **PROPOSAL ONLY. Nothing here is installed, applied or placed under `backend/scripts/`.**
The SQL is a review draft inside a document so no install script can run it. It has **not** been executed or syntax-checked against any database.
Separate written approval is required before it becomes a migration. Date: 2026-10-22. Baseline: `main` @ `8222eac` plus uncommitted R1, R2 and R2.1 changes.

This revision supersedes the draft SQL in `docs/phase25-cancel-atomicity-proposal.md`, which is kept unchanged for comparison. The failure analysis in §1 of that document (windows W1–W4, interim mitigation) still applies and is not repeated here.

## 1. Changes from revision 1

| Review item | Problem in revision 1 | Change in this revision |
|---|---|---|
| **B1** counter resolution | A fifth resolver that differed from Node `resolveDoctorCounter` (`queueService.js:844`): no `ORDER BY`/`LIMIT` (arbitrary row on alias collision), doctor numbers limited to 1–3, `"doctor 01"`, `"Doctor1"` and numeric stored `counter_id` values not resolved. It was not "the same normalization as `complete_patient_consultation`". | One internal helper `public.qms_resolve_doctor_counter(text)` that mirrors Node and picks the lowest counter `id` deterministically (the presence function's rule). Used for the actor, the owner and the requested doctor. Not granted to any API role. |
| **B2** attribution | `counter_id` was stamped with any requested doctor when blank, including on an orphan serving visit (owner NULL). | Stamp only when the stored `counter_id` is blank, an owner exists and the validated requested doctor equals it — identical to Node (`queueService.js:1155`). |
| **B3** SQLSTATEs | Business conflicts used `40001`; the invariant failure had no code (defaulted to `P0001`, which `consultationRpc` maps to 400). | `40001` only for a stale snapshot (parity with `recover_patient_visit`). Custom `QM001`–`QM003` for business conflicts and `QM500` for a rolled-back invariant failure. |
| **B4** session | Only `public.users` was re-read; a revoked/expired session or a changed assignment still acted. | Takes the token's `jti`, role and doctor claims and validates them inside the transaction exactly as `validate_staff_auth_session` does (users `FOR SHARE`, then session `FOR SHARE`). **Needs approval (D3).** |
| **B5** reason | RPC accepted NULL; the route requires a reason (`routes/index.js:372-375`). | Reason required (`22023`). A length cap is drafted but **pending decision D6**. |
| **B6** status codes | Completed visit returned 409; Node returns 400 (`queueService.js:1141`). | Completed keeps Node's current **400** (`QM001`). Change only by decision D4. |
| Should-fix | Actor's counter resolved before counters were locked. | Resolved after the counter locks, from the same snapshot as the owner. |
| Should-fix | No lock wait limit. | `SET lock_timeout = '5s'` on the function; `55P03` → 503, nothing committed. |
| Should-fix | Idempotent repeat did not check its release count. | Repeat compares released vs. locked pointer counts too. |
| Should-fix | Function owner implicit. | `ALTER FUNCTION … OWNER TO postgres` explicit; preflight checks the owner can bypass RLS. |

## 2. Contract

```
public.cancel_patient_visit(
  p_patient_id         BIGINT,
  p_session_id         UUID,   -- JWT jti, already checked by authenticateToken; re-checked here
  p_user_id_num        TEXT,   -- JWT id_num
  p_role               TEXT,   -- JWT role
  p_doctor_name        TEXT,   -- JWT doctor_name (NULL for none)
  p_expected_revision  UUID,   -- visit_state_revision from the authorization snapshot
  p_expected_status    TEXT,   -- status from the snapshot
  p_reason             TEXT,   -- required, non-blank
  p_requested_counter  TEXT DEFAULT NULL  -- consistency check; written only under the B2 rule
) RETURNS public.patients
```

Argument names for the session match `presenceService.claimsArguments`, so Node passes the same four values it already sends to `validate_staff_auth_session`.

### Errors

| Outcome | SQLSTATE | Node status | Same as today's Node? |
|---|---|---|---|
| Missing/invalid argument, missing reason, unknown requested doctor | `22023` | 400 | yes |
| Account/session mismatch, revoked or expired session, doctor not assigned, doctor acting on another doctor's visit | `42501` | 403 | yes |
| Patient not found | `P0002` | 404 | yes |
| Snapshot status or revision changed | `40001` | 409 | yes |
| Completed visit | `QM001` | 400 | yes (D4) |
| No-show visit — undo first | `QM002` | 409 | yes |
| Requested doctor contradicts the stored owner | `QM003` | 409 | yes |
| Invariant failure, everything rolled back | `QM500` | 503 | new |
| `40P01` deadlock, `55P03` lock timeout, `57014` statement timeout, `53xxx`, `08xxx` | — | 503 retryable, nothing committed | new |
| `PGRST202`, `PGRST204`, `42883` function missing | — | 503 "database migration required" (fail closed, D2) | new |
| Transport error / no response | — | 503 "outcome unknown — refresh"; a retry re-reads the snapshot and is idempotent | new |
| Any other code | — | 503 | — |

`QM` is an otherwise unused SQLSTATE class. `PT…` codes are avoided because PostgREST interprets them as HTTP statuses.

### Success detection (Node)

A call is a success **only** when a row is returned with `id = p_patient_id` and `status = 'cancelled'`, and either:

* the revision changed and `p_expected_status` was `waiting` or `serving` → newly cancelled; or
* the revision is unchanged and `p_expected_status` was `cancelled` → idempotent repeat (`already_cancelled: true`; acceptance state and recall count untouched, as today).

Anything else is 503 "could not confirm the cancellation". No error code is ever treated as success.

## 3. Lock order

`users` (`FOR SHARE`) → `staff_auth_sessions` (`FOR SHARE`) → all `counters` ascending by `id` (`FOR UPDATE`) → the patient (`FOR UPDATE`).

* Start/Complete lock one counter then the patient; Undo locks all counters ascending then the patient; Requeue locks only the patient. None can form a cycle with this order.
* Heartbeat (users `FOR SHARE` → session `FOR UPDATE`), session revoke (session only) and account update/delete (users, then sessions via trigger) wait or are waited on, but never hold a lock this function needs while waiting on one it holds.
* Known exposure, shared with Phase 2.2 Undo: `clearTodaysQueues` releases counters with one multi-row `UPDATE` in storage order, which can deadlock with an id-ordered locker. PostgreSQL aborts one side with `40P01`; Node maps it to 503 (not cancelled). Out of scope here.

## 4. Draft SQL (review only)

```sql
-- DRAFT. NOT A MIGRATION. DO NOT RUN.
-- Requires: base schema, Phase 2, Phase A, Phase 2.1, Phase B and Phase 2.2 installed and verified.
BEGIN;

-- Internal. Mirrors queueService.resolveDoctorCounter: trimmed, case-insensitive id_num,
-- numeric counter id, or "N"/"doctor N" alias (leading zeros ignored). Deterministic:
-- the lowest matching counter id wins, as in get_staff_doctor_presence.
-- Whitespace set approximates JavaScript String.trim() (Unicode spaces are not covered).
CREATE OR REPLACE FUNCTION public.qms_resolve_doctor_counter(p_value TEXT)
RETURNS BIGINT
LANGUAGE sql STABLE
SET search_path = ''
AS $function$
  WITH input AS (
    SELECT pg_catalog.lower(pg_catalog.btrim(p_value, E' \t\n\r\f\x0B')) AS raw
  ), parsed AS (
    SELECT i.raw,
      CASE WHEN i.raw ~ '^(doctor[[:space:]]*)?[0-9]+$'
        THEN 'doctor ' || (pg_catalog.regexp_replace(i.raw, '^doctor[[:space:]]*', '')::NUMERIC)::TEXT
      END AS doctor_alias
    FROM input AS i
    WHERE i.raw <> ''
  )
  SELECT c.id
  FROM public.counters AS c CROSS JOIN parsed AS a
  WHERE pg_catalog.lower(pg_catalog.btrim(c.id_num, E' \t\n\r\f\x0B')) = a.raw
     OR c.id::TEXT = a.raw
     OR pg_catalog.lower(c.id_num) = a.doctor_alias
  ORDER BY c.id
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.cancel_patient_visit(
  p_patient_id BIGINT,
  p_session_id UUID,
  p_user_id_num TEXT,
  p_role TEXT,
  p_doctor_name TEXT,
  p_expected_revision UUID,
  p_expected_status TEXT,
  p_reason TEXT,
  p_requested_counter TEXT DEFAULT NULL
)
RETURNS public.patients
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_ws CONSTANT TEXT := E' \t\n\r\f\x0B';
  v_user public.users%ROWTYPE;
  v_session public.staff_auth_sessions%ROWTYPE;
  v_patient public.patients%ROWTYPE;
  v_actor_kind TEXT;
  v_actor_counter BIGINT;   -- counters.id of a doctor account's assignment
  v_owner BIGINT;           -- counters.id that owns the visit (NULL = no owner)
  v_requested BIGINT;       -- counters.id of the client-supplied doctor, if any
  v_stamp TEXT;             -- id_num written to a blank counter_id (B2 rule only)
  v_reason TEXT;
  v_locked_pointers INTEGER;
  v_released INTEGER;
  v_updated INTEGER;
BEGIN
  -- 0. Arguments.
  IF p_patient_id IS NULL OR p_patient_id <= 0 OR p_session_id IS NULL
     OR p_user_id_num IS NULL OR pg_catalog.btrim(p_user_id_num, v_ws) = ''
     OR p_role IS NULL OR p_expected_revision IS NULL OR p_expected_status IS NULL THEN
    RAISE EXCEPTION 'A patient, authenticated session and visit snapshot are required' USING ERRCODE = '22023';
  END IF;
  v_reason := NULLIF(pg_catalog.btrim(p_reason, v_ws), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Reason for cancel is required' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_reason) > 1000 THEN  -- limit pending decision D6
    RAISE EXCEPTION 'Reason for cancel is too long' USING ERRCODE = '22023';
  END IF;

  -- 1. Persisted account and session (same checks as validate_staff_auth_session).
  SELECT u.* INTO v_user FROM public.users AS u WHERE u.id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_user.role::TEXT NOT IN ('admin', 'superadmin')
     OR v_user.role::TEXT IS DISTINCT FROM p_role
     OR NULLIF(v_user.doctor_name, '') IS DISTINCT FROM NULLIF(p_doctor_name, '') THEN
    RAISE EXCEPTION 'Your account no longer matches your session. Sign in again.' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_session FROM public.staff_auth_sessions AS s
    WHERE s.session_id = p_session_id AND s.user_id_num = p_user_id_num FOR SHARE;
  IF NOT FOUND OR v_session.role IS DISTINCT FROM p_role
     OR v_session.doctor_name IS DISTINCT FROM NULLIF(p_doctor_name, '')
     OR v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'Authentication session expired or revoked; sign in again' USING ERRCODE = '42501';
  END IF;

  -- 2. Lock every counter ascending (same order as Phase 2.2 Undo).
  PERFORM c.id FROM public.counters AS c ORDER BY c.id FOR UPDATE;

  -- 3. Actor kind, resolved against the locked counters (mirrors resolveCancelActor).
  IF v_user.role::TEXT = 'superadmin' THEN
    v_actor_kind := 'superadmin';
  ELSIF pg_catalog.lower(pg_catalog.btrim(COALESCE(v_user.doctor_name, ''), v_ws))
        IN ('', 'front desk', 'frontdesk') THEN
    v_actor_kind := 'frontdesk';
  ELSE
    v_actor_kind := 'doctor';
    v_actor_counter := public.qms_resolve_doctor_counter(v_user.doctor_name);
    IF v_actor_counter IS NULL THEN
      RAISE EXCEPTION 'Your current account is not assigned to this doctor. Sign in again.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Patient (identified only after the caller, as in authorizeVisitAction).
  SELECT p.* INTO v_patient FROM public.patients AS p WHERE p.id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient not found' USING ERRCODE = 'P0002';
  END IF;

  -- 5. Owner from persisted data only (mirrors resolveCancelOwner).
  IF pg_catalog.btrim(COALESCE(v_patient.counter_id, ''), v_ws) <> '' THEN
    v_owner := public.qms_resolve_doctor_counter(v_patient.counter_id);
  ELSIF v_patient.status::TEXT <> 'serving' THEN
    -- Must stay identical to getDoctorForService() (parity test required).
    v_owner := public.qms_resolve_doctor_counter(CASE
      WHEN v_patient.service_type IN ('consultation', 'checkup') THEN 'Doctor 1'
      WHEN v_patient.service_type IN ('prenatal', 'maternity') THEN 'Doctor 2'
      WHEN v_patient.service_type = 'family_planning' THEN 'Doctor 3'
      ELSE 'Doctor 1' END);
  END IF;
  IF v_actor_kind = 'doctor' AND (v_owner IS NULL OR v_owner <> v_actor_counter) THEN
    RAISE EXCEPTION 'You can only cancel patients assigned to your doctor.' USING ERRCODE = '42501';
  END IF;

  -- 6. Client-supplied doctor: consistency check against the stored owner.
  IF pg_catalog.btrim(COALESCE(p_requested_counter, ''), v_ws) <> '' THEN
    v_requested := public.qms_resolve_doctor_counter(p_requested_counter);
    IF v_requested IS NULL THEN
      RAISE EXCEPTION 'The requested doctor is not a valid counter' USING ERRCODE = '22023';
    END IF;
    IF v_owner IS NOT NULL AND v_requested <> v_owner THEN
      RAISE EXCEPTION 'The requested doctor does not match this patient''s assigned doctor' USING ERRCODE = 'QM003';
    END IF;
  END IF;

  -- 7. Snapshot (Phase 2.1 revision protection).
  IF v_patient.visit_state_revision IS DISTINCT FROM p_expected_revision
     OR v_patient.status::TEXT IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Patient visit changed; refresh before retrying cancellation' USING ERRCODE = '40001';
  END IF;

  -- 8. Terminal states.
  IF v_patient.status::TEXT = 'completed' THEN
    RAISE EXCEPTION 'A completed consultation cannot be cancelled' USING ERRCODE = 'QM001';
  ELSIF v_patient.status::TEXT = 'no-show' THEN
    RAISE EXCEPTION 'This patient was marked no-show. Undo the no-show before cancelling.' USING ERRCODE = 'QM002';
  ELSIF v_patient.status::TEXT = 'cancelled' THEN
    -- Idempotent repeat: the patient row is not written, so its revision is unchanged.
    -- A stale pointer to this terminal visit is released in the same transaction.
    SELECT pg_catalog.count(*) INTO v_locked_pointers
      FROM public.counters AS c WHERE c.current_patient_id = p_patient_id;
    UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
    GET DIAGNOSTICS v_released = ROW_COUNT;
    IF v_released <> v_locked_pointers
       OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
      RAISE EXCEPTION 'Unable to release the cancelled patient''s counter' USING ERRCODE = 'QM500';
    END IF;
    RETURN v_patient;
  ELSIF v_patient.status::TEXT NOT IN ('waiting', 'serving') THEN
    RAISE EXCEPTION 'Unsupported visit status' USING ERRCODE = 'QM500';
  END IF;

  -- 9. Attribution (B2): only a blank counter_id, only to the validated owner.
  IF pg_catalog.btrim(COALESCE(v_patient.counter_id, ''), v_ws) = ''
     AND v_owner IS NOT NULL AND v_requested = v_owner THEN
    SELECT c.id_num INTO v_stamp FROM public.counters AS c WHERE c.id = v_owner;
  END IF;

  -- 10. Cancel once and release exactly the matching counter(s), atomically.
  -- consultation_started_at, called_at and created_at are never modified.
  SELECT pg_catalog.count(*) INTO v_locked_pointers
    FROM public.counters AS c WHERE c.current_patient_id = p_patient_id;
  UPDATE public.patients AS p
    SET status = 'cancelled', completed_at = pg_catalog.clock_timestamp(), reason = v_reason,
        counter_id = COALESCE(v_stamp, p.counter_id)
    WHERE p.id = p_patient_id
    RETURNING p.* INTO v_patient;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  UPDATE public.counters AS c SET current_patient_id = NULL WHERE c.current_patient_id = p_patient_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  IF v_updated <> 1 OR v_released <> v_locked_pointers
     OR v_patient.status::TEXT IS DISTINCT FROM 'cancelled'
     OR v_patient.visit_state_revision IS NOT DISTINCT FROM p_expected_revision
     OR EXISTS (SELECT 1 FROM public.counters AS c WHERE c.current_patient_id = p_patient_id) THEN
    RAISE EXCEPTION 'Unable to cancel the visit and release its counter' USING ERRCODE = 'QM500';
  END IF;
  RETURN v_patient;
END;
$function$;

ALTER FUNCTION public.qms_resolve_doctor_counter(TEXT) OWNER TO postgres;
ALTER FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;

-- The helper is internal: no API role may call it (Supabase default privileges grant all three).
REVOKE ALL ON FUNCTION public.qms_resolve_doctor_counter(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
```

### Notes on the draft

* Node's `resolveDoctorCounter` returns the first match in PostgREST's unordered result. The helper's lowest-`id` rule equals it whenever counters are returned in `id` order, which is the normal case; a later Node change to `.order("id")` would make them identical. Not changed here (R2 source is out of scope).
* Start/Complete (`20261010…sql`), presence and the Phase B records function keep their own resolvers. Unifying them on the helper is a separate change.
* `completed_at` comes from the database clock (as in `complete_patient_consultation`), not the Node clock as in today's two-step path.
* The helper's whitespace set covers ASCII whitespace; JavaScript `trim()` also strips Unicode spaces. Parity tests must state this boundary.
* The service-to-doctor `CASE` duplicates `getDoctorForService`. Both ignore `counters.service_types`. A mapping table would remove the drift but is a schema change (D5).

## 5. Node integration (after approval only — not implemented)

* Keep `authorizeVisitAction` as the first check so messages stay as today; the RPC is authoritative.
* Call `cancel_patient_visit` with `req.user.jti`, `id_num`, `role`, `doctor_name || null` (the values `claimsArguments` already builds), the snapshot's `visit_state_revision` and `status`, the trimmed reason and the optional requested doctor.
* Map errors per §2. Apply the success-detection rule in §2. Call `clearRecallCount` and `clearAwaitingAccept` only for a newly cancelled visit.
* If `visit_state_revision` is missing from the snapshot, return 503 "Phase 2.1 database migration is required", as Requeue/Undo do.
* Development memory mode (`useLocalFallback`) keeps its current in-process path.

## 6. Installation, verification and rollback (for the separate approval)

**Order**

1. Identify a disposable database (local PostgreSQL or a throwaway project/branch) first; the shared development project only after §7 and §8 pass. Confirm backup/PITR. Never run the original schema/seed SQL.
2. Run the existing A.1, B.1 and 2.2 preflights and the Phase 2 / 2.1 / 2.2 / A / B verify scripts; all must pass.
3. New read-only preflight:
   * dependency signatures exist (`validate_staff_auth_session`, `recover_patient_visit`, `undo_patient_visit_waiting`, Start/Complete) and no overload of `cancel_patient_visit` or `qms_resolve_doctor_counter` exists;
   * columns and types: `patients.reason`, `visit_state_revision` (uuid, not null), `counter_id`, `consultation_started_at`; `counters.current_patient_id` with its foreign key; `staff_auth_sessions` columns;
   * `queue_status` labels (the repository enum lacks `'no-show'`; record what is live);
   * the revision trigger is the only user trigger on `patients` and `counters`;
   * RLS enabled on `patients`, `counters`, `users`, `staff_auth_sessions`; FORCE RLS off; the `postgres` role owns those tables or has BYPASSRLS.
4. Install in one transaction (§4).
5. Verify: signature and return type; `prosecdef`; `proconfig` contains `search_path=""` and `lock_timeout=5s`; owner `postgres`; source md5 pinned (as `20261015-phase22-verify.sql` does); `has_function_privilege` false for `anon`, `authenticated` and `PUBLIC` on both functions, true for `service_role` on `cancel_patient_visit` only.
6. Deploy the Node change last.

**Rollback** (no data change): redeploy the previous Node build **first**, then
`DROP FUNCTION public.cancel_patient_visit(BIGINT, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT); DROP FUNCTION public.qms_resolve_doctor_counter(TEXT);`
Dropping before the Node rollback would make every Cancel fail closed with 503.

**Safeguards:** synthetic, clearly labelled test patients only; row snapshots of those patients and all counters before and after each run; the reviewed SQL file is the single source for the pinned md5.

## 7. Isolated PostgreSQL tests (PGlite harness and real PostgreSQL)

* Actors: superadmin; Frontdesk with NULL, blank, `"Front Desk"`, `"frontdesk"`; doctor on own / other doctor's visit; unresolvable assignment; unknown user; role or doctor claim different from the account; session revoked, expired, belonging to another user, or with different stored claims.
* Resolver parity with Node for `"Doctor 1"`, `"doctor 1"`, `"Doctor1"`, `"doctor 01"`, `"1"`, numeric ids not aligned with names, colliding aliases, padded and tab-padded values, unknown values, NULL.
* Owner mapping parity with `getDoctorForService` for every service type and an unknown one.
* Visits: waiting and serving cancelled; stale revision; stale status; completed (`QM001`); no-show (`QM002`); requested doctor invalid (`22023`) and contradicting (`QM003`); orphan serving visit with a requested doctor is **not** stamped (B2); blank `counter_id` stamped only with the owner; missing and over-long reason.
* Idempotent repeat: no patient write, revision unchanged, a stale pointer released, two pointers to the same patient (W2) both released.
* Atomicity: a test trigger on `counters` that raises, and one that suppresses the release → `QM500`, patient status, revision, `reason` and `completed_at` unchanged.
* History: `called_at`, `consultation_started_at`, `created_at` unchanged on every path.
* Security: `anon`/`authenticated` cannot execute either function; `service_role` cannot execute the helper; a caller-created `public`-schema object shadowing a function name has no effect.

## 8. Independent-connection concurrency tests (two or more `pg` connections, disposable database)

Hold locks with explicit `BEGIN`, confirm waits in `pg_stat_activity` (`wait_event_type = 'Lock'`), then release.

1. Cancel vs Complete, Cancel vs Start — both orders; the loser fails cleanly, no deadlock.
2. Two Cancels with the same snapshot — exactly one cancels; the other gets `40001`; its retry with a fresh snapshot is an idempotent repeat.
3. Cancel P1 (Doctor 1) and Cancel P2 (Doctor 2) together — serialized, both succeed.
4. Cancel vs Undo, Cancel vs Requeue, repeat Cancel vs Undo of the same cancelled visit.
5. Cancel vs the two-step Call at every interleaving, including terminating Call's backend between its counter claim and its patient update; record whether a stale pointer remains (known gap C1) and that a repeat Cancel releases it.
6. Cancel vs the `clearTodaysQueues` multi-row counter release; any `40P01` is reported as not cancelled.
7. Cancel vs account update/delete, session revoke and heartbeat.
8. A connection holding a counter lock beyond 5 s → `55P03`, patient unchanged.
9. Terminate the Cancel backend after its patient `UPDATE`, before commit → nothing persists.
10. Soak: randomized Cancel / Undo / Complete / Call for 500+ iterations; zero `40P01` among the ordered RPCs, and after each iteration no counter points at a terminal visit (except the documented C1 window).

## 9. Not covered by this function (separate approvals)

* **C1 — Call race.** Call claims the counter in its own statement before updating the patient; a Call that loses to a committed Cancel briefly points a counter at a cancelled visit and leaves it there if the process stops before compensating. Needs a Call RPC with this lock order, or a `counters` trigger rejecting pointers to inactive visits (schema change).
* **No-show** has the same two-step defect (`queueService.js:1262-1277`). Recommended next: an internal shared core with a second entry point `mark_patient_no_show`, following the Undo wrapper precedent.
* **Requeue** accepts waiting, serving and completed-without-start on the server although the UI offers it only for cancelled/no-show; on a serving visit it leaves the counter pointer and erases an in-progress consultation start. Needs a status restriction and an all-counters release in a new versioned entry point (the current function is md5-pinned).
* **`clearTodaysQueues`** remains two-step and unordered.
* Recall (single-row compare-and-set) and Re-Call (no database write) need no RPC.

## 10. Decisions needed

Project owner:

* **D1** Approve installing on a disposable database, then on the identified development project.
* **D2** Fail closed (503) when the function is missing — recommended — or keep the two-step path during rollout.
* **D3** Validate the session inside the RPC (B4) — recommended — or accept the window between middleware validation and the RPC.
* **D4** Completed visit status code: keep 400 (drafted) or change to 409.
* **D5** Keep the service-to-doctor mapping in SQL with a parity test, or introduce a mapping table.
* **D6** Maximum cancellation reason length (drafted as 1000 characters) or none.

Health office:

1. May Frontdesk or Superadmin cancel a visit whose consultation has already started?
2. May doctors cancel waiting, not-yet-called patients routed to their service?
3. Should a never-called visit cancelled by Frontdesk be attributed to a doctor (affects per-doctor figures)?
4. Should every cancellation record which staff account performed it? (Requires a schema change; nothing records it today.)
5. Which statuses may Requeue from, and may legacy completed-without-start visits still be re-queued?
