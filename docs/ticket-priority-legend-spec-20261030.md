# Queue ticket: three-level priority legend — specification (draft for adviser approval)

Date: 2026-10-30 · Branch `feature/ticket-priority-legend` (from `main` @ `9c9eb76`, which contains the demo
commit `fe6a028`) · Status: **implemented on the branch, not merged, not in the running demo.** Found missing in
the 2026-10-30 adviser-demo rehearsal (step 5).

## 1. Purpose

Patients sometimes see later arrivals called first. A short legend on every ticket explains that the queue is
ordered by priority, and the patient's own level tells them where they stand, without staff having to explain
Weighted Priority Scheduling at the counter.

## 2. Levels (decision 1)

The level is derived from the **priority score already stored on the visit** (`priority_score`, the number WPS
ranks by), never from the vulnerability flags themselves. Scores follow the live registration rules
(Senior 4, PWD 3, Pregnant 3, Indigenous 2, Solo Parent 1, Regular 1; combinations add).

| Level | Score | Legend text on the ticket | Thermal mark | Pass mark |
|---|---|---|---|---|
| 1 | 3 or more | Senior citizen, PWD, pregnant | `***` | ●●● |
| 2 | 2 | Indigenous Person | `**` | ●●○ |
| 3 | 1 (or missing/0) | Regular, solo parent | `*` | ●○○ |

Notes for approval:

* A combination that reaches 3 (e.g. Indigenous + Solo Parent) is Level 1, because the queue ranks it with
  PWD/Pregnant. The legend names the usual members of each level; it does not list every combination.
* Solo Parent has weight 1, so it shares Level 3 with Regular. If the Health Office wants Solo Parents shown as
  a priority group, its weight (a scheduling change) must change first; the ticket only mirrors the score.
* The level is the level **at registration**. The ticket already says it is a saved snapshot; WPS-A aging (not
  active) would not change the printed level.

## 3. Privacy (decision 2)

The ticket is handed to the patient and may be seen by others in the waiting area. Vulnerability categories
(disability, pregnancy, indigenous origin, age) are personal information, and the current ticket deliberately
shows none of them (tests forbid the priority score on the exported pass).

| Option | What the ticket shows | Disclosure |
|---|---|---|
| A. Legend only | The same three-level legend on every ticket | None about the patient |
| **B. Legend + own level** (implemented default) | Legend, and "Priority: Level n" marked | Level 1 implies Senior/PWD/Pregnant (not which); **Level 2 effectively identifies an Indigenous Person** |
| C. Legend + priority/regular only | Legend, and "Priority lane" or "Regular" | Groups Levels 1 and 2; nothing more specific |

The branch implements **B**, and **A** is one constant away (`SHOW_PATIENT_PRIORITY_LEVEL = false` in
`frontend/lib/queueTicket.js`). C is not implemented. **Recommendation:** approve B only if the Health Office
accepts the Level 2 disclosure (for example, by telling patients at registration); otherwise choose A.
The public Queue Display is unchanged and never shows levels or names.

## 4. Where it appears

| Output | Change |
|---|---|
| Thermal ticket (print) | After "Status": `Priority: Level 1 (***)`; before the footer a small "Priority levels" legend with the three lines above |
| Digital pass (screen) and Download Image (PNG) | New band below the registration/status row: "PRIORITY LEVEL", the patient's level with dots, and the three-line legend. Pass height 820 → 910 px |
| Pass accessibility label | Adds "Priority level n of 3." |
| Ticket data | Adds `priorityLevel` (1, 2 or 3) derived from the score; still no flags, score text, name or other personal data |

## 5. Acceptance criteria

1. Scores 4, 3, 3+ combinations → Level 1; score 2 → Level 2; score 1, 0 or missing → Level 3.
2. Every thermal ticket and pass shows the same legend; with option B the patient's level is marked once.
3. With option A no patient-specific level appears anywhere on the ticket, pass, PNG or label.
4. No vulnerability flag, raw priority score, name, birthdate, PhilHealth ID, mobile number, residency or reason
   appears in the ticket data or any output (existing privacy tests still pass).
5. Inactive (completed/cancelled) reprints keep their "INACTIVE TICKET" marking and still show the legend.
6. Frontend test suite and `next build` pass.

## 6. Out of scope

* The 80 mm page size and browser header/footer (rehearsal issue 3) — separate change.
* Showing levels on the Queue Display or staff screens (staff already see the score).
