# Phase 2 consultation lifecycle and Supabase rollout

Phase 2 adds actual consultation timing to the completed Phase 1 workflow. The official working copy is now the project root; the former `output/repo-sync` checkout has been integrated. Keep Phase 2 work on its own branch based on Phase 1.

## Implementation and verification status

The local Phase 2 implementation is complete on `feat-doctor-consultation-phase2`, based on the Phase 1 merge commit `2b321d2` from `origin/main`. Verification on **11 October 2026** passed 111 backend workflow/startup/listen tests, 57 frontend tests, 25 local PostgreSQL tests, and the frontend production build. The exact staged release snapshot also passed all 136 backend/SQL tests, all 57 frontend tests, and the production build. The build produced a `BUILD_ID` and complete manifests for all 16 page entries; its final trace records completed webpack, static generation and build stages. That snapshot excluded local `.env` files, runtime queue settings and the unrelated local fill-up form change.

The user confirmed that **CCHOFPC Queuing System**, project `uvmpbgpvmjkfoblrfrdt`, is used for development/testing despite its Dashboard `PRODUCTION` branch label. On **11 October 2026**, they applied the versioned Phase 2 migration and provided its read-only installation verification results: **all 15 checks passed, with `all_pass = true`**. The live database now has the required patient columns with the expected types/nullability, both consultation RPCs with their exact named parameter signatures, and execution permissions denied to `anon`/`authenticated` and granted to `service_role`.

The ignored `backend/.env` now contains the confirmed development project's URL and a valid backend server secret. Direct Supabase reads succeed, and the running backend's authenticated `/api/queue` responds with HTTP 200 and `storage_mode: "supabase"`. A connected Supabase plugin or signed-in browser is not required for this API access. Keep the server key in the backend; do not place it in the frontend or in shared screenshots.

The first scoped live verification on **11 October 2026** passed **54 assertions** against the actual development Supabase database. It used the real backend routes in a temporary Express server with isolated acceptance, voice-event and settings storage. Registration created two labelled synthetic patients. At that stage, normal `/queue/call` safely rejected a call because historical `serving` rows occupied the doctors' queues, even though today's queue was empty; the test therefore explicitly prepared a called-state fixture only for its own synthetic patient. That first run did not verify the normal Frontdesk Call flow.

The fixture verified authenticated waiting/unaccepted/unstarted/wrong-doctor/duplicate guards and the live **Accept → Start → Complete** lifecycle. PostgreSQL recorded start `2026-10-11 01:52:26.048632 +08:00`, end `2026-10-11 01:52:26.838634 +08:00`, and derived duration `0.790002` seconds. Completion preserved the exact start and released only Doctor 3. Accept created one existing voice event; Start and Complete created none. Independent parallel requests to the real Start and Complete RPCs each produced one successful transition and one safe rejection, verifying duplicate protection beyond the local single-connection SQL engine.

Cleanup of that first run deleted both synthetic patient records and temporary state. The complete counter snapshot and SHA-256 comparison of all pre-existing patient rows matched their pre-test values; existing backend runtime data was untouched.

The historical serving assignments have since been reviewed and resolved in the confirmed development project. All **21** records were dated **3 June–10 October 2026**, older than the current day, with no consultation start or completion. Before changing them, a snapshot of their prior fields and all counters was saved locally in the ignored `output/phase2-development-verification/stale-serving-before-20261011.json`. The existing running backend's `/api/queue/cancel` route then cancelled each stale record with an explicit development-cleanup reason. Patient rows, registration/call/start timestamps and doctor assignment history were retained; these cancelled records produce no consultation duration. Verification found no remaining serving patients and all doctor counters free.

After that cleanup, a second scoped live verification passed **296 assertions** against the development Supabase database using seven newly registered synthetic patients. The actual `/queue/website` registration and Frontdesk `/queue/call` routes led into each assigned doctor's **Accept → Start → Complete** actions without preparing a called-state fixture. Doctor 1 completed General Practitioner consultation/checkup visits, Doctor 2 completed Obstetrician prenatal/maternity visits, and Doctor 3 completed family-planning visits. Weighted priority, equal-score registration order, ticket prefixes and doctor/service mapping passed. Six recorded durations ranged from `1.142392` to `1.374889` seconds; completion preserved the exact database start including microseconds and ignored fabricated browser timing fields. Only the assigned doctor's counter was released, and the other counters remained unchanged.

That normal-flow run also verified unaccepted Start, accepted-but-unstarted Complete, Frontdesk Start/Complete and duplicate Start/Complete rejection. Accept created exactly one announcement event per acceptance; Re-Call created one fresh event while preserving `called_at`; Call, Start and Complete created none. Cancelling a started synthetic visit excluded its duration and released its slot. Requeue cleared timing and acceptance, and the same synthetic patient then completed a newly called/accepted consultation with a fresh actual database start. All seven synthetic patient rows and temporary state were removed. Comparison of every pre-existing patient and counter row and the original settings, acceptance and voice JSON files confirmed they were preserved. The local evidence report is `output/phase2-development-verification/full-workflow-results.json` and remains ignored by Git.

The final interactive dashboard and speaker check also passed on **11 October 2026**. The user enabled Queue Display voice and exercised Doctor 3's Accept, Re-Call, Start Consultation and Complete Consultation controls for the labelled synthetic patient **FP-014**, ID **140** (`PHASE2 FINAL TEST 86f5369e`), confirming audible playback and successful dashboard actions. The running backend and development Supabase database recorded `consultation_started_at = 2026-10-11T03:12:41.335249+00:00` and `completed_at = 2026-10-11T03:12:53.875305+00:00`, with completed status and an API-derived duration of **12.540056 seconds**. Doctor 3's `current_patient_id` is null. The one Accept event and six explicit Re-Call events all occurred before consultation start; Start and Complete produced no new announcement. The completed, clearly labelled manual test record remains in the development database. Local evidence is saved in the ignored `output/phase2-development-verification/manual-ui-patient.json`. Automatic access must target only the development project confirmed above.

The finishing changes correct the backend/SQL completion contract, prevent legacy Recall from moving an accepted patient's original call timestamp, protect completed records against No-show and delayed No-show writes, report unavailable database transport as HTTP 503, and expose the queue's storage mode. Call also recognizes the existing Frontdesk account's `Front Desk`/`frontdesk` assignment label, ignoring case and surrounding whitespace, while retaining actual doctor-assignment restrictions. This compatibility fix does not change database user records. Existing Analytics service-time averages now use actual valid consultation durations, excluding cancellation, No-show and historical records without a start. Backend startup inserts missing doctor counters with `ON CONFLICT DO NOTHING`; it preserves existing IDs, service mappings, online flags and active patient pointers so a restart does not detach an ongoing consultation. An occupied-port listen failure reports `EADDRINUSE`, exits with code 1, and skips success logging and counter seeding; keep one backend watcher running.

### Dashboard and announcement follow-up

Subsequent development testing on **11 October 2026** exposed expired browser sessions that left management pages polling unsuccessfully while the patient remained in Supabase. Dashboard identity now follows shared login changes within a browser profile. A rejected expired token clears that same session and returns protected pages to sign-in; an ordinary doctor permission denial or a delayed rejection from an older token does not clear a valid newer session. Different browsers or browser profiles retain independent accounts. After refresh/sign-in, the user confirmed that Doctor 1's patient was visible in management, Frontdesk and Superadmin. Read-only live requests as all three roles returned the same patient, ID **141**, serving at Doctor 1. This follow-up did not mutate patient records.

Configured Supabase errors now report unavailability instead of permanently switching to an empty local queue. Requests retry the database after recovery, and successful registration remains successful if a later notification/statistics read fails. Temporary local storage remains available for unconfigured development only. Loading `backend/.env` no longer depends on the launch directory. Voice events from an older call cycle are excluded from the current visit; pausing during an audio check no longer consumes an unspoken event or starts overlapping processors. Voice readiness no longer queues an unnecessary warm-up behind active speech.

At the **11 October 2026** follow-up, Queue Display provided **Enable Bell** to unlock browser audio and preview the selected slower, descending ding-dong: 880 Hz followed by 660 Hz, with the second note starting 0.8 seconds later and each note decaying over 1.2 seconds. Speech waited for the bell to finish. Backend and voice services were restarted with those fixes. Verification passed **151 backend/SQL tests**, **79 frontend tests**, **3 Python voice readiness tests**, and the production build from an isolated staged snapshot. Credentials, runtime state and the unrelated local fill-up form change were excluded. The user then confirmed that Re-Call played the selected bell as intended on the actual speakers. These are historical observations of the former browser-bell implementation.

The **17 October 2026** correction moves that selected bell into the local Windows Python worker before speech and removes **Enable Bell** and browser audio activation. Queue Display supplies `play_chime` from **Sound Notifications**; disabling the setting preserves speech, and a bell failure also permits speech while recording `last_chime_error`. With the updated service running and announcements enabled, registration polls and display reloads need no bell click. The Voice pause control and global settings still apply. Restart the existing Python service after updating its script, confirm `chime_supported: True` in health, and follow the [current voice setup and speaker check](../README.md#run-the-pyttsx3-voice-announcer-on-windows). The application does not start that service automatically, and the 11 October speaker observation does not verify this updated playback path.

Phase 2 implementation files:

- `backend/src/services/queueService.js`, `backend/src/routes/index.js` — lifecycle validation, RPC calls, derived duration, queue responses, service-time analytics and safe counter initialization.
- `backend/src/index.js` — failed-listen handling before success logging or counter initialization.
- `backend/scripts/20261010-phase2-consultation-lifecycle.sql` — additive schema and transactional PostgreSQL functions.
- `backend/scripts/20261011-phase2-verify.sql` — read-only installation checks in one result table for screenshot verification.
- `frontend/components/DoctorAdmin.js` — accepted/started phases, actual start display, doctor-only actions and duplicate-click protection.
- `frontend/components/PatientQueueTable.js`, `frontend/pages/index.js`, `frontend/pages/queue-display.js` — monitoring, compatibility and announcement regression handling.
- `backend/test/helpers/queueHarness.js`, `backend/test/phase1-workflow.test.js`, `backend/test/phase2-consultation.test.js`, `backend/test/phase2-postgres.test.js`, `backend/test/phase2-startup.test.js` — isolated workflow, actual SQL, stale-request and restart coverage.
- `backend/test/server-listen.test.js` — real occupied-port regression using an isolated backend child with Supabase access disabled.
- `frontend/test/doctor-consultation.test.cjs`, `frontend/test/patient-queue-call.test.cjs`, `frontend/test/superadmin-queue.test.cjs`, `frontend/test/queue-display-voice.test.cjs` — dashboard, monitoring, priority and voice regression coverage.
- `README.md`, `docs/phase2-consultation.md` — application, validation and rollout instructions.

## Patient workflow

| Phase | Patient status | Saved timing and doctor action |
| --- | --- | --- |
| Registered | `waiting` | No counter, call, consultation start, or completion timestamp. |
| Called | `serving` | Frontdesk `/queue/call` sets the assigned counter and `called_at`; doctor Accept is available. |
| Accepted | `serving` | Existing `/queue/accept` saves `acceptedAt` in `awaiting-accept.json` and creates the existing voice announcement event. Start Consultation becomes available. |
| Consultation in progress | `serving` | Doctor `/queue/start` saves PostgreSQL's `consultation_started_at`; the dashboard shows that start time and Complete Consultation. |
| Consultation completed | `completed` | Doctor `/queue/complete` saves PostgreSQL's `completed_at`, retains the start and doctor assignment for history, and releases the counter in the same database transaction. |

Accept does not start consultation. Start and Complete do not create announcements. Existing Re-Call remains the explicit way to request another announcement. Cancel/no-show records do not contribute service duration, even if consultation had started.

Start and Complete are doctor-owned actions. Frontdesk and Superadmin monitor their progress and cannot bypass Start through another completion button or an API request. Existing completed records remain valid with a null start and null derived duration; there is no inferred historical start or backfill from `called_at`.

## API contract

The JavaScript backend uses the existing bearer-token authentication. The browser supplies only the patient ID, not a doctor identity, acceptance timestamp, start time, end time, or service-role credential.

```http
POST /queue/start
Authorization: Bearer <doctor session token>
Content-Type: application/json

{"patient_id":123}
```

`POST /queue/complete` uses the same authenticated patient ID convention and keeps the existing optional reason parameter. Both endpoints validate the current database user, assigned doctor, serving patient, and matching counter pointer. Start additionally requires the existing backend acceptance state and an empty consultation start. Complete requires a valid persisted start and an unfinished serving patient. The backend passes that exact database-read start as `p_expected_started_at` to the completion RPC; SQL rejects a delayed completion request if the locked patient's start has changed to a later consultation attempt. No timestamp is supplied by the browser. Duplicate requests fail without replacing timestamps or changing another doctor's queue.

Responses expose `consultation_started_at`, `completed_at`, and derived `service_duration_seconds` with patient data. Error responses follow the existing backend convention. A missing Phase 2 migration must be fixed by applying the migration; it must not be bypassed using the old separate patient/counter completion writes.

Start/Complete return `{ success: true, patient, storage_mode, message }`. `/queue` and `/display` also expose `storage_mode`: `supabase` for persisted database records, or `local_fallback` for the existing temporary development memory. The Doctor Dashboard identifies temporary records when fallback is reported. Lifecycle database read/RPC transport failures return HTTP 503 without switching storage or fabricating a successful consultation.

## Apply the additive migration to development Supabase

No live Supabase schema change is applied automatically by this implementation. **Production database application requires explicit approval.** First use an isolated development Supabase project or preview branch containing the project's patient/counter/user schema.

1. Review [20261010-phase2-consultation-lifecycle.sql](../backend/scripts/20261010-phase2-consultation-lifecycle.sql).
2. Confirm the selected Supabase project is the intended development environment. Configure `backend/.env` with that project's URL and service-role key; keep the key in the backend only. Never place it in `frontend/.env` or a `NEXT_PUBLIC_` variable.
3. Inspect existing columns with this read-only query:

   ```sql
   SELECT table_name, column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('patients', 'counters', 'users')
   ORDER BY table_name, ordinal_position;
   ```

4. Confirm `patients.id` is bigint; `counter_id` holds a doctor/counter identifier; `called_at` and `completed_at` are `timestamp with time zone`; counters have unique `id_num` values `Doctor 1`, `Doctor 2`, `Doctor 3` and `current_patient_id`; doctor users have role `admin` and the corresponding `doctor_name`. Inspect any pre-existing `consultation_started_at`: it must be nullable `timestamp with time zone`, not a browser-generated or historical call timestamp.
5. Open **Supabase → SQL Editor → New query**, paste the complete versioned migration, and run it. The file uses one transaction and ends with a PostgREST schema-cache notification. Save the migration version/application date in the team's deployment record.
6. Restart the JavaScript backend and frontend with the Phase 2 code. From the project root use `npm.cmd --prefix backend run dev`; from inside `backend/` use `npm.cmd run dev`. Stop the existing watcher before starting its replacement. See the [root setup guide](../README.md#run-the-application) for current-folder and duplicate-instance guidance. Keep the existing pyttsx3 voice service running for the acceptance announcement test; see the [root voice guide](../README.md#run-the-pyttsx3-voice-announcer-on-windows).

The migration follows the project's existing `backend/scripts/` manual SQL convention. It adds nullable `patients.consultation_started_at TIMESTAMPTZ`, ensures the already established `reason` column exists on older deployments, and creates two RPC functions. It changes no existing records, status definitions, priority weights, or RLS policies. Do not rerun `backend/supabase/City_health--Queuing.sql` on an existing deployment: its initial seed section truncates counters.

For screenshot verification, run the complete [read-only installation query](../backend/scripts/20261011-phase2-verify.sql) after the migration. Its single Results table contains 15 checks for patient column types/nullability, the exact named Start/Complete RPC parameters, and role execution permissions. Every row should show `PASS` and `all_pass = true`. Missing functions or roles produce failed checks instead of query errors. This verifies installation only; it does not replace the live patient workflow and speaker checks below.

This checkout's backend server key is configured and actual Supabase API access has been verified. For a fresh checkout, Supabase's [API key guide](https://supabase.com/docs/guides/getting-started/api-keys) describes Settings → API Keys; put the existing server secret or legacy service-role key in `SUPABASE_SERVICE_ROLE_KEY` in the ignored `backend/.env`. This application passes that variable directly to its backend `createClient`, so both server-key formats can be used. A connected Supabase plugin or signed-in browser can provide an additional access route, but neither is needed for backend API testing.

Verify the schema and execute grants after application:

```sql
SELECT data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'patients'
  AND column_name = 'consultation_started_at';
-- Expected: timestamp with time zone, YES, no default.

SELECT role_name, function_name,
  has_function_privilege(role_name, function_name, 'EXECUTE') AS may_execute
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS roles(role_name)
CROSS JOIN (VALUES
  ('public.start_patient_consultation(bigint,text,text,timestamptz)'),
  ('public.complete_patient_consultation(bigint,text,text,timestamptz,text)')
) AS functions(function_name);
-- Expected: false for anon/authenticated, true for service_role.
```

Only the Node backend calls these RPCs with its service-role client. SQL checks the current `public.users` doctor assignment again and locks the assigned counter before the patient. Completion updates the patient and releases that specific counter within one PostgreSQL transaction; a release failure rolls both writes back. Execute grants are revoked from PUBLIC, `anon`, and `authenticated`; both functions use an empty search path and fully qualified relations, following [Supabase's function security guidance](https://supabase.com/docs/guides/database/functions#secure-a-database-function). PostgreSQL [row locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS) serialize overlapping Start/Complete transactions. The mutation uses [clock_timestamp()](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), which records the database's actual current time after lock acquisition.

Acceptance is still stored outside PostgreSQL. The backend must obtain `p_accepted_at` from its validated acceptance mechanism and obtain `p_user_id_num` from the authenticated session; these are trusted server attestations, not client-supplied authorization. The SQL function cannot read `awaiting-accept.json` itself. Under its row locks, Start also rejects an acceptance timestamp older than the patient's current `called_at`, preventing an acceptance read from an earlier cancel/requeue/call cycle from starting a later cycle. Both of those timestamps originate from the Node backend clock; the actual consultation start remains the PostgreSQL clock.

## Duration and historical records

`service_duration_seconds` is derived from the actual start and completion timestamps, with sub-second precision. It is valid only for a `completed` patient with finite timestamps and an end strictly after the start. Waiting, serving, cancelled/no-show, and legacy completed records without a valid start return null. No redundant duration column is added; retaining the two source timestamps allows the duration to be recalculated consistently.

Existing Analytics global and per-service averages use these same valid durations, converted to minutes before averaging. They do not include the interval from Call or Accept to Start, or round each individual consultation to a whole minute. Existing waiting-time reporting and priority scheduling are unchanged; no AST prediction is implemented.

This read-only query checks development records and shows the same duration definition:

```sql
SELECT id, queue_number, status, counter_id, called_at,
       consultation_started_at, completed_at,
       CASE WHEN status::text = 'completed'
                 AND consultation_started_at IS NOT NULL
                 AND completed_at IS NOT NULL
                 AND isfinite(consultation_started_at) AND isfinite(completed_at)
                 AND completed_at > consultation_started_at
            THEN EXTRACT(EPOCH FROM completed_at - consultation_started_at)
            ELSE NULL END AS service_duration_seconds
FROM public.patients
WHERE id = 123; -- Replace with your isolated development patient's ID.

SELECT id_num, current_patient_id FROM public.counters ORDER BY id_num;
```

`acceptedAt` remains in `backend/data/awaiting-accept.json`; do not compare it as though it were a Supabase column. `called_at`, acceptance time, and actual consultation start have different meanings. Keep backend and database clocks synchronized when comparing their wall-clock order.

## Automated tests

Run the regular suites from the project root:

```powershell
npm --prefix backend test
npm --prefix frontend test
```

The optional SQL integration suite uses [PGlite](https://pglite.dev/docs/), a local PostgreSQL engine, to execute the actual migration and RPCs in a fresh in-memory database. It reads no `.env` file and connects to no Supabase project. If its optional package is unavailable, Node reports the SQL suite as skipped; backend/frontend tests still run.

Install the tested engine into a temporary folder without changing the project's package files, then run the SQL suite:

```powershell
$phase2PgTests = Join-Path $env:TEMP 'city-health-phase2-pg-tests'
npm install --prefix "$phase2PgTests" --no-save --package-lock=false --ignore-scripts @electric-sql/pglite@0.3.15
$env:PHASE2_PGLITE_MODULE = Join-Path $phase2PgTests 'node_modules/@electric-sql/pglite'
node --test backend/test/phase2-postgres.test.js
Remove-Item Env:PHASE2_PGLITE_MODULE
```

The SQL tests cover migration repeatability/history preservation, timestamp type/database clock, unaccepted/invalid states, stale acceptance from a previous call cycle, stale completion after a later consultation attempt, exact microsecond start matching, doctor identity/aliases/isolation, duplicate queued requests, start-required completion, duration/correct counter release, counter-failure transaction rollback, suppressed patient/counter updates, and RPC execution permissions. PGlite has a single database connection. These duplicate tests exercise queued requests; they do not prove multi-session contention behavior on a deployed Supabase instance.

The SQL suite also routes an isolated doctor Accept/Start/Complete request through the actual backend services and executes their named RPC arguments against the migrated PostgreSQL functions. It does not fill in missing parameters on the backend's behalf. Workflow tests cover Analytics exclusions/precision and preserve actual history through legacy actions; startup tests verify ongoing consultations survive counter initialization and a fresh backend module. The occupied-port regression starts the actual backend entry point with Express, verifies exit code 1 and no seeding, and replaces Supabase with a test client that rejects database access.

If a restricted Windows execution environment blocks Node's test child processes with `spawn EPERM`, run the same suites in one process instead:

```powershell
node --test --test-isolation=none backend/test/*.test.js
node --test --test-isolation=none frontend/test/*.test.cjs
# Set PHASE2_PGLITE_MODULE as above to include the optional SQL tests.
```

The occupied-port regression itself launches an isolated child process, so it still requires permission to spawn processes even when the outer test runner uses `--test-isolation=none`.

## Manual development verification

The scoped live API/RPC checks above verify the normal registration/Call/Accept/Start/Complete path for all three doctors, weighted selection, actual consultation writes, timestamp precision, counter release and parallel duplicate handling. The historical serving records that initially blocked normal Call have been cancelled after review and a local snapshot; all doctor counters were then verified free. The final Doctor 3 dashboard and audible playback check passed, with its persisted result recorded above. The steps below remain a repeatable development verification procedure. Use newly registered, clearly labelled development patients and record their IDs; do not alter real patient records for testing. For future visits, check both counter pointers and older serving rows: an empty today's queue alone does not make a doctor available.

1. Register patients for each service. Verify waiting status and null timing/counter fields; check that weighted priority and registration-time ties still select the correct next patient for that doctor.
2. Call the eligible patient from Frontdesk. Verify the assigned doctor's current patient, serving status, `called_at`, and null consultation start/completion.
3. With Queue Display voice enabled, Accept as the assigned doctor. Verify `acceptedAt` and one existing announcement event. Start remains null, and Complete Consultation is unavailable.
4. Click Start Consultation. Verify the database start timestamp and the dashboard's in-progress display. Patient remains serving and Queue Display emits no new announcement. Attempt an immediate duplicate Start; verify the saved time is unchanged.
5. After a measurable interval, click Complete Consultation. Verify completed status, preserved start, server end later than start, positive derived duration, and null `current_patient_id` only for that doctor. Frontdesk and Queue Display should refresh and Doctor 2/3 should remain unchanged.
6. Using another doctor's authenticated development session, attempt Start/Complete for this doctor's patient. Also attempt waiting, unaccepted, cancelled, completed, and accepted-but-unstarted cases. Each invalid action must fail without changing patient/counter records.
7. Issue overlapping Start and overlapping Complete HTTP requests against the development backend, then repeat against two backend instances sharing the same development database where available. Verify one transition succeeds, the duplicate fails safely, and the persisted start/end are not overwritten. This exercises deployed PostgreSQL row-lock behavior beyond the embedded test engine.
8. Exercise Re-Call, Cancel, no-show, and any existing Undo/requeue action on separate development patients. Verify Re-Call creates only its existing announcement event, cancelled/no-show records have null derived duration, and a patient returned to waiting has no stale consultation start. Complete a fresh consultation after a re-call/requeue to confirm it records a new actual start.
9. Review historical completed rows without a start. Their status/end/history must remain intact and duration must remain null.

## Remaining consistency work

Phase 1 `/queue/call` still claims a counter and changes the patient in separate Supabase requests with conditional writes and compensation. Phase 2 deliberately does not rewrite that flow. Moving that call transition into a dedicated transaction is a separate targeted follow-up.

Acceptance/voice state still uses backend-local JSON files. Multiple backend processes need a shared acceptance-state design before distributed deployment; SQL cannot make a filesystem acceptance check transactional with database writes. If a called legacy patient has no acceptance record, the doctor must explicitly Accept before starting, rather than inventing a historical acceptance/start. The timestamp freshness guard cannot distinguish two call cycles that reuse the same patient ID and backend millisecond. A future targeted change should persist a unique call-cycle token and acceptance together rather than relying only on timestamp comparison.

Existing Cancel/no-show/Undo/requeue paths retain their existing storage patterns. Their patient/counter updates are not included in the new Start/Complete transaction. Overlap with those actions across multiple backend instances and direct database writers needs a separate transactional follow-up; use the development contention checks above before such a deployment. The new completion RPC itself rolls back both patient completion and counter release on failure.

Those existing legacy mutation routes also retain their earlier authorization model: an authenticated administrative session can invoke Cancel/no-show/Undo/requeue without the new Start/Complete doctor-ownership checks. Tightening their access for assigned doctors while preserving Frontdesk/Superadmin management is a separate follow-up. Completed consultations now reject No-show, Cancel, Undo and requeue attempts; status-conditional writes reject a stale No-show after completion. Legacy `/queue/recall` cannot move `called_at` after acceptance or consultation start; the existing `/queue/re-call` remains the announcement action during those phases.

No AST estimates, waiting-time predictions, priority-weight changes, or new consultation statuses are included in Phase 2.
