// PH1 Doctor Patient History: the page (pages/patient-history.js), the read-only Patient Visit
// Details dialog and their rules (lib/patientHistory.js). Components run in a small hook renderer
// (no DOM); the API is a stub that records every request, so what was asked for is checked directly.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");

const SOURCES = {
  lib: "lib/patientHistory.js", navigation: "lib/navigation.js",
  dialog: "components/PatientVisitDetailsDialog.js", page: "pages/patient-history.js"
};
const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const [name, relative] of Object.entries(SOURCES)) {
    const filename = path.join(__dirname, "..", relative);
    compiled[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

const jsx = (type, props, key) => ({ type, key, props: props || {} });
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach((child) => nodes(child, predicate, found));
  else if (tree && typeof tree === "object" && tree.props) {
    if (predicate(tree)) found.push(tree);
    nodes(tree.props.children, predicate, found);
  }
  return found;
}
function text(tree) {
  if (tree == null || typeof tree === "boolean") return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return text(tree.props?.children);
}
const flat = (tree) => text(tree).replace(/\s+/g, " ");
const byData = (tree, key) => nodes(tree, (node) => Object.hasOwn(node.props, key));

const ACCOUNTS = {
  admin1: { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" },
  admin2: { id_num: "admin2", role: "admin", doctor_name: "Doctor 2" },
  frontdesk: { id_num: "frontdesk", role: "admin", doctor_name: null },
  superadmin: { id_num: "superadmin", role: "superadmin", doctor_name: null }
};

function createRenderer(options = {}) {
  const calls = [];
  const timers = [];
  const instances = new Map();
  const elements = new Map();
  let active;
  let pending = [];
  const css = { __esModule: true, default: new Proxy({}, { get: (_target, key) => (typeof key === "string" ? key : undefined) }) };
  const hook = () => { const index = active.cursor++; return { instance: active, index }; };
  const react = {
    useState(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = instance.hooks[index];
      return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
    },
    useRef(initial) {
      const { instance, index } = hook();
      if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
      return instance.hooks[index];
    },
    useEffect(callback, deps) {
      const { instance, index } = hook();
      const slot = instance.hooks[index];
      if (!slot || !deps || deps.length !== slot.deps.length || deps.some((value, i) => value !== slot.deps[i])) {
        const next = { deps: deps || [], cleanup: slot?.cleanup };
        instance.hooks[index] = next;
        pending.push(() => { next.cleanup?.(); next.cleanup = callback() || undefined; });
      }
    }
  };
  const router = { replaced: [], pushed: [], query: {}, replace(url) { this.replaced.push(url); }, push(url) { this.pushed.push(url); } };
  const auth = { user: ACCOUNTS.admin1, loading: false, ...options.auth };
  const respond = options.respond || (() => ({ error: "No stub", status: 500 }));
  const api = {
    request: async (route, init = {}) => {
      calls.push({ route, method: init.method || "GET" });
      return plain(await respond(route, calls));
    }
  };
  const document = { activeElement: { isConnected: true, focus() {} } };
  // The search debounce runs only when a test fires the timers.
  const setTimeout = (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; };
  const clearTimeout = (timer) => { if (timer) timer.cleared = true; };
  const environment = { console, URLSearchParams, Date, Intl, Math, Number, String, Array, Object, document, setTimeout, clearTimeout };
  const modules = {};
  function load(name) {
    if (modules[name]) return modules[name];
    const module = { exports: {} };
    modules[name] = module.exports;
    vm.runInNewContext(compiled[name], { ...environment, module, exports: module.exports, require(dependency) {
      if (dependency === "react") return react;
      if (dependency === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (dependency.endsWith(".module.css")) return css;
      if (dependency === "../lib/api") return api;
      if (dependency === "../lib/patientHistory") return load("lib");
      if (dependency === "../lib/navigation") return load("navigation");
      if (dependency === "../components/PatientVisitDetailsDialog") return load("dialog");
      if (dependency === "next/router") return { useRouter: () => router };
      if (dependency === "../context/AuthContext") return { useAuth: () => auth };
      if (dependency === "../components/SiteFrame") return { __esModule: true, default: ({ children, title, icon }) => jsx("main", { title, icon, children }) };
      if (isServicesModule(dependency)) return loadServices();
      throw new Error(`Unexpected dependency ${dependency} in ${name}`);
    } });
    modules[name] = module.exports;
    return module.exports;
  }
  function expand(tree, address, seen) {
    if (Array.isArray(tree)) return tree.map((node, index) => expand(node, `${address}/${node?.key ?? index}`, seen));
    if (!tree || typeof tree !== "object") return tree;
    if (typeof tree.type === "function") {
      const key = `${address}:${tree.key ?? ""}`;
      let instance = instances.get(key);
      if (!instance || instance.type !== tree.type) {
        instance = { type: tree.type, hooks: [], cursor: 0 };
        instances.set(key, instance);
      }
      seen.add(key); active = instance; instance.cursor = 0;
      const output = tree.type(tree.props); active = null;
      return expand(output, `${key}/output`, seen);
    }
    if (tree.props.ref && typeof tree.props.ref === "object") {
      if (!elements.has(address)) elements.set(address, { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
      tree.props.ref.current = elements.get(address);
    }
    return { ...tree, props: { ...tree.props, children: expand(tree.props.children, `${address}/c`, seen) } };
  }
  let root = null;
  function render() {
    const seen = new Set();
    const tree = expand(jsx(root.type, root.props), "root", seen);
    for (const [key, instance] of instances) if (!seen.has(key)) {
      instance.hooks.forEach((slot) => slot?.cleanup?.()); instances.delete(key);
    }
    return tree;
  }
  async function settle() {
    for (let round = 0; round < 20; round += 1) {
      render();
      const effects = pending; pending = [];
      effects.forEach((effect) => effect());
      await tick();
      if (!pending.length && !effects.length) break;
    }
    return render();
  }
  async function runTimers() {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    return settle();
  }
  return {
    calls, router, timers, load, settle, runTimers,
    mount(type, props = {}) { root = { type, props }; return settle(); }
  };
}

const row = (id, overrides = {}) => ({
  id, queue_number: `MC-${String(id).padStart(3, "0")}`, patient_name: `Synthetic Patient ${id}`, service_type: "family_planning",
  priority_score: 1, priority_categories: [], visit_date: "2026-11-14", created_at: "2026-11-14T01:00:00.000Z",
  called_at: "2026-11-14T01:10:00.000Z", consultation_started_at: "2026-11-14T01:12:00.000Z", completed_at: "2026-11-14T01:30:00.000Z",
  outcome_at: "2026-11-14T01:30:00.000Z", status: "completed", ...overrides
});
const response = (overrides = {}) => ({
  success: true, doctor: "Doctor 1", doctor_display_name: null, attribution_available: true,
  summary: { total_handled: 18, completed: 15, cancelled: 2, no_show: 1 },
  total: 18, page: 1, page_count: 2, limit: 10, rows: Array.from({ length: 10 }, (_, i) => row(i + 1)), ...overrides
});
// The stub answers from the requested path, like the server: its page and filters.
function serverLike(route) {
  const url = new URL(route, "http://localhost");
  const page = Number(url.searchParams.get("page"));
  const limit = url.searchParams.get("limit");
  if (url.searchParams.get("search") === "nobody") return response({ total: 0, page_count: 1, rows: [] });
  if (limit === "all") return response({ limit: "all", page_count: 1, rows: Array.from({ length: 18 }, (_, i) => row(i + 1)) });
  return response({ page, rows: page === 2 ? Array.from({ length: 8 }, (_, i) => row(i + 11)) : response().rows });
}

async function mountPage(options = {}) {
  const renderer = createRenderer({ respond: serverLike, ...options });
  const page = renderer.load("page").default;
  const tree = await renderer.mount(page);
  return { ...renderer, tree };
}
const buttonByText = (tree, label) => nodes(tree, (node) => node.type === "button" && text(node).trim() === label)[0];
const selectAfterLabel = (tree, label) => nodes(tree, (node) => node.type === "label" && text(node).startsWith(label))
  .flatMap((node) => nodes(node, (child) => child.type === "select" || child.type === "input"))[0];

// ---------- rules ----------

test("requests never name a doctor; empty filters are left out and the search is trimmed", () => {
  const { historyPath, visitDetailsPath, EMPTY_HISTORY_FILTERS } = createRenderer().load("lib");
  assert.equal(historyPath(EMPTY_HISTORY_FILTERS, 1, "10"), "/doctor/patient-history?page=1&limit=10");
  assert.equal(historyPath({ search: "  Maria ", status: "completed", service: "family_planning", from: "2026-11-01", to: "2026-11-14" }, 2, "all"),
    "/doctor/patient-history?search=Maria&status=completed&service=family_planning&from=2026-11-01&to=2026-11-14&page=2&limit=all");
  assert.equal(historyPath({ doctor: "Doctor 2", search: "" }, 0, "7"), "/doctor/patient-history?page=1&limit=10", "no doctor, safe page and size");
  assert.equal(visitDetailsPath(42), "/doctor/patient-history/42");
});

test("pagination shows at most three numbered pages and the filtered range", () => {
  const { historyPageButtons, historyRangeSummary } = createRenderer().load("lib");
  assert.deepEqual(plain(historyPageButtons(1, 1)), [1]);
  assert.deepEqual(plain(historyPageButtons(1, 2)), [1, 2]);
  assert.deepEqual(plain(historyPageButtons(1, 15)), [1, 2, 3]);
  assert.deepEqual(plain(historyPageButtons(7, 15)), [6, 7, 8]);
  assert.deepEqual(plain(historyPageButtons(15, 15)), [13, 14, 15]);
  assert.deepEqual(plain(historyPageButtons(99, 15)), [13, 14, 15]);
  assert.equal(historyRangeSummary({ page: 1, limit: "10", total: 18, rowCount: 10 }), "Showing 1–10 of 18");
  assert.equal(historyRangeSummary({ page: 2, limit: "10", total: 18, rowCount: 8 }), "Showing 11–18 of 18");
  assert.equal(historyRangeSummary({ page: 1, limit: "all", total: 150, rowCount: 150 }), "Showing 1–150 of 150");
  assert.equal(historyRangeSummary({ page: 1, limit: "10", total: 0, rowCount: 0 }), "Showing 0 of 0");
});

test("labels: statuses, priority categories, date range and missing times", () => {
  const lib = createRenderer().load("lib");
  assert.deepEqual(plain(lib.HISTORY_STATUS_OPTIONS.map((option) => option.label)), ["All Statuses", "Completed", "Cancelled by Doctor", "No-show"]);
  assert.equal(lib.priorityLabel([]), "Regular");
  assert.equal(lib.priorityLabel(["senior", "pwd"]), "Senior Citizen, PWD");
  assert.equal(lib.dateRangeError({ from: "2026-11-14", to: "2026-11-01" }), "From Date must not be later than To Date.");
  assert.equal(lib.dateRangeError({ from: "2026-11-14", to: "2026-11-14" }), "");
  assert.equal(lib.formatHistoryTime(null), "Not recorded");
  assert.equal(lib.formatHistoryDate("2026-11-13T17:30:00.000Z"), "Nov 14, 2026", "Manila date, not the browser's");
  assert.deepEqual(plain(lib.HISTORY_PAGE_SIZES.map((size) => size.label)), ["10", "20", "50", "View All"]);
});

// ---------- page ----------

test("a doctor sees the header, four summary cards and its own history table", async () => {
  const { tree, calls } = await mountPage();
  assert.deepEqual(plain(calls.map((call) => call.route)), ["/doctor/patient-history?page=1&limit=10"]);
  assert.equal(tree.props.title, "Patient History");
  const content = flat(tree);
  assert.doesNotMatch(content, /View your completed consultations/, "no in-page heading or subtitle");
  assert.equal(nodes(tree, (node) => node.type === "h2").length, 0);
  assert.deepEqual(plain(byData(tree, "data-history-card").map((card) => flat(card))),
    ["18Total Handled", "15Completed", "2Cancelled", "1No-show"]);
  const headers = nodes(tree, (node) => node.type === "th" && node.props.scope === "col").map(text);
  assert.deepEqual(plain(headers), ["Queue Number", "Patient Name", "Service", "Priority", "Date", "Called At", "Completed At", "Status", "Actions"]);
  const rows = byData(tree, "data-history-row");
  assert.equal(rows.length, 10);
  assert.match(flat(rows[0]), /MC-001Synthetic Patient 1Family planningRegular.*Completed.*View Details/);
  assert.equal(nodes(tree, (node) => node.type === "input" && node.props.placeholder === "Search patient name or queue number...").length, 1);
});

test("Previous, three page buttons and Next follow the server's filtered totals", async () => {
  const page = await mountPage();
  let pager = byData(page.tree, "data-history-pagination")[0];
  assert.match(flat(pager), /Showing 1–10 of 18/);
  assert.match(flat(pager), /Records per page:/);
  assert.deepEqual(plain(nodes(pager, (node) => Object.hasOwn(node.props, "data-page")).map(text)), ["1", "2"]);
  const previous = nodes(pager, (node) => node.props["data-page-nav"] === "previous")[0];
  assert.equal(previous.props.disabled, true, "Previous is disabled on the first page");
  nodes(pager, (node) => node.props["data-page-nav"] === "next")[0].props.onClick();
  const second = await page.settle();
  pager = byData(second, "data-history-pagination")[0];
  assert.equal(page.calls.at(-1).route, "/doctor/patient-history?page=2&limit=10");
  assert.match(flat(pager), /Showing 11–18 of 18/);
  assert.equal(nodes(pager, (node) => node.props["data-page-nav"] === "next")[0].props.disabled, true, "Next is disabled on the last page");
  assert.equal(nodes(pager, (node) => node.props["aria-current"] === "page").map(text)[0], "2");

  // Records per page: View All returns to page 1 and lists everything.
  nodes(pager, (node) => node.type === "select")[0].props.onChange({ target: { value: "all" } });
  const all = await page.settle();
  assert.equal(page.calls.at(-1).route, "/doctor/patient-history?page=1&limit=all");
  assert.equal(byData(all, "data-history-row").length, 18);
});

test("filters and search reset to page 1, combine in one request and debounce typing", async () => {
  const page = await mountPage();
  nodes(byData(page.tree, "data-history-pagination")[0], (node) => node.props["data-page-nav"] === "next")[0].props.onClick();
  let tree = await page.settle();
  selectAfterLabel(tree, "Status").props.onChange({ target: { value: "completed" } });
  tree = await page.settle();
  assert.equal(page.calls.at(-1).route, "/doctor/patient-history?status=completed&page=1&limit=10");
  selectAfterLabel(tree, "Service").props.onChange({ target: { value: "family_planning" } });
  tree = await page.settle();
  selectAfterLabel(tree, "From Date").props.onChange({ target: { value: "2026-11-01" } });
  tree = await page.settle();
  selectAfterLabel(tree, "To Date").props.onChange({ target: { value: "2026-11-14" } });
  tree = await page.settle();
  const before = page.calls.length;
  nodes(tree, (node) => node.type === "input" && node.props.type === "search")[0].props.onChange({ target: { value: "  Maria " } });
  tree = await page.settle();
  assert.equal(page.calls.length, before, "nothing is sent while the doctor is still typing");
  assert.ok(page.timers.some((timer) => timer.delay === 300 && !timer.cleared));
  await page.runTimers();
  assert.equal(page.calls.at(-1).route,
    "/doctor/patient-history?search=Maria&status=completed&service=family_planning&from=2026-11-01&to=2026-11-14&page=1&limit=10");
});

test("no matches, no history, and an invalid date range each say so", async () => {
  const search = await mountPage();
  nodes(search.tree, (node) => node.type === "input" && node.props.type === "search")[0].props.onChange({ target: { value: "nobody" } });
  await search.settle();
  const tree = await search.runTimers();
  assert.match(flat(byData(tree, "data-history-empty")[0]), /No matching patient history found\./);

  const empty = await mountPage({ respond: () => response({ summary: { total_handled: 0, completed: 0, cancelled: 0, no_show: 0 }, total: 0, page_count: 1, rows: [] }) });
  assert.match(flat(byData(empty.tree, "data-history-empty")[0]), /No patient history available yet\./);
  assert.deepEqual(plain(byData(empty.tree, "data-history-card").map((card) => flat(card))),
    ["0Total Handled", "0Completed", "0Cancelled", "0No-show"]);

  const range = await mountPage();
  selectAfterLabel(range.tree, "From Date").props.onChange({ target: { value: "2026-11-14" } });
  let rangeTree = await range.settle();
  const sent = range.calls.length;
  selectAfterLabel(rangeTree, "To Date").props.onChange({ target: { value: "2026-11-01" } });
  rangeTree = await range.settle();
  assert.equal(range.calls.length, sent, "an invalid range is never requested");
  assert.match(flat(rangeTree), /From Date must not be later than To Date\./);
});

test("no database-update notice is shown, even when the PH1 table is not installed", async () => {
  const { tree } = await mountPage({ respond: () => response({ attribution_available: false }) });
  assert.doesNotMatch(flat(tree), /database update|Completed consultations are shown/);
  assert.equal(byData(tree, "data-history-row").length, 10, "the history itself is still shown");
});

test("only doctor accounts stay on the page; others are sent to their own home without a request", async () => {
  for (const [user, home] of [[ACCOUNTS.frontdesk, "/fill-up_form"], [ACCOUNTS.superadmin, "/?section=home"], [null, "/login"]]) {
    const page = await mountPage({ auth: { user } });
    assert.deepEqual(plain(page.router.replaced), [home]);
    assert.equal(page.calls.length, 0);
  }
});

// ---------- View Details ----------

test("View Details opens the read-only modal for the selected visit only", async () => {
  const detail = {
    ...row(7, { status: "cancelled", completed_at: null, outcome_at: "2026-11-14T01:20:00.000Z", called_at: "2026-11-14T01:10:00.000Z" }),
    assigned_doctor: "Doctor 1", assigned_doctor_label: "Dr. Reyes (Doctor 1)", confirmed_at: "2026-11-14T01:05:00.000Z",
    confirmed_by: "frontdesk", reason: "Patient left before consultation",
    outcome_by: { account: "admin1", doctor: "Doctor 1", doctor_label: "Dr. Reyes (Doctor 1)", recorded_at: "2026-11-14T01:20:00.100Z" },
    timeline: [
      { type: "registered", at: "2026-11-14T01:00:00.000Z", label: "Registered in the queue" },
      { type: "confirmed", at: "2026-11-14T01:05:00.000Z", label: "Front Desk confirmed the patient" },
      { type: "called", at: "2026-11-14T01:10:00.000Z", label: "Doctor called the patient" },
      { type: "cancelled", at: "2026-11-14T01:20:00.000Z", label: "Cancelled by the doctor" }
    ]
  };
  const page = await mountPage({ respond: (route) => route.endsWith("/7") ? { success: true, visit: detail } : serverLike(route) });
  const view = nodes(byData(page.tree, "data-history-row").find((node) => node.props["data-history-row"] === 7), (node) => node.type === "button")[0];
  assert.equal(view.props["aria-label"], "View details of visit MC-007");
  view.props.onClick();
  const tree = await page.settle();
  assert.equal(page.calls.at(-1).route, "/doctor/patient-history/7");
  const dialog = nodes(tree, (node) => node.type === "dialog")[0];
  assert.ok(dialog, "the modal is open");
  const content = flat(dialog);
  assert.match(content, /Patient Visit Details/);
  for (const expected of ["MC-007", "Synthetic Patient 7", "Family planning", "Regular", "Dr. Reyes (Doctor 1)",
    "Cancelled by Doctor", "Patient left before consultation", "account admin1", "Registered in the queue",
    "Front Desk confirmed the patient", "Doctor called the patient", "Cancelled by the doctor"]) {
    assert.ok(content.includes(expected), expected);
  }
  const labels = nodes(dialog, (node) => node.type === "dt").map(text);
  for (const label of ["Queue Number", "Patient Name", "Service Requested", "Priority Classification", "Assigned Doctor",
    "Registration Date and Time", "Front Desk Confirmation", "Called Date and Time", "Final Queue Status", "Cancelled By", "Cancellation Reason"]) {
    assert.ok(labels.includes(label), label);
  }
  const timeline = nodes(dialog, (node) => node.type === "li").map(text);
  assert.equal(timeline.length, 4);
  assert.ok(timeline[0].startsWith("Registered") && timeline[3].startsWith("Cancelled"), "in recorded order");
  // Read-only: Close is the only action.
  const actions = nodes(dialog, (node) => node.type === "button").map((node) => node.props["aria-label"] || text(node).trim());
  assert.deepEqual(plain(actions), ["Close", "Close"]);
  assert.doesNotMatch(content, /\b(Edit|Delete|Reassign|Change Status|Cancel Visit)\b/);
  assert.equal(nodes(dialog, (node) => ["input", "select", "textarea", "form"].includes(node.type)).length, 0);
});

test("a completed visit's details show both consultation times; unrecorded ones say Not recorded", async () => {
  const visit = { ...row(3), assigned_doctor: "Doctor 1", assigned_doctor_label: "Doctor 1", confirmed_at: null, confirmed_by: null,
    reason: null, outcome_by: null, timeline: [{ type: "registered", at: "2026-11-14T01:00:00.000Z", label: "Registered in the queue" }] };
  const renderer = createRenderer({ respond: () => ({ success: true, visit }) });
  const Dialog = renderer.load("dialog").default;
  const tree = await renderer.mount(Dialog, { visitId: 3, onClose() {} });
  const details = Object.fromEntries(nodes(tree, (node) => node.type === "div" && nodes(node, (child) => child.type === "dt").length === 1)
    .map((node) => [text(nodes(node, (child) => child.type === "dt")[0]), flat(nodes(node, (child) => child.type === "dd")[0])]));
  assert.equal(details["Front Desk Confirmation"], "Not recorded");
  assert.ok(details["Consultation Started"] && details["Consultation Started"] !== "Not recorded");
  assert.ok(details["Consultation Completed"] && details["Consultation Completed"] !== "Not recorded");
  assert.equal(details["Cancelled By"], undefined, "no cancellation fields on a completed visit");
});
