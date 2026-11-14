// lib/queueView.js: the display, counter and filter rules shared by Front Desk Patient Management
// and Superadmin Queue Management. Read-only helpers: nothing here assigns a doctor or changes a record.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const swc = require("next/dist/build/swc");
const { loadQueueView } = require("./queue-view-module.cjs");

let q;
const plain = (value) => JSON.parse(JSON.stringify(value)); // values from the vm realm
before(async () => { await swc.loadBindings(); q = loadQueueView(); });

const DOCTORS = ["Doctor 1", "Doctor 2", "Doctor 3"];
const row = (overrides) => ({ id: 1, id_num: "Ana Cruz", queue_number: "GP-001", service_type: "consultation",
  status: "waiting", counter_id: null, created_at: "2026-11-10T04:22:00Z", ...overrides });

test("the shown doctor is the assigned doctor, else the service doctor; shared dispatch leaves waiting visits unassigned", () => {
  assert.equal(q.queueDoctorName(row({ counter_id: "Doctor 3" })), "Doctor 3");
  assert.equal(q.queueDoctorName(row({ service_type: "maternity" })), "Doctor 2");
  assert.equal(q.queueDoctorName(row({ service_type: "family_planning" })), "Doctor 3");
  assert.equal(q.queueDoctorName(row({ service_type: "nutrition" })), "Doctor 1", "the backend's default route");
  assert.equal(q.queueDoctorName(row(), true), null);
  assert.equal(q.queueDoctorLabel(null, "waiting"), "Next available");
  assert.equal(q.queueDoctorLabel(null, "cancelled"), "Unassigned");
  const record = row();
  q.queueDoctorName(record);
  assert.equal(record.counter_id, null, "display never assigns a doctor");
});

test("counters count the four statuses from the records, per dispatch mode, and ignore other statuses", () => {
  const rows = [row({ id: 1 }), row({ id: 2, status: "serving", counter_id: "Doctor 1" }),
    row({ id: 3, status: "completed", counter_id: "Doctor 2" }), row({ id: 4, status: "cancelled", counter_id: "Doctor 2" }),
    row({ id: 5, status: "no-show", counter_id: "Doctor 1" }), row({ id: 6, status: "cancelled" })];
  assert.deepEqual(plain(q.countQueueStatuses(rows, DOCTORS)), { waiting: 1, serving: 1, completed: 1, cancelled: 2 });
  assert.deepEqual(plain(q.countQueueStatuses(rows, ["Doctor 2"])), { waiting: 0, serving: 0, completed: 1, cancelled: 1 });
  assert.deepEqual(plain(q.countQueueStatuses(rows, DOCTORS, true)), { waiting: 1, serving: 1, completed: 1, cancelled: 2 });
  assert.deepEqual(plain(q.countQueueStatuses(rows, ["Doctor 1"], true)), { waiting: 1, serving: 1, completed: 0, cancelled: 1 },
    "shared dispatch: the doctor's visits plus the unassigned ones");
  assert.deepEqual(plain(q.countQueueStatuses([], DOCTORS)), { waiting: 0, serving: 0, completed: 0, cancelled: 0 });
});

test("search matches patient name or queue number, case-insensitively; status and doctor filters", () => {
  assert.equal(q.matchesQueueSearch(row(), "  ana "), true);
  assert.equal(q.matchesQueueSearch(row(), "gp-001"), true);
  assert.equal(q.matchesQueueSearch(row(), "OB"), false);
  assert.equal(q.matchesQueueSearch(row(), ""), true);
  assert.equal(q.matchesQueueStatus(row(), "all"), true);
  assert.equal(q.matchesQueueStatus(row(), "serving"), false);
  assert.equal(q.matchesQueueDoctor(row(), "Doctor 1"), true);
  assert.equal(q.matchesQueueDoctor(row(), "Doctor 2"), false);
  assert.equal(q.matchesQueueDoctor(row(), "Doctor 2", true), true, "shared: any doctor may take an unassigned visit");
  assert.equal(q.matchesQueueDoctor(row({ counter_id: "Doctor 3" }), "Doctor 2", true), false);
});

test("badges, priorities and time use one set of styles and the stored timestamp", () => {
  for (const { status, className } of q.QUEUE_STATUS_COUNTERS) assert.equal(q.queueStatusClass(status), className);
  assert.deepEqual(plain(q.QUEUE_STATUS_COUNTERS.map(({ label }) => label)), ["Waiting", "Serving", "Completed", "Cancelled"]);
  assert.match(q.queueStatusClass("no-show"), /red/);
  assert.equal(q.queuePriorityClass(0), null);
  assert.match(q.queuePriorityClass(1), /blue/);
  assert.match(q.queuePriorityClass(3), /yellow/);
  assert.equal(q.formatQueueTime("2026-11-10T04:22:00Z"), new Date("2026-11-10T04:22:00Z").toLocaleTimeString());
  assert.equal(q.formatQueueTime(null), "—");
  assert.equal(q.formatQueueTime("not a date"), "—");
  assert.equal(q.formatQueueDate(undefined), "");
});

// Pagination shared by both tables: 10 records per page over every matching record.
test("paginateQueueRows shows 10 records per page and keeps the page within the records", () => {
  const rows = Array.from({ length: 25 }, (_, i) => i + 1);
  const page = (n) => plain(q.paginateQueueRows(rows, n));
  assert.equal(q.QUEUE_PAGE_SIZE, 10);
  assert.deepEqual(page(1), { rows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], page: 1, pageCount: 3, pageSize: 10, total: 25, first: 1, last: 10 });
  assert.deepEqual(page(2).rows, [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(page(3), { rows: [21, 22, 23, 24, 25], page: 3, pageCount: 3, pageSize: 10, total: 25, first: 21, last: 25 });
  assert.equal(page(9).page, 3, "a page past the end shows the last page");
  assert.equal(page(0).page, 1);
  assert.equal(page(undefined).page, 1);
  assert.deepEqual(plain(q.paginateQueueRows([], 4)), { rows: [], page: 1, pageCount: 1, pageSize: 10, total: 0, first: 0, last: 0 });
  assert.equal(q.paginateQueueRows(rows.slice(0, 10), 1).pageCount, 1, "exactly 10 records fit on one page");
  assert.equal(q.paginateQueueRows(rows.slice(0, 11), 1).pageCount, 2, "the 11th record opens page 2");
});

test("the page summary reads Showing first–last of total", () => {
  assert.equal(q.queuePageSummary(q.paginateQueueRows(Array(25).fill(0), 1)), "Showing 1–10 of 25");
  assert.equal(q.queuePageSummary(q.paginateQueueRows(Array(25).fill(0), 3)), "Showing 21–25 of 25");
  assert.equal(q.queuePageSummary(q.paginateQueueRows([], 1)), "Showing 0 of 0");
});

test("page numbers list every page up to 7, then the ends and the neighbours of the current page", () => {
  assert.deepEqual(plain(q.queuePageItems(1, 1)), [1]);
  assert.deepEqual(plain(q.queuePageItems(2, 7)), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(plain(q.queuePageItems(1, 12)), [1, 2, 3, 4, 5, "gap", 12]);
  assert.deepEqual(plain(q.queuePageItems(6, 12)), [1, "gap", 5, 6, 7, "gap", 12]);
  assert.deepEqual(plain(q.queuePageItems(12, 12)), [1, "gap", 8, 9, 10, 11, 12]);
  assert.deepEqual(plain(q.queuePageItems(4, 12)), [1, 2, 3, 4, 5, "gap", 12], "no gap hides a single page");
  assert.deepEqual(plain(q.queuePageItems(9, 12)), [1, "gap", 8, 9, 10, 11, 12]);
});

test("a page belongs to the filters it was chosen under; changed filters start at page 1", () => {
  const key = q.queuePageKey("all", "Doctor 1", " Ana ");
  assert.equal(key, q.queuePageKey("all", "Doctor 1", "ana"), "search case and surrounding spaces do not reset the page");
  assert.notEqual(key, q.queuePageKey("waiting", "Doctor 1", "ana"));
  assert.equal(q.queueRequestedPage({ key, page: 3 }, key), 3);
  assert.equal(q.queueRequestedPage({ key, page: 3 }, q.queuePageKey("all", "Doctor 1", "ben")), 1);
  assert.equal(q.queueRequestedPage(undefined, key), 1);
});

test("WPS-A: the aging bonus is the backend's effective_priority minus the stored score, for waiting visits only", () => {
  assert.equal(q.isWpsAgingOn({ wps: { aging: true } }), true);
  assert.equal(q.isWpsAgingOn({ wps: { aging: false } }), false);
  assert.equal(q.isWpsAgingOn({}), false, "an older backend without the flag counts as off");
  assert.equal(q.queueAgingBonus(row({ priority_score: 1, effective_priority: 1 })), 0);
  assert.equal(q.queueAgingBonus(row({ priority_score: 1, effective_priority: 2 })), 1);
  assert.equal(q.queueAgingBonus(row({ priority_score: 3, effective_priority: 5 })), 2);
  assert.equal(q.queueAgingBonus(row({ priority_score: 1, effective_priority: 9 })), 2, "never shown above the +2 cap");
  assert.equal(q.queueAgingBonus(row({ priority_score: 4 })), 0, "no effective_priority, no bonus");
  assert.equal(q.queueAgingBonus(row({ status: "serving", priority_score: 1, effective_priority: 3 })), 0);
  assert.equal(q.queueAgingTitle(row({ priority_score: 2, effective_priority: 3 })),
    "Aging bonus +1 (waited 10+ minutes). Ranked as 2 + 1 = 3.");
});
