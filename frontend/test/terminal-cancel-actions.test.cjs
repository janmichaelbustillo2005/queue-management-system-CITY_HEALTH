// R2.1: Cancel is offered only for active visits. Completed, cancelled and no-show records are
// final; their legal recovery actions are Undo and Re-queue. The backend remains authoritative
// (see backend/test/phase24 and phase25); these checks only keep the UI from offering a
// meaningless or rejected action. Source-level checks so they run without the SWC transform.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8").replace(/\r\n/g, "\n");
const indexPage = read("pages/index.js");
const doctorAdmin = read("components/DoctorAdmin.js");
const queueTable = read("components/PatientQueueTable.js");

test("the Frontdesk/Superadmin queue treats completed, cancelled and no-show as final statuses", () => {
  const declared = indexPage.match(/const TERMINAL_QUEUE_STATUSES = (\[[^\]]*\]);/);
  assert.ok(declared, "TERMINAL_QUEUE_STATUSES is declared");
  const statuses = JSON.parse(declared[1]);
  assert.deepEqual([...statuses].sort(), ["cancelled", "completed", "no-show"]);
  for (const active of ["waiting", "serving"]) assert.ok(!statuses.includes(active), `${active} stays cancellable`);
});

test("the Cancel button is rendered only for active patients and the handler refuses terminal ones before prompting", () => {
  const button = indexPage.indexOf('queueAction("/queue/cancel", patient.id)');
  assert.ok(button > 0);
  const guard = indexPage.lastIndexOf("{!TERMINAL_QUEUE_STATUSES.includes(patient.status) ? (", button);
  assert.ok(guard > 0 && button - guard < 400, "the Cancel button sits inside the active-status guard");
  assert.ok(!/\{!\["completed", "cancelled"\]\.includes\(patient\.status\)/.test(indexPage), "the old guard that omitted no-show is gone");

  const branch = indexPage.indexOf('if (path === "/queue/cancel") {');
  const prompt = indexPage.indexOf("window.prompt(", branch);
  const terminalCheck = indexPage.indexOf("TERMINAL_QUEUE_STATUSES.includes(patient.status)", branch);
  assert.ok(branch > 0 && terminalCheck > branch && terminalCheck < prompt, "terminal statuses are rejected before the reason prompt");
});

test("Undo stays available for recoverable rows on the Frontdesk/Superadmin queue", () => {
  assert.match(indexPage, /queueAction\("\/queue\/undo", patient\.id\)/);
  assert.match(indexPage, /patient\.id === lastActionId && !\(patient\.status === "completed" && patient\.consultation_started_at\)/);
});

test("Doctor dashboard offers Cancel only on active rows and Undo/Re-queue on cancelled or no-show rows", () => {
  const terminal = doctorAdmin.indexOf('(row.status === "no-show" || row.status === "cancelled") && (');
  assert.ok(terminal > 0, "terminal-row branch exists");
  const terminalBranch = doctorAdmin.slice(terminal, terminal + 1800);
  assert.match(terminalBranch, /handleUndo\(row\.id\)/);
  assert.match(terminalBranch, /handleRequeue\(row\.id\)/);
  assert.ok(!/handleCancel/.test(terminalBranch), "no Cancel on terminal rows");
  const activeStart = doctorAdmin.indexOf('row.status === "serving" && canProcessPatient(row)');
  const cancels = [...doctorAdmin.matchAll(/handleCancel\(row\.id\)/g)].map((match) => match.index);
  assert.ok(cancels.length >= 1);
  for (const position of cancels) assert.ok(position > activeStart && position < terminal, "every Cancel is inside the active-row branches");
});

test("Per-doctor queue table offers Cancel only to waiting or serving head rows and Undo/Re-queue to recoverable rows", () => {
  const terminal = queueTable.indexOf('["cancelled", "no-show"].includes(row.status) && doctorStates[doctorName].undoableIds.has(row.id)');
  assert.ok(terminal > 0);
  const end = queueTable.indexOf("return <span", terminal);
  const terminalBranch = queueTable.slice(terminal, end);
  assert.match(terminalBranch, /handleUndo\(row, doctorName\)/);
  assert.match(terminalBranch, /handleRequeue\(row, doctorName\)/);
  assert.ok(!/handleCancel/.test(terminalBranch), "no Cancel on cancelled or no-show rows");
  assert.match(queueTable, /You can only cancel the first patient in/);
});
