// One set of queue records rendered by both Front Desk Patient Management
// (patient-queue-call.test.cjs) and Superadmin Queue Management (superadmin-queue.test.cjs).
// Both tests compare each table's non-action cells with the same expected values, so the same
// record must read the same on both pages. Actions are deliberately excluded.

const HEADERS = ["Queue", "Patient Info", "Doctor", "Service", "Priority", "Status", "Time", "Actions"];

function base(id, overrides) {
  return {
    id, id_num: `Patient ${id}`, queue_number: `Q-${id}`, service_type: "consultation", status: "waiting",
    priority_score: 1, effective_priority: 1, created_at: "2026-11-10T04:22:00Z", counter_id: null,
    called_at: null, accepted_at: null, consultation_started_at: null, completed_at: null,
    awaiting_accept: false, vulnerability_flags: [], confirmed_at: "2026-11-10T04:22:30Z", confirmed_by: "frontdesk", ...overrides
  };
}

// The record from the requirement's example, plus one waiting and one serving visit.
const ROWS = [
  base(43, { id_num: "Test", queue_number: "OB-043", service_type: "maternity", priority_score: 3, effective_priority: 3,
    status: "cancelled", counter_id: "Doctor 2", completed_at: "2026-11-10T04:30:00Z", sex: "Female",
    birthdate: "1990-05-01", residency: "Barangay 1, Test City" }),
  base(7, { id_num: "Waiting Person", queue_number: "GP-007", sex: "Male", birthdate: "1950-01-02",
    mobile_number: "9123456789", philhealth_id: "PH-0001", residency: "Barangay 2, Test City",
    priority_score: 4, effective_priority: 4, created_at: "2026-11-10T01:05:00Z" }),
  base(8, { id_num: "Serving Person", queue_number: "GP-008", status: "serving", counter_id: "Doctor 1",
    called_at: "2026-11-10T01:10:00Z", accepted_at: "2026-11-10T01:11:00Z", created_at: "2026-11-10T01:00:00Z", priority_score: 0, effective_priority: 0 })
];

const COUNTS = { waiting: 1, serving: 1, completed: 0, cancelled: 1 };

const squash = (value) => String(value).replace(/\s+/g, "");
const date = (value) => new Date(value).toLocaleDateString();

// Expected non-action cells, whitespace removed (icons render no text).
const EXPECTED = {
  "OB-043": { queue: "OB-043", patient: squash(`Test Registered ${date("2026-11-10T04:22:00Z")} Female ${date("1990-05-01")} Barangay 1, Test City`),
    doctor: "Doctor2", service: "Maternity", priority: "3", status: "cancelled", time: new Date("2026-11-10T04:22:00Z").toLocaleTimeString() },
  "GP-007": { queue: "GP-007", patient: squash(`Waiting Person Registered ${date("2026-11-10T01:05:00Z")} Male ${date("1950-01-02")} 9123456789 PH-0001 Barangay 2, Test City`),
    doctor: "Doctor1", service: "General Consultation", priority: "4", status: "waiting", time: new Date("2026-11-10T01:05:00Z").toLocaleTimeString() },
  "GP-008": { queue: "GP-008", patient: squash(`Serving Person Registered ${date("2026-11-10T01:00:00Z")}`),
    doctor: "Doctor1", service: "General Consultation", priority: "—", status: "serving", time: new Date("2026-11-10T01:00:00Z").toLocaleTimeString() }
};

// Reads the seven information cells of a table row; `text` and `nodes` are each test's helpers.
function readCells(tr, { text, nodes }) {
  const cells = nodes(tr.props.children, (node) => node.type === "td");
  const firstSpan = (td) => nodes(td, (node) => node.type === "span")[0];
  return {
    queue: text(firstSpan(cells[0])),
    patient: squash(text(cells[1])),
    doctor: squash(text(cells[2])),
    service: text(firstSpan(cells[3])),
    priority: squash(text(cells[4])),
    status: text(firstSpan(cells[5])),
    time: text(cells[6])
  };
}

module.exports = { HEADERS, ROWS, COUNTS, EXPECTED, readCells };
