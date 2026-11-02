# I2 Finding 8 fix — Call fails closed when C1 cannot be used

Date: 2026-10-29 · Branch `fix/i2-c1-fail-closed`, based on **`bd4a633`** (`integration/d1-wpsa-wrr`, unchanged).
Backend only; no SQL, no migration, no hosted database access. Tested on disposable PostgreSQL 17.10
(127.0.0.1:55417) and PGlite with synthetic rows.

## Finding (from `docs/i2-independent-verification-20261029.md`, item 8)

In `service` dispatch with WPS aging off, any of `PGRST202, PGRST204, 42883, 42703` from `call_patient_visit`
made the backend silently use the older two-statement Call (counter claim, then patient compare-and-set), even
on a database where C1 is installed (e.g. a stale PostgREST schema cache right after a migration). `42703` is
also raised from inside an installed function by unrelated schema drift.

## Change

* **Fail closed.** When C1 cannot be used, Call returns **503** with
  "Call needs the atomic C1 database function (…20261025-c1-atomic-call.sql), and it could not be used. Nothing
  was changed. …". No counter or patient write, no SMS, no pending acceptance, no voice event. This also covers a
  visit without a state revision (C1 needs one). WPS-A, D1 and D1-A already refused this way and are unchanged.
* **Explicit opt-in** `ALLOW_LEGACY_TWO_STEP_CALL=1` (`env.allowLegacyTwoStepCall`, default off) restores the
  revision-guarded two-statement Call, only for a database that never had C1. When used, the backend logs one
  warning. Documented in `backend/.env.example`; never set it on a Supabase project with C1 installed.
* **`42703` no longer means "missing" for Call** (`CALL_MISSING_RPC_CODES`); it is reported as an error (503)
  and never falls back, even with the opt-in. Requeue and Cancel keep their existing code lists.

Files: `backend/src/services/queueService.js`, `backend/src/config/env.js`, `backend/.env.example`.

## Tests

* New `backend/test/i2-c1-fail-closed.test.js` (8): flag parsing; refusal for each of PGRST202/PGRST204/42883
  without the opt-in; 42703 never falls back (with or without opt-in); revisionless visit refused; C1 available
  ⇒ atomic regardless of the flag; opt-in + no C1 ⇒ two-step works.
* New `backend/test/i2-c1-fail-closed-postgres.test.js` (3, PG17, C1/F5/W1 installed): the exact Finding 8
  scenario now gives 503 with no write and an unchanged snapshot, and the retry succeeds through C1 alone; the
  opt-in reproduces the old path; a 42703 raised inside an installed C1 is reported and never falls back.
* Updated `c1-f5-w1-backend-workflow.test.js` section B ("a database that never had C1/F5/W1"): it now uses
  the opt-in for the two-step tests and adds "Call without the opt-in refuses (503) … changes nothing".
* `test/helpers/queueHarness.js`: the mock database models "no C1" unless a test sets `callRpcInstalled`, so it
  passes the opt-in by default; `allowLegacyTwoStepCall: false` models a strict deployment.

## Regression (evidence: `output/i2-verification-20261029/fail-closed/`, main checkout, Git-ignored)

| Suite | Result |
|---|---|
| Backend full (PG17 + PGlite + voice venv) | **1093/1093**, 0 skipped (1081 before + 12 new) |
| PostgreSQL suites, serial | **417/417** |
| Frontend | **405/405**; `next build` OK |
| I2 verification tests run on this fix | matrix, boundaries, Indigenous scenario, three-doctor drain, migration lifecycle, shared-mode refusal: **6/6 pass**. The I2 audit test that pinned the old fallback now fails as intended (503 instead of 200): the finding is fixed. |

## Operational note

The hosted development project has C1 installed, so nothing changes there except that a transient
"function not found" now refuses instead of calling non-atomically; Frontdesk retries after a refresh. The
adviser demo (`a87a4cd`) does not include this change. Merging into the integration branch is the D1/I1
session's decision.
