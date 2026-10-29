# D1 — Flexible doctor assignment (general doctors)

Date: 2026-10-29 · Branch: `feature/d1-flexible-doctor-assignment` (worktree `output/wt-d1-flexible-doctor`,
based on `feature/e2e1-wps-testing` @ `83c4943`) · Status: **local development only, not merged, not deployed.**

Confirmed requirement (City Health administrator): Doctor 1, Doctor 2 and Doctor 3 are general doctors. Each may
handle every offered service (consultation, check-up, prenatal, maternity, family planning). The previous fixed
mapping (Consultation → Doctor 1, Prenatal/Maternity → Doctor 2, Family Planning → Doctor 3) no longer describes
the health center.

Safety: no hosted Supabase data, schema or function was read or written; no deployment, merge or Reset Queues;
the adviser demonstration (ports 3000/4000, main checkout) and the in-progress WPS-Aging worktree were not touched.
All database tests ran on a private PostgreSQL 17.10 cluster (loopback `127.0.0.1:55517`, cluster name
`r22-disposable-cancel-verification`) with synthetic rows only.

---

## 1. Every place a doctor was fixed to a service

| Area | File | What it encoded | D1 treatment |
|---|---|---|---|
| Call routing, ranking, busy check | `backend/src/services/queueService.js` `callPatient` | doctor = `getDoctorForService(service)`; head = first waiting visit *of that doctor's services*; legacy serving row without a doctor blocks the mapped doctor | Shared mode: doctor = the selected/calling doctor; head = first visit of the **shared** queue; legacy orphan rule kept |
| Registration availability | `queueService.js` `ensureDoctorAvailableForService` | registration refused when the *mapped* doctor is offline | Shared mode: refused only when **no** doctor counter is enabled, or the service is not offered |
| Queue numbers | `queueService.js` `getNextQueueNumber` | local sequence keyed by doctor | keyed by service code (GP/OB/FP); hosted numbering unchanged |
| Cancel / No-show / Requeue / Undo ownership | `queueService.js` `resolveCancelOwner`, `authorizeVisitAction` | an uncalled visit "belongs" to its mapped doctor (that doctor account may cancel it; W1 stamps it) | Shared mode: an uncalled visit belongs to **no** doctor; only Frontdesk/Superadmin manage it; no doctor is sent to W1 |
| Historical Backlog | `queueService.js` `backlogView` | uncalled visit shown with mapped doctor, `doctor_source: "service"` | Shared mode: `doctor: null`, `doctor_source: "unassigned"` |
| Transactions doctor filter | `queueService.js` `getFilteredPatients` | uncalled rows attributed to mapped doctor | Shared mode: stored doctor only |
| Analytics doctor table | `queueService.js` `getVisitDoctor` | uncalled rows credited to mapped doctor | Shared mode: `"Unassigned"` |
| Counter seed / dev memory | `queueService.js` `localData.counters`, `seedCounters`; `backend/supabase/City_health--Queuing.sql`; `backend/scripts/update-doctor-assignments.sql`, `migration.sql` | `counters.service_types` per doctor | Not used for routing in shared mode (descriptive only). No data change made |
| C1 atomic Call | `backend/scripts/20261025-c1-atomic-call.sql` | the same CASE in validation, busy check and ranking | **Unchanged** (still used in service mode). Shared mode uses the new D1 function |
| W1 atomic Cancel | `backend/scripts/20261025-w1-atomic-cancel.sql` | owner of an uncalled visit = mapped doctor; attribution stamp | **Unchanged**. Backend never forwards a doctor for an owner-less visit, so W1 neither checks nor stamps one; release is by pointer, so only the actual doctor's counter is freed |
| Records SQL (Phase B.2) | `backend/scripts/20261023-phase-b2-records.sql` `get_central_records` | routed doctor for unassigned visits (`doctor_source: 'service'`), and doctor filter by routing | **Unchanged**. `backend/src/routes/records.js` relabels to `unassigned` in shared mode. Filter limitation: see §13 Q5 |
| F5 Requeue, Phase 2.2 Undo, Phase 2 Start/Complete, Phase A presence | respective SQL | no service mapping (stored `counter_id` / account aliases only) | no change needed |
| Frontdesk registration | `frontend/pages/fill-up_form.js` | `SERVICE_TO_DOCTOR`, mapped-doctor availability, "· Doctor N" in the review line, "N waiting in Doctor N's queue" | Shared: any enabled doctor; "Next available doctor"; "in the shared queue" |
| Patient Management / Call Now | `frontend/components/PatientQueueTable.js`, `frontend/pages/patient-management.js` | `DOCTORS` assignment labels, `SERVICE_TO_DOCTOR`, one queue and one Call Now per doctor | Shared: one queue, one Call Now on its head with a doctor selector (enabled, free doctors only); served rows under their actual doctor |
| Superadmin dashboard queue | `frontend/pages/index.js` | `getServiceDoctor`, per-doctor head and Call | Shared: shared head, "Call to Doctor N" (first free doctor) |
| Doctor dashboard | `frontend/components/DoctorAdmin.js` | Undo window by service; "My Assignments"; "Matching Waiting" by service | Shared: own patients only; "All services (general doctor)"; all waiting |
| Ticket (digital + thermal) | `frontend/lib/queueTicket.js` | "Assigned to Doctor N" from service; patients-ahead per service doctor | Shared: "Doctor assigned when called" / "Assigned: Next available doctor" until called, then the actual doctor; patients ahead over the shared queue |
| Queue Display | `frontend/pages/queue-display.js` | waiting grouped per doctor by service; GP/OB/FP badges; per-doctor "Next" | Shared: one waiting list; neutral "MD" badges; "Next" = shared head. Voice already used the stored doctor |
| Records table | `frontend/components/RecordsTable.js` | "(by service)" label | adds "Unassigned (not called)" |
| Tests that encode the mapping (kept for service mode) | `backend/test/e2e1-test-c-d.test.js` (Test D), `e2e1-test-b-wps.test.js`, `c1-*`, `w1-*` parity tests, `helpers/queueHarness.js`; `frontend/test/patient-queue-call.test.cjs`, `queue-display-voice.test.cjs` grouping | valid for the default service mode; shared-mode equivalents added (§7–§9) |
| Not on this branch | `feature/e2e1-wps-testing`: `backend/scripts/20261029-wps-a-call-aging.sql`, WPS-A head filter in `queueService.js`; `backend/simulation/engine.js` (`DOCTOR_FOR_SERVICE`) | fixed mapping in the WPS-A twin of C1 and in the WRR simulation dispatch | see §10, §11 |
| Manuscript-facing docs | `docs/phase2-consultation.md`, `docs/phase-a-doctor-presence.md`, `docs/c1-atomic-call-verification-20261025.md`, `docs/w1-…`, `README.md` | describe the fixed mapping as current | historical records; see §12 for the manuscript |

## 2. Current scheduling architecture (before D1, still the default)

* Registration stores `status = waiting`, `priority_score` (Senior 4, PWD 3, Pregnant 3, Indigenous 2, Solo
  Parent 1, Regular 1) and **no doctor**. The doctor is implied by the service.
* Three per-doctor Weighted-Priority queues: order `priority_score DESC, created_at (ms) ASC, id ASC`.
* Dispatch is **manual Frontdesk**: Patient Management shows each doctor's head with Call Now. (The API also lets
  a doctor account call its own head, which the doctor dashboard does not expose.)
* C1 `call_patient_visit` re-validates under locks (users → all counters → patient) and writes the visit and
  the doctor's counter together; the doctor then Accepts (voice announcement), Starts and Completes.
* W1 Cancel and F5 Requeue release counters by pointer in one transaction.

## 3. Recommended revised architecture

**Model A — one shared Weighted-Priority queue, doctor chosen at Call (recommended, implemented as provisional).**
It is the direct consequence of "any doctor may handle any service": a single priority order is fair across
services (a Senior family-planning visitor is no longer stuck behind a Regular-only lane), all three doctors stay
busy while anyone waits, and it needs no extra per-service policy. Service type is still stored and reported.

Model B (separate service queues, flexible doctors) keeps three priority orders and needs an extra, unstated rule
for *which* service queue a free doctor takes next (round-robin? longest wait? largest?). That rule is itself a
scheduling policy that changes priority across services; without it Model B is not specified. Recommend Model B
only if the administrator wants service-level quotas or specialized rooms.

**Dispatch workflow implemented: manual Frontdesk selection.** Frontdesk calls the head of the shared queue and
selects one of the doctors that are enabled, free and signed in. The backend also accepts doctor-initiated
pickup (a doctor calling the shared head for itself) because the existing API already allows a doctor to call;
no doctor screen exposes it yet. Automated assignment is **not** implemented.

**Flag for approval:** shared vs separate queues (Model A vs B) and manual vs pickup vs automatic dispatch are
operational policy. The code defaults to the existing behavior (`DOCTOR_DISPATCH_MODE=service`); Model A is
active only with `DOCTOR_DISPATCH_MODE=shared` and the D1 function installed.

## 4. Local implementation changes

Backend
* `backend/src/config/env.js`, `backend/.env.example` — `DOCTOR_DISPATCH_MODE` = `service` (default) | `shared`;
  any other value stops the backend.
* `backend/src/services/queueService.js` — `getDispatchMode`, `getRoutedDoctor`, `isSharedCandidate`,
  `getSharedQueueHead` (mirror of the D1 SQL ranking), `resolveSharedCallDoctor`, `assertDoctorSignedIn`
  (Frontdesk/Superadmin may assign only a doctor whose Phase A session is live; a doctor calling for itself is
  proven present by its own session), per-visit and per-doctor in-process call locks, D1 RPC with **no
  two-statement fallback** (503, nothing changed, when D1 is missing), shared-mode ownership/attribution
  (§1), `dispatch_mode` in `GET /queue` and `GET /display`, Call response returns the assigned doctor.
* `backend/src/routes/index.js` — Call response `{ doctor }`; `backend/src/routes/records.js` — shared-mode
  relabel.
* Historical rows are never rewritten: stored `counter_id` always wins; only the *display* of never-called
  visits changes in shared mode.

Frontend: §1 rows for fill-up form, Patient Management, Superadmin dashboard, doctor dashboard, ticket, Queue
Display, Records table. Each screen reads `dispatch_mode` from the backend and behaves exactly as before when it
is `service`.

## 5. New SQL migration

| File | Purpose |
|---|---|
| `backend/scripts/20261029-d1-shared-call.sql` | adds `public.call_patient_visit_shared(BIGINT, TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)`: C1's contract and lock order without the service routing; ranks the shared queue (configured services; unassigned visits plus the calling doctor's own legacy reservation); SECURITY DEFINER, `search_path=''`, `lock_timeout=5s`, EXECUTE for `service_role` only |
| `backend/scripts/20261029-d1-preflight.sql` | read-only; aggregate inventory + 21 PASS checks |
| `backend/scripts/20261029-d1-verify.sql` | read-only; 15 PASS checks incl. body fingerprints: D1 `0ff5318a…`, and C1/W1/F5/Complete unchanged |
| `backend/scripts/20261029-d1-rollback.sql` | drops only the D1 function; refuses on dependents; idempotent |

No table, column, enum, trigger, RLS, grant-on-table or data change. C1, F5 and W1 files are not modified.
Install order (development project only, after approval): preflight → migration → verify → set
`DOCTOR_DISPATCH_MODE=shared` → restart backend. Rollback: unset the mode, restart, run rollback.

## 6. Concurrent Call safety (PostgreSQL 17, real backend, separate connection pools)

* Two calls for the same next patient — doctor pickup by Doctor 1 vs Frontdesk selecting Doctor 2, 5 rounds:
  exactly one 200 every round, one counter pointer, the loser takes no other patient.
* Three doctors pick up concurrently from three backend instances: the three highest-ranked visits, each exactly
  once, one per doctor; a busy doctor cannot take a fourth.
* Database parity: 12 randomized queues (priority mix, legacy reservations) × 3 doctors — the database accepts the
  backend's head and refuses every other waiting visit.
* Invariants after every scenario: no pointer to a non-serving visit, no pointer to another doctor's visit, no
  serving visit without its pointer, no visit with two pointers, no doctor serving twice.

## 7. W1 / F5 regression

* Consultation served by Doctor 3 while Doctor 1 and Doctor 2 serve others: Doctor 1 (old consultation doctor)
  is refused (403); a mismatching requested doctor is refused (409); Doctor 3's W1 cancel releases **only** Doctor
  3's counter; the bystanders are byte-identical; the treating doctor stays on the cancelled visit.
* Frontdesk cancels an uncalled visit while naming a doctor: nothing is stamped (`counter_id` stays empty).
* F5 Requeue returns the visit with no doctor and no call time; any free doctor can then be selected.
* All existing W1, F5, C1, Phase 2.5 cancel and E2E-1 Test B/C/D suites pass unchanged in service mode.

## 8. Frontend tests

`node --test test/*.cjs`: **403 / 403 pass** (394 existing + 9 new: shared Patient Management head/selector,
offline/busy, cancel bodies, shared Undo window, tickets ×2, Queue Display one-list grouping, voice names the
actual doctor/room, Records "Unassigned"). `next build`: success, 14 routes.

## 9. PostgreSQL tests

`backend/test/d1-shared-dispatch-postgres.test.js` (10 tests, PG 17.10): installation sequence; 3 services × 3
doctors full Call → Accept → Re-Call → Start → Complete with voice and SMS naming the actual doctor; Senior
registered after Regular called first by any doctor; concurrency (§6); one doctor completes while two stay busy;
W1/F5 (§7); offline counter, signed-out doctor, unselected/invalid doctor, doctor calling for another doctor —
all refused with nothing changed; registration with only one doctor enabled; Records/Analytics/Transactions
attribute the treating doctor, never the service doctor; historical rows and the Historical Backlog unchanged
(backlog shows "unassigned"); service mode unchanged with D1 installed; shared mode without D1 → 503.
Also `d1-dispatch-config.test.js` (3) and a Records route test.

Full backend suite, PGlite + PG17 enabled (`node --test test/*.test.js`): **1043 tests, 1039 pass, 0 fail,
4 skipped** (voice launcher; `.venv-voice` not installed). Baseline on the same base commit before D1: 1029
tests, 1024 pass, 4 skipped, 1 failure in the known-flaky C1 randomized soak threshold (passed in both D1 runs).
Logs and D1 evidence JSON: `output/d1-flexible-doctor-20261029/` in the main checkout.

## 10. Changes required for WPS Aging (WPS-A, on `feature/e2e1-wps-testing`)

* `call_patient_visit_wps_a` is a twin of C1 and still embeds the service CASE (validation, busy check, ranking).
  Under Model A it needs a shared twin: D1's candidate set (configured services; unassigned or own reservation)
  ranked by WPS-A's effective priority. Recommended shape: one function
  `call_patient_visit_shared_wps_a(…, p_ranked_at)` (or a mode argument), keeping D1's lock order.
* Node: replace the WPS-A head filter `getDoctorForService(...) === doctorName` with `isSharedCandidate`, ranking
  with `compareWps`. Frontend comparators (`PatientQueueTable`, `index.js`, `DoctorAdmin`, `queueTicket`) take the
  shared candidate set from this branch and the WPS-A comparator from that one. Expect merge conflicts there.
* Policy impact: in one shared queue every service competes, so the 10-minute step / +2 cap now trades priority
  *across* services. Re-check starvation of Regular visits with all services pooled, not per doctor.

## 11. Changes required for WRR comparison

* `backend/simulation/engine.js` dispatches by `DOCTOR_FOR_SERVICE` with three per-doctor queues. Under Model A:
  one pooled queue, three identical servers (M/G/3-like), a free doctor takes the policy's next visit. WPS, WPS-A
  and WRR then differ only in *selection* from the pool; WRR's class weights apply to the pooled classes.
* The provisional numbers in `output/e2e-1/20261029-simulation-PROVISIONAL-fixed-mapping/` must not be cited.
  Rerun all six scenarios × 30 replications after the engine change; service mix becomes a workload attribute,
  not a routing rule. Report utilization per doctor and wait by service as well as by priority class.

## 12. Manuscript and diagram revisions (exact changes; manuscript files not modified)

**System requirements** — replace any requirement of the form "Patients for Consultation/Check-up are assigned
to Doctor 1, Prenatal/Maternity to Doctor 2 and Family Planning to Doctor 3" with:
> FR-x. The three City Health doctors are general doctors. Any available doctor may serve any offered service.
> Registration records the service and priority category but assigns no doctor. The doctor is assigned when the
> patient is called and is stored with the visit.
> FR-y. The system keeps one waiting queue ordered by Weighted-Priority Scheduling (priority score, then arrival
> time). Only the head of the queue may be called. A doctor may serve one patient at a time.
> FR-z. Frontdesk calls the next patient and selects an available doctor (counter enabled, not serving, signed in).

**System flowchart** — remove the decision "Service type?" that branches to Doctor 1/2/3 queues after
registration. New flow: Register → Compute priority → Join shared waiting queue → [Frontdesk: Call Now on head,
select available doctor] → Atomic Call (visit + doctor counter) → Doctor Accept (voice) → Start → Complete →
Doctor available. Keep Cancel/Requeue branches; Requeue returns to the shared queue with no doctor.

**Data Flow Diagram** — in the Level-1 DFD, the process "Assign doctor by service" disappears from
Registration; add process "Select available doctor" inside "Call patient", reading Counters (availability,
occupancy) and Staff Sessions (presence), writing Patients.counter_id and Counters.current_patient_id together.

**Use Case Diagram** — "Register Patient" no longer *includes* "Assign Doctor". "Call Patient" (Frontdesk)
*includes* "Select Available Doctor". Doctors are one actor generalization "General Doctor" (Doctor 1–3), not
three specialized actors. Optional extension (pending approval): "Pick Up Next Patient" (General Doctor).

**Database design** — `patients.service_type` = requested service; `patients.counter_id` = *treating doctor,
assigned at Call* (NULL while waiting). `counters.service_types` is descriptive only and no longer routes
patients. No schema change. Add the function `call_patient_visit_shared` to the stored-procedure list.

**Scheduling algorithm description** — replace "each doctor serves a separate priority queue for its services"
with: "All waiting visits form one queue ordered by `priority_score` DESC, registration time ASC, id ASC. When a
doctor is free, the highest-ranked visit is called and assigned to that doctor in one database transaction
(row locks on all counters, then the visit). A concurrent second call for the same visit fails safely."

**WPS Aging design** — state that aging applies to the shared queue (cross-service), per §10.

**WRR comparison methodology** — servers are three identical general doctors drawing from one pool; remove
service-to-doctor routing from the simulation assumptions, per §11.

**Test cases and acceptance criteria** — add: (1) every service completed by each doctor (9 cases); (2) Senior
registered after Regular is called first regardless of service; (3) two simultaneous calls for one visit → one
assignment; (4) three doctors serve three different visits; (5) completing/cancelling one doctor's visit never
changes another doctor; (6) Requeue returns the visit with no doctor; (7) offline or signed-out doctors cannot be
selected; (8) the announcement names the actual doctor and room; (9) Records/Analytics show service and
treating doctor separately. Mark the old "Doctor 2 cannot call a Consultation patient" cases as superseded.

**Chapter 3 (methodology and architecture)** — in the architecture narrative and figures, replace "three
service-specific doctor queues" with "one priority queue shared by three general doctors; doctor assignment at
call time, enforced atomically in PostgreSQL". Note that the fixed mapping was an early design assumption that
the City Health administrator corrected on 2026-10-29.

## 13. Policy questions (need administrator / adviser decision)

1. **Queue model:** approve Model A (one shared queue) — or Model B, and if B, the rule for choosing a service queue.
2. **Dispatch:** manual Frontdesk selection (implemented) vs doctor-initiated pickup vs automatic assignment.
   Should doctors get a "Call next" button?
3. **Clinical scope:** are all five services (incl. prenatal/maternity, family planning procedures) truly within
   every doctor's authorization, or should specific procedures stay with specific doctors? (If yes, the shared
   queue needs per-doctor eligibility; `counters.service_types` could hold it.)
4. **Doctor rights on uncalled visits:** implemented as "Frontdesk/Superadmin only". Should a doctor be able to
   cancel/no-show a visit nobody has called yet?
5. **Records doctor filter:** in shared mode the Phase B.2 Records SQL still matches never-called visits to their
   former service doctor when filtering by doctor (rows are relabelled "Unassigned"). Approve a small Records SQL
   revision, or accept the limitation.
6. **Presence requirement:** Frontdesk may assign only to a signed-in doctor. Confirm.
7. **Historical attribution:** in shared mode, never-called historical visits show "Unassigned" instead of the
   former service doctor (stored assignments unchanged). Confirm for reports.
8. **WPS-A and WRR** under the shared queue (§10, §11), and the D1 install on the development project.

## 14. GO / NO-GO for hosted integration testing

**NO-GO today.** Local evidence supports the design (§6–§9), but hosted testing needs approvals first:
Q1 (queue model), Q2 (dispatch), Q3 (clinical scope), and written approval to install
`20261029-d1-shared-call.sql` on the **development** Supabase project. Then: **conditional GO** — run preflight →
install → verify on the development project, set `DOCTOR_DISPATCH_MODE=shared` only on a separate test backend
(not the adviser demonstration), and repeat the §9 scenarios with synthetic patients. Production stays
`service` mode until the manuscript and the adviser sign off.
