// Live Queue Display, RR1 round robin: one waiting queue per doctor, built from the doctor stored on
// each waiting visit (counter_id) in GET /display's priority order. Renders the real page and its
// waiting view with an injected /display snapshot: no browser, network, voice service or backend.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { isServicesModule, loadServices } = require("./services-module.cjs");

const pagePath = path.join(__dirname, "../pages/queue-display.js");
const source = fs.readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

const COUNTERS = [
  { id: 1, id_num: "Doctor 1", name: "Doctor 1", service_types: ["consultation", "checkup"], is_online: true },
  { id: 2, id_num: "Doctor 2", name: "Doctor 2", service_types: ["prenatal", "maternity"], is_online: true },
  { id: 3, id_num: "Doctor 3", name: "Doctor 3", service_types: ["family_planning"], is_online: true }
];
const waiting = (id, queueNumber, counterId, overrides = {}) => ({
  id, queue_number: queueNumber, service_type: "consultation", status: "waiting", counter_id: counterId, completed_at: null, ...overrides
});
const roundRobin = (extra = {}) => ({
  dispatch_mode: "shared", dispatch_strategy: "round_robin", counters: COUNTERS, all_serving: [], waiting_queue: [], ...extra
});

// The page compiled once; each render gets the given /display snapshot as its display state.
let compiledPage;
async function compilePage() {
  if (compiledPage) return compiledPage;
  const swc = require("next/dist/build/swc");
  await swc.loadBindings();
  compiledPage = (await swc.transform(source, {
    filename: "queue-display-page.js",
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
  return compiledPage;
}

async function renderPage(display) {
  const code = await compilePage();
  const react = {
    useRef: (initial) => ({ current: initial }),
    useState(initial) {
      const isDisplayState = initial && typeof initial === "object" && Object.prototype.hasOwnProperty.call(initial, "waiting_queue");
      return [isDisplayState ? display : initial, () => {}];
    },
    useEffect() {}
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, process: { env: {} },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../lib/api") return { request() { throw new Error("Render must not request backend data"); } };
      if (name === "../components/SettingsModal") return { defaultQueueSettings: {} };
      if (name === "../lib/queueSettings") return { mergeQueueSettings: (raw) => raw, persistLocalQueueSettings() {} };
      if (name === "../lib/announcementRecovery") return {
        readAnnouncementRecovery: (_storage, now) => now, writeAnnouncementRecovery() {}, clearAnnouncementRecovery() {}
      };
      if (name === "../components/SystemLogo") return { default: function SystemLogo() {} };
      if (isServicesModule(name)) return loadServices();
      throw new Error(`Unexpected display dependency: ${name}`);
    }
  });
  const page = module.exports.default();
  // The waiting view is a child component; render it with the props the page gave it.
  const viewNode = nodes(page, (node) => typeof node.type === "function" && node.type.name === "WaitingQueueView")[0];
  assert.ok(viewNode, "the page must mount its waiting view");
  return { page, view: viewNode.type({ ...viewNode.props, visible: true, visit: 1 }) };
}

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach((node) => nodes(node, predicate, found));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) found.push(tree);
    nodes(tree.props?.children, predicate, found);
  }
  return found;
}
const text = (tree) => {
  if (tree == null || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "object") return text(tree.props?.children);
  return String(tree);
};
const hasClass = (node, name) => typeof node.props?.className === "string" && node.props.className.split(/\s+/).includes(name);

// { "Doctor 1": { next, waiting } } from the three serving-card footers.
function servingFooters(page) {
  const cards = nodes(page, (node) => hasClass(node, "queue-serving-card"));
  return Object.fromEntries(cards.map((card) => {
    const title = text(nodes(card, (node) => node.type === "h3")[0]);
    const footer = nodes(card, (node) => hasClass(node, "queue-serving-card-footer"))[0];
    const values = nodes(footer, (node) => node.type === "span").map(text);
    return [title, { next: values[1], waiting: Number(values[3]) }];
  }));
}

// { "Doctor 1": [[position, queue number, status], ...] } from the waiting cards.
function waitingTables(view) {
  const sections = nodes(view, (node) => hasClass(node, "queue-waiting-card"));
  return Object.fromEntries(sections.map((section) => {
    const label = section.props["aria-label"].replace(/ waiting queue$/, "");
    const tbody = nodes(section, (node) => node.type === "tbody")[0];
    const rows = nodes(tbody, (node) => node.type === "tr").map((row) => nodes(row, (node) => node.type === "td").map(text));
    return [label, rows];
  }));
}

test("round robin: each doctor's waiting card lists only its assigned visits, positioned within its own queue", async () => {
  // GET /display order is the backend's WPS/WPS-A order across all doctors.
  const display = roundRobin({ waiting_queue: [
    waiting(106, "GP-106", "Doctor 1"), waiting(107, "FP-107", "Doctor 2", { service_type: "family_planning" }),
    waiting(108, "GP-108", "Doctor 3"), waiting(109, "GP-109", "Doctor 1"), waiting(110, "GP-110", "Doctor 2")
  ] });
  const { view } = await renderPage(display);
  assert.deepEqual(waitingTables(view), {
    "Doctor 1": [["1", "GP-106", "Waiting"], ["2", "GP-109", "Waiting"]],
    "Doctor 2": [["1", "FP-107", "Waiting"], ["2", "GP-110", "Waiting"]],
    "Doctor 3": [["1", "GP-108", "Waiting"]]
  });
  assert.equal(nodes(view, (node) => node.props?.["aria-label"] === "Next Available Doctor waiting queue").length, 0,
    "round robin no longer shows one shared Next Available Doctor list");
  const rooms = nodes(view, (node) => hasClass(node, "queue-waiting-card-header")).map(text);
  assert.deepEqual(rooms, ["Doctor 1MDRoom 1", "Doctor 2MDRoom 2", "Doctor 3MDRoom 3"]);
});

test("round robin: each serving panel's NEXT and WAITING are its own doctor's, never the shared head", async () => {
  const display = roundRobin({ waiting_queue: [
    waiting(106, "GP-106", "Doctor 1"), waiting(107, "FP-107", "Doctor 2"), waiting(108, "GP-108", "Doctor 3"),
    waiting(109, "GP-109", "Doctor 1"), waiting(110, "GP-110", "Doctor 2")
  ] });
  const { page } = await renderPage(display);
  assert.deepEqual(servingFooters(page), {
    "Doctor 1": { next: "GP-106", waiting: 2 },
    "Doctor 2": { next: "FP-107", waiting: 2 },
    "Doctor 3": { next: "GP-108", waiting: 1 }
  });
});

test("round robin: a doctor with no waiting visits shows an empty queue, TBA and 0", async () => {
  const { page, view } = await renderPage(roundRobin({ waiting_queue: [waiting(1, "GP-001", "Doctor 2")] }));
  const tables = waitingTables(view);
  assert.deepEqual(tables["Doctor 1"], []);
  assert.deepEqual(tables["Doctor 3"], []);
  assert.equal(nodes(view, (node) => node.type === "p" && node.props.children === "No Waiting Queue").length, 2);
  assert.deepEqual(servingFooters(page)["Doctor 1"], { next: "TBA", waiting: 0 });
  assert.deepEqual(servingFooters(page)["Doctor 2"], { next: "GP-001", waiting: 1 });
});

test("round robin: a visit appears once; serving, finished, duplicate and unknown-doctor rows stay out", async () => {
  const display = roundRobin({
    all_serving: [{ id: 5, queue_number: "GP-005", counter_id: 1, counter_name: "Doctor 1", status: "serving", service_type: "consultation" }],
    waiting_queue: [
      waiting(1, "GP-001", "Doctor 1"),
      waiting(1, "GP-001", "Doctor 2"),                         // the same visit again: counted once
      waiting(5, "GP-005", "Doctor 1"),                         // being served: not waiting
      waiting(6, "GP-006", "Doctor 2", { status: "completed" }),
      waiting(7, "GP-007", "Doctor 2", { completed_at: "2026-11-14T02:00:00Z" }),
      waiting(8, "GP-008", "Doctor 9"),                         // a doctor this board does not show
      waiting(9, "GP-009", " Doctor 3 ")                        // stored with stray spaces
    ]
  });
  const { page, view } = await renderPage(display);
  const tables = waitingTables(view);
  const shown = Object.values(tables).flat().map((row) => row[1]);
  assert.deepEqual(shown, ["GP-001", "GP-009"]);
  assert.equal(new Set(shown).size, shown.length, "no visit may appear in two doctor queues");
  assert.deepEqual(servingFooters(page), {
    "Doctor 1": { next: "GP-001", waiting: 1 }, "Doctor 2": { next: "TBA", waiting: 0 }, "Doctor 3": { next: "GP-009", waiting: 1 }
  });
});

test("round robin: counter id, id_num or name all identify the assigned doctor (as the doctor dashboard does)", async () => {
  const display = roundRobin({ waiting_queue: [waiting(1, "GP-001", "2"), waiting(2, "GP-002", 3), waiting(3, "GP-003", "Doctor 1")] });
  const { page } = await renderPage(display);
  assert.deepEqual(Object.fromEntries(Object.entries(servingFooters(page)).map(([doctor, footer]) => [doctor, footer.next])),
    { "Doctor 1": "GP-003", "Doctor 2": "GP-001", "Doctor 3": "GP-002" });
});

test("round robin: visits not yet assigned to a doctor are listed apart, in no doctor's queue", async () => {
  const display = roundRobin({ waiting_queue: [
    waiting(1, "GP-001", null), waiting(2, "GP-002", "Doctor 1"), waiting(3, "GP-003", ""), waiting(4, "GP-004", "  ")
  ] });
  const { page, view } = await renderPage(display);
  const notice = nodes(view, (node) => hasClass(node, "queue-waiting-notice"))[0];
  assert.ok(notice, "unassigned visits must stay visible on the board");
  assert.equal(text(nodes(notice, (node) => hasClass(node, "queue-waiting-notice-count"))[0]), "3");
  assert.equal(text(nodes(notice, (node) => hasClass(node, "queue-waiting-notice-numbers"))[0]), "GP-001  ·  GP-003  ·  GP-004");
  assert.deepEqual(waitingTables(view), { "Doctor 1": [["1", "GP-002", "Waiting"]], "Doctor 2": [], "Doctor 3": [] });
  assert.deepEqual(servingFooters(page)["Doctor 2"], { next: "TBA", waiting: 0 });
  // The cards give up the strip's height so the view still fits the measured serving grid.
  const heights = nodes(view, (node) => hasClass(node, "queue-waiting-card")).map((card) => card.props.style.height);
  assert.deepEqual(heights, [408 - 44 - 12, 408 - 44 - 12, 408 - 44 - 12]);

  const { view: allAssigned } = await renderPage(roundRobin({ waiting_queue: [waiting(2, "GP-002", "Doctor 1")] }));
  assert.equal(nodes(allAssigned, (node) => hasClass(node, "queue-waiting-notice")).length, 0, "no strip when every visit has a doctor");
  assert.deepEqual(nodes(allAssigned, (node) => hasClass(node, "queue-waiting-card")).map((card) => card.props.style.height), [408, 408, 408]);
});

test("round robin: a reassignment moves the visit between doctor queues on the next poll, without duplication", async () => {
  const before = roundRobin({ waiting_queue: [waiting(1, "GP-001", "Doctor 1"), waiting(2, "GP-002", "Doctor 1")] });
  const after = roundRobin({ waiting_queue: [waiting(1, "GP-001", "Doctor 3"), waiting(2, "GP-002", "Doctor 1")] });
  assert.deepEqual(servingFooters((await renderPage(before)).page), {
    "Doctor 1": { next: "GP-001", waiting: 2 }, "Doctor 2": { next: "TBA", waiting: 0 }, "Doctor 3": { next: "TBA", waiting: 0 }
  });
  const moved = await renderPage(after);
  assert.deepEqual(servingFooters(moved.page), {
    "Doctor 1": { next: "GP-002", waiting: 1 }, "Doctor 2": { next: "TBA", waiting: 0 }, "Doctor 3": { next: "GP-001", waiting: 1 }
  });
  assert.deepEqual(waitingTables(moved.view), { "Doctor 1": [["1", "GP-002", "Waiting"]], "Doctor 2": [], "Doctor 3": [["1", "GP-001", "Waiting"]] });
});

test("round robin: a Call moves the visit to Now Serving and recalculates only that doctor's NEXT", async () => {
  const queue = [waiting(1, "GP-001", "Doctor 1"), waiting(2, "GP-002", "Doctor 2"), waiting(3, "GP-003", "Doctor 1")];
  const after = roundRobin({
    all_serving: [{ id: 1, queue_number: "GP-001", counter_id: 1, counter_name: "Doctor 1", status: "serving", service_type: "consultation" }],
    waiting_queue: queue.slice(1)
  });
  const { page } = await renderPage(after);
  const doctor1 = nodes(page, (node) => hasClass(node, "queue-serving-card"))[0];
  assert.equal(text(nodes(doctor1, (node) => hasClass(node, "queue-serving-number"))[0]), "GP-001");
  assert.deepEqual(servingFooters(page), {
    "Doctor 1": { next: "GP-003", waiting: 1 }, "Doctor 2": { next: "GP-002", waiting: 1 }, "Doctor 3": { next: "TBA", waiting: 0 }
  });
});

test("D1 shared (without round robin) keeps its single Next Available Doctor list and shared panel counts", async () => {
  const display = { dispatch_mode: "shared", counters: COUNTERS, all_serving: [],
    waiting_queue: [waiting(1, "GP-001", null), waiting(2, "GP-002", null)] };
  const { page, view } = await renderPage(display);
  const cards = nodes(view, (node) => hasClass(node, "queue-waiting-card"));
  assert.deepEqual(cards.map((card) => card.props["aria-label"]), ["Next Available Doctor waiting queue"]);
  assert.equal(nodes(view, (node) => hasClass(node, "queue-waiting-notice")).length, 0);
  for (const footer of Object.values(servingFooters(page))) assert.deepEqual(footer, { next: "GP-001", waiting: 2 });
});

test("service dispatch keeps its service-routed waiting cards and panel counts", async () => {
  const display = { dispatch_mode: "service", counters: COUNTERS, all_serving: [], waiting_queue: [
    waiting(1, "GP-001", null), waiting(2, "OB-002", null, { service_type: "prenatal" }), waiting(3, "FP-003", null, { service_type: "family_planning" })
  ] };
  const { page, view } = await renderPage(display);
  assert.deepEqual(waitingTables(view), {
    "Doctor 1": [["1", "GP-001", "Waiting"]], "Doctor 2": [["1", "OB-002", "Waiting"]], "Doctor 3": [["1", "FP-003", "Waiting"]]
  });
  assert.deepEqual(servingFooters(page), {
    "Doctor 1": { next: "GP-001", waiting: 1 }, "Doctor 2": { next: "OB-002", waiting: 1 }, "Doctor 3": { next: "FP-003", waiting: 1 }
  });
});

test("the waiting board reads only public display fields (no patient names or identifiers)", () => {
  // counter.id_num is the doctor label ("Doctor 1"); a visit row's id_num may hold a patient's name.
  const section = source.slice(source.indexOf("function groupAssignedWaitingQueues("), source.indexOf("const WAITING_NOTICE_HEIGHT"));
  assert.doesNotMatch(section, /\brow\.(?:id_num|patient_name|full_name|mobile_number|birthdate)\b/);
  const notice = source.slice(source.indexOf('className="queue-waiting-notice"'), source.indexOf('<div className="queue-waiting-grid"'));
  assert.match(notice, /row\.queue_number/);
  assert.doesNotMatch(notice, /id_num|patient_name|full_name/);
});
