# Phase B.2 — Records compatibility: installation package

Status: **prepared and verified in isolated PGlite databases only. Not installed anywhere.** No SQL in this
package has been run against the development or production Supabase project. Installing it needs a separate,
explicit approval. Date: 2026-10-23. Baseline: `main` @ `8222eac` plus the uncommitted working tree.

Background and the approved contract: [phase-b2-records-compatibility-proposal.md](phase-b2-records-compatibility-proposal.md).
The original Phase B files (`20261014-phase-b-records.sql`, `20261014-phase-b-verify.sql`) are kept unchanged as history and
must never be installed.

## 1. Artifacts

| File | Kind | Writes? |
|---|---|---|
| `backend/scripts/20261023-phase-b2-preflight.sql` | Read-only catalog gate, one result set ending in an `overall` row | No (`READ ONLY` transaction) |
| `backend/scripts/20261023-phase-b2-records.sql` | **Installation** (one transaction) | DDL only; no application rows |
| `backend/scripts/20261023-phase-b2-verify.sql` | Post-install verification with synthetic fixtures | Everything rolled back |
| `backend/scripts/20261023-phase-b2-rollback.sql` | Rollback (one transaction, repeatable) | DDL only; keeps activity rows |
| `backend/scripts/20261023-no-show-enum.sql` | **Separate dependency**, not part of B.2 | Adds one enum value |
| `backend/scripts/20261023-no-show-enum-verify.sql` | Verification for the enum change | Rolled back |

## 2. What B.2 installs

* `public.staff_auth_activity` (login / explicit-logout events) with two indexes, RLS enabled, no policies.
* `public.record_staff_login()` and the `staff_login_activity` AFTER INSERT trigger on `staff_auth_sessions`.
* A new body for `public.revoke_staff_auth_session(uuid, text)`: Phase A's UPDATE unchanged, plus one `logout` row when it
  actually revoked a session. Same signature, result (`true`), owner binding and idempotency.
* `public.get_central_records(text, jsonb, integer, integer)`: same signature and `{ rows, total, page, limit, observed_at }`
  contract as Phase B, rewritten for the installed schema.

It writes no patient, user, counter or session row, backfills no activity, adds no patient identity columns and **does not
change grants or RLS on any existing table** (users, patients, counters, staff_auth_sessions). It does not touch the enum,
WPS, consultation, Cancel, Call, Undo or Requeue logic.

### Changes from the reviewed draft (proposal §5)

| Change | Reason |
|---|---|
| Removed `REVOKE ALL ... FROM anon, authenticated` and `ENABLE RLS` on `users` / `patients` | Approved rule: existing role permissions are preserved. The preflight reports the existing broad grants as `WARN` for a separate hardening decision (§5). |
| Dependency gate (`DO $gate$`) raising `55000` | PL/pgSQL bodies are not checked when created; this is how the original Phase B installed cleanly and then failed on every call. |
| Activity writes wrapped in an exception block | Explicit storage-failure policy (§4). |
| Unknown filter keys, non-string values and values over 100 characters raise `22023` | Defined validation error instead of silently ignored input. |
| `service_role` gets `SELECT` only on the activity table (draft: `SELECT, INSERT` + sequence use); sequence revoked from all API roles | Only the definer functions write activity, so the backend cannot fabricate events. Supabase default privileges otherwise grant new tables/sequences to `anon` / `authenticated`. |
| One `v_now` per call; presence uses `>=` 75 s | Consistent timestamps within a response; identical to `get_staff_doctor_presence`. |
| Function marked `STABLE`; `SET LOCAL lock_timeout = '5s'` | Read-only read model; the trigger DDL never queues logins behind a long transaction. |
| Login event uses the session's own `created_at` | Activity and the Last-login column agree exactly. |

## 3. Database assumptions (development project)

From the 2026-10-23 read-only probe and the 2026-10-16 catalog export; re-confirmed by the preflight at install time.

* Installed: Phase 2, Phase A, Phase 2.1, Phase 2.2. Not installed: Phase B, B.2, F5, Phase 2.5 cancel RPC.
* `patients` has no `first_name` / `last_name`; names are stored in `patients.id_num` and shown exactly as stored.
* `users` has no `created_at`; `id_num` is the key. Account creation is shown as "Not recorded".
* `queue_status` = `waiting, serving, completed, cancelled` (no `no-show`).
* `users` / `patients` / `counters` have RLS enabled, not forced, no policies; browser roles hold broad grants.
* The backend uses the `service_role` key; browsers never query Supabase directly.
* Functions are installed by `postgres`, which owns the tables (the preflight checks ownership and FORCE RLS).

**Dependencies of B.2:** Phase 2 (`patients.consultation_started_at`) and Phase A (sessions and its four functions).
Phase 2.1 / 2.2 are installed but not required. `no-show` is **not** required.

## 4. Authentication compatibility and activity-storage policy

* **Existing JWTs keep working.** B.2 does not touch `create/validate/heartbeat_staff_auth_session`, the account-change
  trigger or the JWT format. A session issued before installation validates, heartbeats and logs out afterwards (tested).
* **Logout** is still idempotent and owner-bound; a repeated logout returns `true` and records nothing more; another
  account's session ID revokes and records nothing. A logged-out session no longer validates (401).
* **Account changes** (password, role, doctor link, id) and `revoke_staff_user_sessions` still revoke sessions and are
  **not** recorded as logouts. Expiry and heartbeat timeouts are not logouts either.
* **Login failures are unchanged:** a stale credential revision is refused with the same 401 message and leaves no session
  and no activity; a missing revision is the same 503.
* **Activity-storage failure policy.** `staff_auth_sessions` stays the authoritative record of a sign-in (`created_at`)
  and of a revocation (`revoked_at`); activity is a secondary audit view of it. Therefore a failure to write activity
  **never blocks sign-in** (Phase A login behaviour is unchanged) and **never keeps a session alive** after logout (revocation
  always commits). The failure is raised as a server-side `WARNING` naming only the SQLSTATE. Rationale: failing logout on an
  audit error would leave a live token, which is the worse security outcome; anyone able to break the activity table already
  has owner-level database access. Tested by forcing every activity insert to fail.
* **Order hazard:** re-running the Phase A migration after B.2 restores Phase A's logout body and silently stops logout
  recording. The verify script fails with "Phase A body" in that case; re-run the B.2 file to restore it.

## 5. Security and permission review

* All three B.2 functions are `SECURITY DEFINER` with `SET search_path = ''`. `pg_catalog` is always searched first, built-ins
  are qualified, every relation is schema-qualified, and `pg_temp` is never searched for functions or operators.
* The only dynamic SQL is the sequence `REVOKE`, whose name comes from `pg_get_serial_sequence` and is quoted by `regclass`
  output via `format('%s', ...)`. No filter value ever reaches dynamic SQL; search uses `strpos`, so `%` and `_` are literal.
* Execute: `get_central_records` and `revoke_staff_auth_session` → `service_role` only; `record_staff_login` → nobody.
  Activity table: `service_role` `SELECT` only; no API role may use its sequence.
* Output whitelist: no contact, PhilHealth, birth date, residency, sex, vulnerability, reason, source, revision, password or
  `auth_revision` data. Search does not match private identifiers.
* Records API: real JWT signature + persisted session validation + `superadmin` role, before any database call.
* **Existing WARN (unchanged by B.2, needs its own decision):** `anon` / `authenticated` hold broad grants on `users`,
  `patients`, `counters` including `TRUNCATE`. RLS (enabled, no policies) default-denies row access but not `TRUNCATE`.
  The preflight reports these rows as `WARN`.

## 6. No-show: separate dependency, and the N1 prerequisite

B.2 accepts `status = no-show` and compares status as text, so the filter returns **zero rows without error** while the enum
value is absent, and starts matching automatically once it exists. B.2 neither requires nor activates the No-show workflow.

`20261023-no-show-enum.sql` (`ALTER TYPE public.queue_status ADD VALUE IF NOT EXISTS 'no-show' AFTER 'cancelled'`) is prepared
separately. Installing it **does activate No-show operationally**, because the endpoint and buttons are already deployed
and today fail only because PostgreSQL rejects the value. It is irreversible in place (an enum value cannot be dropped;
rollback means leaving it unused) and must run on its own, outside any transaction that uses the value.

**Prerequisite — race N1 (not fixed here):** No-show is two statements: a conditional patient update, then
`counters.current_patient_id = NULL` by patient id. If Undo and Call for the same visit commit between them, the delayed
second statement releases the *new* legitimate assignment and leaves a serving visit without its counter. Reproduced by
`backend/test/phase25-cancel-rpc-concurrency.test.js`, scenario "N1". Fix N1 (one transactional No-show RPC that releases
only a pointer still matching the no-show revision), or record an explicit risk acceptance, before approving the enum change.

## 7. Backend and frontend changes (in the working tree, not deployed)

* `backend/src/routes/records.js`: real calendar dates; `status` / `role` / `position` / `presence` / `visit` validated with
  the same lists as SQL (400 before any RPC). RPC `22023`/`22007`/`22008` → 400 "Invalid records filter";
  `PGRST202`/`PGRST205`/`42883`/`42P01`/`42703` → 503 "…missing or incompatible; install Phase B.2"; anything else or a
  transport failure → 503 "…Please retry."; a malformed result → 503. Logs `[records] GET /api/records/<category> failed: <code>`
  only; database text never reaches the log or the browser. Successful responses unchanged (`no-store`).
* `backend/src/services/queueService.js` `getUsers`: selects `id_num, role, doctor_name`, orders by `id_num`; no longer
  selects the missing `users.created_at` (which made the Superadmin user list fail) or invents one in local fallback.
* `frontend/lib/recordsFilters.js`: position value `Frontdesk` (label "Front desk") instead of `Admin`. Layout unchanged.
* `frontend/pages/records.js`: missing creation date → "Not recorded"; patient doctor shows "(by service)" when routed by
  service, "(no matching counter)" when a stored assignment is unresolved. `frontend/pages/index.js`: user list "Created"
  shows "Not recorded".

The backend changes work with or without B.2 installed (without it Records stays a 503 with a clearer message).

## 8. Tests

`backend/test/phase-b2-records-postgres.test.js` (28 tests, optional PGlite 0.3.15, synthetic data only) with
`backend/test/helpers/liveKnownSchema.js`, a model of the known development schema including Supabase-style default
privileges. Covers: original Phase B failing (42703) and its verify script; dependency gate; contract of all four categories;
names as stored; positions; assigned vs service-routed vs unresolved doctors and aliases; search/filters/Manila dates;
pagination and numeric tie-breaks; 29 invalid inputs → 22023; the API through the real auth middleware, presence service and
route (401/403/200, 400 mapping, safe logs); Phase A login/logout/revocation compatibility including a pre-install session;
the activity-failure policy; No-show before and after the enum; data exposure, grants, `SET ROLE` denial and definer settings;
unchanged existing grants/RLS; idempotent install (also over the original Phase B); repeated preflight, verify and rollback;
exact Phase A restoration; the enum change in isolation.

`backend/test/records-routes.test.js` (+5 tests) and `frontend/test/records-filters.test.cjs` (+1 test, 2 updated).

Run the SQL suite as in `docs/phase2-consultation.md`:

```powershell
$env:PHASE2_PGLITE_MODULE = Join-Path $env:TEMP 'city-health-phase2-pg-tests/node_modules/@electric-sql/pglite'
node --test backend/test/phase-b2-records-postgres.test.js
Remove-Item Env:PHASE2_PGLITE_MODULE
```

**Real PostgreSQL rehearsal (2026-10-23, disposable, synthetic data, 3 full runs; runs 2 and 3: 126/126 checks).**
Disposable loopback PostgreSQL 17.11 cluster (development reports 17.6) with Supabase-like roles taken from the 2026-10-14 catalog
export (`postgres` non-superuser + BYPASSRLS as installer and owner; `service_role` BYPASSRLS; `anon` / `authenticated` with the
same broad table grants), a baseline matching that export column-for-column plus Phase 2 / A / 2.1 / 2.2, PostgREST 14.18, and
the real backend (`src/index.js`, `.env` reading blocked) going through supabase-js. Covered: preflight → install → preflight →
verify → all Records categories through the HTTP API → rollback → Phase A after rollback → reinstall, plus lock_timeout, a login
racing the install, idempotent re-installs, browser-role reachability through PostgREST, the definer context, a hostile
`search_path` with planted functions and temp tables, and activity-failure warnings in the PostgreSQL log. Run 1 hit one
PostgREST startup issue (see §9 step 5); B.2 itself behaved identically in all runs.

**PGlite limitations** — not proven by the PGlite suite (the real-PostgreSQL rehearsal above covers most of them): a single connection (no lock waits, `lock_timeout`, or logins racing the
trigger DDL); the installer is a superuser (Supabase's `postgres` is not, so ownership/`BYPASSRLS` outcomes may differ); no
PostgREST (`NOTIFY pgrst`, `PGRST*` codes, named-argument RPC calls through supabase-js); `service_role` lacks Supabase's
`BYPASSRLS`; the schema is a model, not an export. **Recommended before development installation:** run the preflight,
installation, verify and rollback scripts on a disposable real PostgreSQL 15+ with Supabase roles — a Supabase branch or
`supabase start` locally — including one login/logout through the real backend and a concurrent login during installation.

## 9. Proposed installation order (each step needs approval)

1. Approve this package. Optionally run the isolated real-PostgreSQL rehearsal (§8).
2. Deploy the backend/frontend changes (§7). They are safe before B.2.
3. On the identified **development** project, SQL Editor, as `postgres`: run `20261023-phase-b2-preflight.sql`. Proceed only
   if the `overall` row is `PASS`; keep the output.
4. In a quiet period, run `20261023-phase-b2-records.sql` once. On a lock timeout nothing is installed; retry later.
5. Re-run the preflight: expect "Phase B.2 installed" and "records explicit logout". Then confirm the API sees the new function:
   as Superadmin, Records → Patients must load (not 503 "missing or incompatible"). The file's `NOTIFY pgrst, 'reload schema'`
   reloaded PostgREST within milliseconds in every rehearsal where PostgREST was already running; it was missed only when PostgREST
   was itself starting (a `PGRST002` retry). If Records still says "missing or incompatible" after ~10 s, run
   `NOTIFY pgrst, 'reload schema';` once more. The same check applies after a rollback (Records must then return 503).
6. Run `20261023-phase-b2-verify.sql`: expect the single row "Phase B.2 verification passed". Any error means a failed
   check; nothing is kept.
7. Smoke test as Superadmin: each Records tab loads; filters work; sign in/out as a doctor and see two activity rows.
8. Later and independently: fix N1 → approve and run `20261023-no-show-enum.sql` → `20261023-no-show-enum-verify.sql`.
9. No production deployment is planned (Capstone 2 prototype for controlled on-site evaluation). Any future production install
   needs its own approval and repeats steps 3–7.

### 9a. Development pre-installation checklist

Tick every item before step 4. Development project: **`uvmpbgpvmjkfoblrfrdt` ("CCHOFPC Queuing System")**.

| # | Check | How |
|---|---|---|
| 1 | Correct project | The SQL Editor URL is `supabase.com/dashboard/project/uvmpbgpvmjkfoblrfrdt/sql`; `backend/.env` `SUPABASE_URL` host is `uvmpbgpvmjkfoblrfrdt.supabase.co` (verified 2026-10-23 without printing values). |
| 2 | Not production | No production project exists for this prototype; do not run the files in any other project. |
| 3 | Read-only preflight run | Paste `20261023-phase-b2-preflight.sql` whole, run, export the result (CSV) and keep it. |
| 4 | Overall PASS | Last row `overall` = `PASS`, no `FAIL` rows. Expected (from 2026-10-14 catalog + 2026-10-23 API metadata): ~40 rows; 6 `WARN` rows for browser grants on `counters` / `patients` / `users`; `INFO` absent `first_name`/`last_name`, `users.created_at`, `no-show`, `get_central_records`, `staff_auth_activity`, trigger; logout body "Phase A". Any difference: stop and review. |
| 5 | Install script reviewed | `20261023-phase-b2-records.sql`: one transaction, 5 s lock timeout, writes no rows, changes no existing grant. |
| 6 | Rollback script reviewed | `20261023-phase-b2-rollback.sql` restores the Phase A logout body; keeps activity rows. |
| 7 | Recovery ready | B.2 writes no application data, so recovery = the rollback script. Check Dashboard → Database → Backups for the latest backup anyway and note its time. |
| 8 | Backend/API up | `http://localhost:4000/api/health` → 200; frontend `NEXT_PUBLIC_API_BASE_URL` = `http://localhost:4000/api`. Restart the backend once before or after install so the query-redacting request logger is active. |
| 9 | Demo accounts unaffected | B.2 writes no `users` row and revokes no session; demo logins (e.g. `admin1`–`admin3`) keep working. |
| 10 | Schema reload | After install, Records → Patients loads; if "missing or incompatible" persists ~10 s, `NOTIFY pgrst, 'reload schema';` once more. |
| 11 | Records smoke test | Sign in as Superadmin → Records: Patients, Staff, User Accounts load; apply a search, date, doctor and status filter; open one stored ticket; sign a doctor account in and out, then open that account's activity (expect `login`, `logout`). |
| 12 | Verify output | `20261023-phase-b2-verify.sql` returns exactly one row: "Phase B.2 verification passed; all synthetic fixtures are rolled back". It consumes ~3 patient ids and 1 counter id (sequence gaps only). |
| 13 | Known unrelated test failures | `phase22-install-verification` (stale git-ignored bundle) and one voice-launcher timing test (§11). Not caused by B.2. |

## 10. Rollback

1. Run `20261023-phase-b2-rollback.sql` (repeatable). It drops the trigger, `record_staff_login` and `get_central_records`, and
   restores Phase A's `revoke_staff_auth_session` body byte-for-byte (tested against a fresh Phase A install).
2. Records then answers 503 (fails closed); sign-in, sessions, heartbeats and logout work exactly as in Phase A. The new
   backend can stay deployed; redeploying the previous backend is optional.
3. `staff_auth_activity` and its rows are kept. Dropping them needs separate approval (`DROP TABLE public.staff_auth_activity;`).
4. No patient, user, counter or session data needs restoring: B.2 writes none.

## 11. Remaining blockers and open items

* Separate explicit approval to install (development first).
* Real-PostgreSQL rehearsal: done (§8). Not reproduced locally: hosted Supabase's exact PostgREST version, its pooler, and its own
  event triggers; the post-install API check in §9 step 5 covers the schema-cache reload.
* Request logging: `backend/src/index.js` wrote full URLs, so Records searches (patient names) and geocode addresses reached backend
  stdout. Corrected in the working tree (`src/lib/requestLog.js`: query values become `[redacted]`, names and paths stay; tested in
  `test/request-log-redaction.test.js`); active after the next backend restart. B.2's own error logging writes codes only.
* Still logged elsewhere (not changed): the frontend's `console.log("Frontend request to: …")` in `frontend/lib/api.js` shows full
  URLs in the browser console; the SMS sender logs GatewayAPI's raw error body, which may echo the recipient number.
* No-show stays inactive until N1 is fixed or accepted, then the enum change is approved.
* Existing broad browser grants (`WARN`) need their own hardening decision.
* If a counter named in the doctor dropdown (Doctor 1–3) is missing, that filter returns 400 rather than an empty page.
* `get_central_records` scans `patients` per request; fine at clinic scale, revisit with indexes if volume grows.
* Desktop/mobile visual QA of the Records page with real stored data has not been done.
* Two existing backend tests fail in this working tree independently of B.2; they touch none of the files above.
  `phase22-install-verification` prefers the git-ignored local artifact
  `output/phase22-development-verification/phase21-phase22-development-install.sql` (built 2026-10-16), which embeds the Phase 2.1
  migration as of `5710f25`; commit `979281b` (2026-10-21) changed that migration, so the artifact is stale. In a clean HEAD checkout
  (no `output/`) all 6 tests pass. The voice-launcher test asserts "absent" immediately after `stop()`, which resolves when the venv
  `python.exe` redirector exits; the real interpreter (a different PID) releases the port a few ms later. It fails only under load.
