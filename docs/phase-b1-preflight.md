# Phase B.1 compatibility and integration preflight — 14 October 2026

**Recommendation: BLOCKED / NOT READY to apply Phase B or begin AST.** Local tests pass, and a live metadata-only Supabase request succeeded. However, the live exposed patient schema differs from Phase B's assumptions, complete catalog/security inspection is unavailable, and the target's current non-production status is not independently verified. No migration, application login, heartbeat, test fixture, real patient mutation, commit, push, deployment, or branch merge was performed in this phase. Application and existing migration files were not changed.

## 1. Current checkout — verified locally

- Repository: `C:\xampp\htdocs\queue-management-system-CITY_HEALTH`, with application source in `frontend/` and `backend/`.
- Remote: `https://github.com/janmichaelbustillo2005/queue-management-system-CITY_HEALTH`.
- Branch: `main`; HEAD: `252f5c811a3a135d93968f6dd318e0bc8419b9a0` (`Document Phase A.1 development preflight`).
- Phase B and Frontdesk carryover fixes are uncommitted working-tree changes. Before this preflight, eight tracked files were modified and six files were untracked. They were preserved.
- The fetched `origin/fix-phase21-stale-recovery` branch contains `5710f25` (stale Requeue/Undo protection) and `9c8da15` (recoverable digital queue passes). Neither commit is an ancestor of this HEAD. Available remote work is not evidence that it is integrated into this checkout.
- This preflight adds only this report and `backend/scripts/20261014-phase-b1-preflight.sql`, a prepared catalog-only supplement. Build/test outputs are local generated artifacts.

## 2. Supabase environment — partially verified live

| Check | Evidence / status |
| --- | --- |
| Effective backend origin | `https://uvmpbgpvmjkfoblrfrdt.supabase.co`; matches the previously identified project; no inherited URL override |
| Backend credential | Present, non-placeholder JWT format with decoded role `service_role`; authenticated OpenAPI GET returned HTTP 200 |
| JWT signing configuration | Present and different from the built-in `default_secret`; value was not printed |
| Frontend public secret settings | No setting names containing secret/password/service-role/private were found among `NEXT_PUBLIC_` settings in the inspected frontend `.env` |
| Direct SQL / management connection | No configured database URL, database password, management access token or PostgreSQL connection settings were found in the effective backend settings inspected |
| Supabase connector | Available but not installed/connected when checked; a connection suggestion was provided |
| Signed-in browser / SQL Editor | No enabled browser or native application surfaces were returned |
| Development suitability | Earlier documentation records owner confirmation that this project is used for development despite a `PRODUCTION` label. Current project/branch label, isolation, and contents were not independently verified |

The earlier placeholder-key blocker has changed: the current key worked for the metadata request. The initial sandbox request was denied with `EACCES`; the approved read-only request succeeded. No key, password, auth revision value, authentication token, patient row, user row, or session row was printed or retrieved. Requests were pinned to the existing project; no project switch occurred.

The only live operation was **GET `/rest/v1/` with OpenAPI Accept headers**, which inspected exposed schema metadata. It did not execute a function. OpenAPI is not the PostgreSQL catalog and cannot establish installed function bodies, all overloads, object ownership, effective RLS/grants, indexes, triggers, migration ledger, or current non-production status. Live work stopped at this access/environment gate.

## 3. Migration installation status

| Migration | Live exposed metadata | What remains unverified |
| --- | --- | --- |
| Phase 2 consultation | `patients.consultation_started_at`, `completed_at`, `reason`, and both Start/Complete RPC paths are exposed | Exact catalog signatures, body, owners, grants, transactional behavior and actual workflow. Previous owner-supplied verification dated 11 October is historical evidence |
| Phase A presence | `users.auth_revision` UUID required, session table fields, and six session/presence RPC paths are exposed | Account trigger, index/constraint definitions, exact overloads, session function bodies, policies and effective privileges |
| Phase B records | `staff_auth_activity` definition and `get_central_records` path are absent from the retrieved service-role OpenAPI metadata | Appears uninstalled or unexposed/cache-stale; absence from metadata is not definitive catalog proof |

Do not rerun Phase 2 or Phase A just because their files exist. This repository uses manually versioned scripts; the existence and contents of a Supabase migration ledger were not inspected. Inspect installed objects and deployment records first.

## 4. Compatibility findings

**Blocking patient-name mismatch.** The live exposed `patients` properties include `id_num` but exclude `first_name` and `last_name`. Current registration stores the entered full name in `id_num` (`backend/src/routes/index.js:159,190`, `backend/src/services/queueService.js:452`). Phase B instead directly references `p.first_name` and `p.last_name` for display/search (`20261014-phase-b-records.sql:48,55`).

The function uses one SQL CTE statement for every records category; filtering a CTE by category does not avoid resolving its column references. **Static inference from live metadata:** installing the function may succeed, but invoking any category can fail on the missing columns, which the API masks as 503. No Records RPC was invoked to prove this at runtime. Merely adding empty name columns would not make historical displayed names accurate. A separately reviewed compatibility decision must establish the stored-name contract and preserve historical data; this phase does not change or backfill it.

`backend/scripts/migration.sql` contains unversioned additions for first/last name, but it was not applied or added to the proposed installation sequence. Never run the original full `backend/supabase/City_health--Queuing.sql`: its seed section truncates counters and overwrites seeded passwords.

**Account metadata mismatch.** Live `users` metadata has only `id_num`, `password`, `role`, `doctor_name`, `auth_revision`; `created_at` is absent. Existing `getUsers` selects/orders by it (`queueService.js:1765–1766`). This query is incompatible with the exposed schema; it was not executed live. Phase B's account records deliberately return creation date as unavailable instead.

**Role drift.** The existing account form submits `staff` and `doctor` (`frontend/pages/index.js:790–801`), while the checked base enum and Phase A session validation support `admin` and `superadmin`. The creation route does not translate these values. Live enum labels require catalog confirmation. No role mappings or account controls were changed.

**Staff-position drift.** Phase B labels every nonnull `doctor_name` as Doctor, although the existing Call endpoint recognizes legacy `Front Desk`/`frontdesk` assignment labels (`backend/src/routes/index.js:220–222`). Such accounts would be mislabeled; a Frontdesk with null assignment instead appears as Admin, and Records has no Frontdesk position option. Review the real identity/assignment contract without inventing roles or changing live accounts.

**Object reconciliation required.** `IF NOT EXISTS` does not repair an existing incompatible column/table/index. Before approval, compare types, nullability/defaults, PK/FK/check constraints, index validity/definitions, sequence ownership, triggers, all function overloads, exact argument names and return types, owners, RLS and privileges. Existing same-signature function replacements may fail if argument names or return types differ. Phase A drops the obsolete four-argument session-creation function; its dependencies must be checked.

Phase B also assumes the expected activity identity sequence name and has no explicit PostgREST cache notification. Verify sequence ownership/permissions and schema-cache recognition in the eventual approved procedure; do not call mutating RPCs as existence probes.

## 5. Authentication and RLS audit

**Verified locally:** Authentication stays custom HS256 JWT over `public.users`, with an eight-hour persisted session. Session creation binds the verified password/account snapshot to `auth_revision` under an account lock. Protected API requests validate both JWT and the current persisted session/account. Account password/role/assignment/identity/revision changes revoke sessions and rotate the revision. Missing session storage fails closed.

Records uses `authenticateToken` plus `authorizeRole(['superadmin'])` for all categories (`backend/src/routes/records.js:5`). Presence monitoring is also Superadmin-only. Patient/account output is an explicit whitelist. The frontend uses backend APIs; no frontend Supabase table/RPC client was found. Phase B's SQL function trusts the backend service-role execution boundary rather than accepting an end-user session parameter.

The migration source revokes PUBLIC/browser execution and grants API RPC execution to `service_role`; SECURITY DEFINER functions use an empty search path. Phase B enables RLS and revokes browser privileges on raw users/patients/activity. Since current registration, queue, consultation and monitoring use the backend Supabase client, these restrictions are consistent with the source architecture. Successful live operation still depends on actual server-role table/sequence grants, role attributes, function ownership and existing policy configuration; none was inspected through SQL.

Table-level revocation also revokes corresponding column privileges. This report corrects the earlier Phase A.1 document's claim that table revocation alone inherently leaves those same column grants. Other grantors, inherited roles and alternate grants still require effective privilege inspection. RLS restricts rows and does not conceal private columns from an authorized SELECT. See [PostgreSQL REVOKE documentation](https://www.postgresql.org/docs/current/sql-revoke.html).

**Unresolved production security issue:** existing `admin123` compatibility accepts that password for account IDs beginning with `admin`, even with a different stored bcrypt password (`queueService.js:1715–1725`). Plaintext password compatibility also remains. A separate remediation decision is required; this task did not alter authentication. The checked local JWT secret is non-default, but source still has a default fallback that must not be used in deployment.

Presence is independent of authentication: 25-second client heartbeat, at most one database write per 20 seconds, 75-second online timeout, eight-hour authentication expiry. Closing a tab is not logout. Phase B records login atomically on session insertion and explicit logout once when the logout RPC revokes that session. Heartbeat loss, expiry, account-change revocation and bulk revocation do not create logout activity. Historical activity is not fabricated. Account existence/enablement, role/position and `counters.is_online` availability remain distinct. No disable flag or separate staff profile exists in the inspected schema.

**Ordering conflict:** Phase B replaces `revoke_staff_auth_session(uuid,text)` with the auditing body. Reapplying Phase A afterward replaces it with a revocation-only body and silently removes logout recording. The installed body must be checked after any future maintenance.

## 6. Cross-module findings

| Module | Verified locally / gaps |
| --- | --- |
| Registration and service assignment | Full name uses `id_num`; consultation/checkup → Doctor 1, prenatal/maternity → Doctor 2, family planning → Doctor 3. Existing laboratory/dental fallback is unchanged. Mock tests pass; no actual registration performed |
| Weighted priority and Frontdesk Call Now | Current priority/tie behavior, counter claim, duplicate-call and ownership checks pass local tests. No priority weights changed; no live call performed |
| Patient Management | Local uncommitted fixes include serving visits across dates in authenticated queue overview and safe carryover visibility/cancellation tests. Not merged remote feature parity |
| Digital Queue Pass / lost-ticket recovery | This checkout has an in-memory registration result and printable thermal ticket. It lacks the recoverable digital-pass implementation on remote commit `9c8da15`; no corresponding digital-pass test suite exists here. Phase B stored-visit retrieval is Superadmin-only and is not equivalent to a recoverable patient pass |
| Doctor login/accept/start/complete | Source payloads derive doctor identity from authenticated claims. Accept creates an acceptance/voice event without starting consultation. Start and Complete use Phase 2 RPCs; completion passes the persisted microsecond start, not a client timestamp |
| Consultation storage | SQL locks patient/counter, uses database clock, requires matching active doctor/counter and expected consultation start, and completes/releases the counter in one transaction. Local simulations pass; actual deployed body/transaction behavior unverified |
| Voice / Re-Call | Acceptance/Re-Call create distinct persisted JSON-file events; display deduplication/bell/speech tests pass. Withdrawal/backlog and midnight gaps remain below; actual speakers/browser not exercised |
| Presence dashboard | Independent presence, counter enabled setting, availability and unknown-on-failure behavior pass local tests. No live sessions/heartbeats/browser checks |
| Records | Frontend/API pagination, search, service/doctor/status/role/position/presence filters and stored ticket details exist locally; API role-denial tests pass. Live schema mismatch blocks Records compatibility |
| Analytics | Actual duration calculation excludes invalid/unperformed consultations locally, but historical date selection remains broken. This affects future AST training/estimation data |

Acceptance/voice state still uses the backend local queue-settings JSON file, not Supabase session/activity tables. Availability across multiple backend deployments/shared storage requires deliberate integration verification; Phase B does not move that state.

Doctor frontend redirection/page authorization also depends on specific IDs `admin1`, `admin2`, `admin3` (`AuthContext.js:87–90`, doctor page guards), while backend consultation authorization checks the stored doctor assignment more generally. A different existing assigned account is not guaranteed to reach its correct dashboard. No accounts or routing logic were changed during review.

## 7. Previously identified Phase 2 issues — current checkout

| Issue | Current status and evidence | Impact |
| --- | --- | --- |
| Stale Requeue/Undo overwrites history | **Partially protected.** Completed visits with a stored consultation start cannot reopen; database writes compare the previously read status (`queueService.js:1097,1130,1148,1170`). They do not compare the complete visit/call snapshot, so same-status multiple-cycle/ABA races remain. Requeue also changes `created_at`; cancelled attempts may lose timestamps | Historical records and future AST inputs remain at risk; remote `5710f25` fix is outside HEAD |
| Cancel → Undo reserves wrong doctor | **Undo reservation corrected locally:** Undo leaves counters unreserved (`queueService.js:1178`), covered by six tests. **Adjacent assignment risk remains:** Cancel prefers caller-supplied counter ID (`queueService.js:905,928`); Undo retains it, and later Call rejects conflicting service assignment | Do not label the whole cancellation/assignment workflow fixed |
| Withdrawn voice backlog | **Unresolved in browser backlog.** Backend filters current serving/current call events (`queueService.js:1432–1438`), but already queued browser snapshots are not reconciled before playback (`queue-display.js:383–396,434–445,665`) | A withdrawn patient can still be announced from pending speech |
| Active consultation disappears after midnight | **Partial local fix.** Authenticated queue overview includes all serving visits (`queueService.js:277–283`), but public display still uses today's rows (`1363–1365`), and stats remain today-only | Display/voice monitoring can lose ongoing visits; local overview tests do not prove all screens fixed |
| Historical Analytics/Records dates | **Analytics and legacy transactions unresolved.** `getFilteredPatients` ignores date/range parameters and starts with today's rows (`1322–1333`); Analytics calls it (`1495`). Host-local hour buckets and UTC default dates add inconsistencies. **Phase B SQL dates are correct in source:** explicit `Asia/Manila` conversion, but RPC blocked by schema mismatch | Resolve historical data selection/timezone contract before AST |
| Superadmin sees rejected Doctor Accept | **Main dashboard corrected; Doctor view unresolved.** Main dashboard has monitoring controls without Accept. Superadmin may open `/admin1`, `/admin2`, `/admin3`; DoctorAdmin renders Accept without the consultation-role guard (`DoctorAdmin.js:789`), while backend rejects Superadmin acceptance | Misleading UI persists on doctor views; no authorization bypass inferred |

These are source/test findings, not live reproduction. No branch fixes were imported automatically.

## 8. Automated verification executed this phase

| Command / scope | Actual result |
| --- | --- |
| `npm.cmd test` in `backend/` | 149 tests passed; 0 failures. Auth, presence service/routes, consultation, priority calls, carryover and Records API authorization included |
| Optional Phase A PostgreSQL suite | Marked skipped/unavailable: `@electric-sql/pglite` not installed |
| Optional Phase 2 PostgreSQL suite | Marked skipped/unavailable for the same reason |
| `npm.cmd test` in `frontend/` | 106 tests passed; 0 failures. Sessions, heartbeat, doctor workflow, monitoring, Frontdesk/Superadmin queue calls and browser-voice simulations included |
| `python -m unittest discover -s backend/voice -p test_tts_service.py -v` | 3 readiness tests passed; no speakers/SAPI playback used |
| `npm.cmd run build` in `frontend/` | Production Next.js build passed; `/records` included |
| `git diff --check` | Passed before adding the report/catalog supplement; final artifact check also required |

The backend runner reports aggregate `skipped=0` tests because the two optional describe suites register no runnable children when their dependency is absent; the named suite entries explicitly report skipped. Do not interpret the aggregate as PostgreSQL coverage. Phase B has mocked endpoint authorization tests but no executed PostgreSQL Records integration or frontend Records interaction suite. Digital-pass/lost-ticket tests are absent from this checkout. PGlite packages were not downloaded or installed.

## 9. Proposed migration order, exact artifacts and changes — not authorized

First complete catalog inspection and resolve the name-column contract in a separately reviewed compatibility change. Do not fabricate a migration filename or historical names. Phase 2 and Phase A depend on the existing base tables but are otherwise independent; a controlled complete sequence is **schema reconciliation → Phase 2 → Phase A → Phase B last**. Already compatible installed phases should be verified rather than blindly repeated.

Current on-disk byte SHA-256 values:

| Exact filename | SHA-256 | Expected changes |
| --- | --- | --- |
| `backend/scripts/20261010-phase2-consultation-lifecycle.sql` | `FAE6CDCE76061D92991E84EF05C16F0ACA0B335F12A17C3FCB36C58BBF6253D5` | Nullable consultation start, reason compatibility, transactional Start/Complete functions and restricted execution |
| `backend/scripts/20261012-phase-a-auth-presence.sql` | `0305BAE1020EBEAD72DFA483E262664123F979E0D87317F8C221D6242E7D4966` | Account revision, session storage/indexes/policy, account-change trigger, six session/presence API RPCs; no patient/counter writes |
| `backend/scripts/20261014-phase-b-records.sql` | `F862E494164CCCDC9C3942BAF805E0B595B2725C67323BD3207C3C99AACF9106` | Activity table/index, login trigger, auditing logout replacement, records function, users/patients RLS and grants |

The Phase A byte hash differs from the earlier report because this checkout uses CRLF. Its LF-normalized SHA-256 equals the earlier `DA9B7F4BA8F807FAF519F15DAA0FF7EA20DE053F63B25C6581F161CFC8A23198`. Line endings matter for exact approval artifacts. Recompute hashes after any approved repair; the current Phase B hash is **not** a recommendation to install it.

Required installation permissions are an approved migration executor able to create/alter tables, columns, indexes, triggers and functions; inspect/drop the obsolete creation overload; and grant/revoke object privileges under the correct owner. These privileges must not be exposed to the frontend. Read-only catalog access is separate from migration authority.

## 10. Controlled procedure and verification plan

1. Confirm the pinned project/branch is an isolated, approved non-production environment. Its name or URL alone is insufficient. Install/connect the Supabase integration or provide access to a signed-in SQL Editor/direct read-only SQL connection without sending secrets in chat.
2. Execute catalog-only `backend/scripts/20261013-phase-a1-preflight.sql` and the prepared `backend/scripts/20261014-phase-b1-preflight.sql`. The new supplement includes Phase 2/B table and column metadata, constraints, indexes, triggers, all relevant overloads/named arguments, owners/security-definer search paths, effective table/column/function permissions, policy definitions, enum values, sequence ACLs/identity dependency and all reviewed owner role attributes. It exports no function bodies or application rows. Both remain **not executed** here; new SQL has static review only, not runtime validation. Its logout-body string check is a hint, not semantic proof; `users.created_at` is an application discrepancy, not a required migration column.
3. Compare deployed bodies privately against reviewed source and check the logout body's activity insertion. Verify every known discrepancy and migration ledger/deployment record; do not infer compatibility from object names.
4. Produce the corrected, exact migration set and fresh hashes, expected changes, privileges, rollback limitations and separately named test fixtures. Request explicit approval only when that concrete plan is compatible. No migration approval is requested now because it is not ready.
5. After approval, record backups and approved aggregate preservation baselines in a quiet development window. Apply only missing/reconciled reviewed migrations in the dependency order; refresh schema metadata as needed and capture installation results.
6. Run the read-only Phase 2/Phase A installation queries plus catalog checks. `20261014-phase-b-verify.sql` is **a write test**, not catalog preflight: it inserts accounts/patients/sessions, updates sessions and calls revocation functions. Its first/last-name fixture is incompatible with the observed schema. Even `ROLLBACK` does not undo sequence advancement; see [PostgreSQL sequence documentation](https://www.postgresql.org/docs/current/functions-sequence.html). Correct and separately approve its fixtures before execution.
7. Only after explicit session/test-write approval, exercise isolated Doctor/Superadmin accounts and specifically approved disposable visits: login/logout and independent sessions; heartbeat/stale presence/recovery/expiry; Superadmin monitoring; unauthorized API/direct DB denial; registration/mapping/WPS; Call/Accept/Re-Call/voice; consultation timestamps/counter release; preserved prior records; staff/account mapping and actual activity; Philippines midnight/date boundaries; ticket recovery only after the intended branch feature is integrated.
8. Run actual desktop/mobile browser checks and audio playback on the display machine. Verify independent PostgreSQL concurrency with real separate connections if required. Mock/PGlite tests do not establish live browser or multi-connection success.

All proposed live workflows above are **not executed**. Opening an authenticated application page can immediately send heartbeat writes; browser integration remains behind the test-write approval gate.

## 11. Recovery, blockers and exact approval gates

If a future migration fails before COMMIT, explicitly roll back that transaction and inspect catalog state/preservation evidence. If failure occurs after COMMIT or during schema-cache refresh, inspect first; do not replay the full schema or assume nothing installed. Prefer a reviewed forward correction. Do not drop sessions/activity/revisions, reset counters, delete patient history, or restore insecure legacy authentication automatically. Backup restoration and fixture cleanup require exact, separate scope/approval.

To resume this preflight, the owner must establish the current non-production target and enable read-only catalog access. No additional live application test should run until then. Outstanding blockers are the Phase B patient-name mismatch, incomplete live catalog/RLS verification, absent/unexposed Phase B objects, unintegrated digital-pass/stale-recovery branch work, known history/date/display/voice issues, and the legacy account query/role drift.

Actions requiring separate explicit approval after readiness review:

- Applying any corrected/versioned schema or privilege/function/trigger change to the confirmed development project, including any required cache notification.
- Creating/logging in with isolated test accounts, writing sessions/heartbeats/logout activity, creating visits, calling/accepting/starting/completing/cancelling/requeueing test visits, and changing fixture timestamps/counter state.
- Backup restoration, destructive recovery or fixture cleanup, with exact targets.
- Committing, pushing, merging branch features, or deploying; none is authorized by this preflight.

Production migration/testing is prohibited for this task. Phase B.2 and AST were not started. Skills used for access discovery: [computer-use](<C:/Users/Jan Michael Angelo/.codex/plugins/cache/openai-bundled/computer-use/26.1007.21434/skills/computer-use/SKILL.md>) and [plugin-management](<C:/Users/Jan Michael Angelo/.codex/plugins/cache/openai-curated-remote/plugin-management/0.1.0/skills/plugin-management/SKILL.md>); neither installed a connector or authorized database modifications.
