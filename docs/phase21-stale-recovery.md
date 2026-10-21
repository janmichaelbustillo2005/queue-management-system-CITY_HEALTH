# Phase 2.1 — protect consultation history during Requeue and Undo

The current Phase 2.2 implementation retains these history protections and supersedes the first-free counter reservation described below. Its backend requires a separate migration before database Undo can run. See the [Phase 2.2 correction and rollout guide](phase22-audit-corrections.md); installation requires explicit approval for an identified development project.

Phase 2.1 addresses only the stale recovery/history-erasure finding from the Phase 2 audit. It builds on audited Phase 2 commit `1d1be09` and retains the subsequently completed Phase A authentication/presence changes in `2bc917c`. Work is isolated on `fix-phase21-stale-recovery`.

## Root cause and write-time protection

Requeue and Undo previously validated a patient snapshot, then updated only by patient ID and status. A delayed request could resume after another visit returned that patient to the same status, reset it to waiting, and erase the newer consultation's start/end timestamps.

The additive migration introduces `patients.visit_state_revision UUID NOT NULL DEFAULT gen_random_uuid()` and `rotate_patient_visit_revision()`, invoked by a `BEFORE UPDATE` trigger on every patient update. A revision is necessary: existing legacy Cancel timestamps use JavaScript milliseconds, and Cancel → Undo → Cancel can restore every original status/timestamp/counter field in the same millisecond. No existing patient visit/version column could distinguish that case. The new metadata supplies a fresh UUID even for an update that restores all prior values. Existing patient data, statuses and consultation history remain intact; no consultation timestamp is backfilled.

`recover_patient_visit(...)` replaces the separate Supabase recovery writes. The backend reads the expected revision, status, registration/call/start/end timestamps and exact counter identifier from the stored patient, never from the browser. Raw timestamp strings go directly to PostgreSQL without conversion through JavaScript Date, preserving microseconds. After acquiring locks, the function compares all expected fields using nullable PostgreSQL equality. A changed revision or field raises SQLSTATE `40001`, returned as HTTP **409 Conflict**. The locked current row also independently rejects resetting a completed consultation with a non-null actual start.

Undo locks the canonical counters in ascending ID order before locking the patient, following the existing lifecycle lock order. Its patient reset and counter reservation commit in one transaction; failure or suppressed writes roll back both, including the revision change. The function preserves the existing first-free-online counter choice and the existing Undo fields. Correcting that choice to the patient's doctor is Phase 2.2, and is intentionally not part of this change. Requeue retains its existing bottom-of-priority-tier behavior and does not redesign counter assignment.

## API and authorization

- `POST /api/queue/requeue`: existing `{ patient_id, reason? }` payload.
- `POST /api/queue/undo`: existing `{ patient_id }` payload.
- Success responses retain their existing shape and messages.
- Changed expected visit: `{ success: false, message }`, HTTP 409. Refresh before deciding whether to retry; do not automatically retry using obsolete assumptions.
- Missing Phase 2.1 revision/RPC or database transport failure: HTTP 503; no fallback to separate writes or temporary memory for a configured database.

The existing Phase A middleware validates the authenticated session. The server passes `req.user.id_num` to SQL, which checks and share-locks the current staff account. Existing `admin` (including Frontdesk) and `superadmin` recovery permissions remain. The RPC is executable only by `service_role`, uses an empty search path and fully qualified tables, and does not change existing RLS policies. It does not grant new browser access or expose privileged credentials. Logout after middleware validation retains the system's existing in-flight-request semantics.

Acceptance and recall state are reset only after a successful recovery. Rejected stale operations leave those files, counters, timestamps and derived consultation duration unchanged. Unconfigured temporary local development storage performs final snapshot validation and recovery synchronously; its UUID rotates on creation/recovery. It is not claimed to mirror the database trigger on every local update.

## Migration and development rollout

The migration has been tested locally. It has **not** been applied to live Supabase. Phase A's existing deployment requirements still apply.

1. Use the confirmed development/testing Supabase project; review and apply the existing Phase 2 and Phase A migrations if not already installed. Do not rerun the full seed schema, which resets counters. Production migration needs explicit approval.
2. Apply [20261012-phase21-stale-recovery.sql](../backend/scripts/20261012-phase21-stale-recovery.sql) in the development SQL Editor. It runs in one transaction, adds revision metadata, installs the trigger/RPC and reloads the PostgREST schema cache. It is safe to reapply with a compatible revision column; an incompatible existing revision column aborts the migration.
3. Run [20261012-phase21-verify.sql](../backend/scripts/20261012-phase21-verify.sql). All eight installation checks must show `PASS` and `all_pass = true` for the UUID/default, enabled update trigger, exact RPC argument contract, security settings and execution grants. This script is read-only and works before installation as well, reporting failures.
4. Restart the backend and sign in with a valid Phase A session. Verify normal legacy Requeue/Undo using clearly labelled, isolated development records. Do not recover real completed consultation records for testing.
5. Before claiming independent-session concurrency verification, run the delayed stale recovery/new consultation scenario through separate PostgreSQL connections or independent backend instances against isolated development data, then compare raw timestamps, duration, counters and acceptance state. Keep the counter-selection issue scheduled for Phase 2.2.

There is no automatic migration application or database reset in this implementation. Do not deploy the changed Requeue/Undo implementation against Supabase until its migration is installed.

## Verification

Verification on **12 October 2026** passed **259 backend/SQL tests**, **101 frontend tests**, and **3 Python voice tests**: **363 passed, zero failed or skipped**. The 68 new tests comprise 24 service/route tests and 44 actual PostgreSQL tests. Before implementation, four of the initial eight recovery tests failed on the destructive stale Requeue/Undo cases; those cases now pass. Application changes are restricted to the backend and migration. No new frontend production build was required because frontend source was unchanged.

The new service/route regressions reproduce the original delayed legacy Requeue and Undo against a second actual routed lifecycle, then assert rejection, exact winning timestamps, positive duration, newer acceptance and all counter records. Further cases cover same-millisecond identical-field ABA, conflicting duplicate operations, microsecond changes, current completed-history guards, safe legacy recovery, authenticated actor forwarding, missing migration and transport failures, and rollback.

The new PostgreSQL suite executes the actual migrations, revision trigger and named backend RPC payloads in a fresh PGlite database. It verifies each exact snapshot field, null handling, revision rotation, additive migration history preservation, completed consultation protection, queued conflicts, suppressed/failed patient or counter writes, and role/RLS grants.

Run the full backend suite with the optional PostgreSQL engine configured as described in [the Phase 2 test guide](phase2-consultation.md#automated-tests). For an already installed local test engine:

```powershell
$env:PHASE2_PGLITE_MODULE = Join-Path $env:TEMP 'city-health-phase2-pg-tests/node_modules/@electric-sql/pglite'
npm.cmd --prefix backend test
npm.cmd --prefix frontend test
.\.venv-voice\Scripts\python.exe -m unittest discover -s backend/voice -p test_tts_service.py
```

PGlite has one connection. The isolated two-request barriers prove stale snapshot rejection and execute the real SQL, but do not experimentally verify independent-session PostgreSQL lock contention. No live patient records were used or modified. The final verification report records exact test counts and remaining rollout steps.

## Scope and remaining issues

The Doctor 2 → Doctor 1 Undo assignment bug, announcement backlog, midnight visibility, historical date filters, and Superadmin Accept UI remain outside Phase 2.1. Weighted scheduling, doctor mapping, voice pipeline, Queue Display, Start/Complete RPCs, patient statuses and AST are not redesigned. Backend-local acceptance JSON and other legacy mutation transactions retain their previously documented multi-instance limitations.
