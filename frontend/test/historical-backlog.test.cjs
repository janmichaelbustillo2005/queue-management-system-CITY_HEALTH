// H1 Stage 1: Historical Waiting Backlog page, review/cancel dialog, shared Records table
// extensions and request rules. Components run in a small hook renderer (no DOM); the API is
// a stub that records every request, so "nothing was sent" is checked directly.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const SOURCES = {
  lib: "lib/historicalBacklog.js", filters: "lib/recordsFilters.js", table: "components/RecordsTable.js",
  filtersComponent: "components/RecordsFilters.js", dialog: "components/BacklogVisitDialog.js", page: "pages/queue-backlog.js"
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
const buttons = (tree, label) => nodes(tree, (node) => node.type === "button" && text(node).trim() === label);
const hasClass = (name) => (node) => String(node.props.className || "").split(/\s+/).includes(name);

// A renderer that runs function components with per-instance hooks, attaches refs to fake
// elements and runs effects after each render (cleanups on unmount or dependency change).
function createRenderer(options = {}) {
  const calls = [];
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
  const auth = { user: { id_num: "superadmin", role: "superadmin" }, loading: false, ...options.auth };
  const respond = options.respond || (() => ({ error: "No stub", status: 500 }));
  const api = {
    request: async (route, init = {}) => {
      const call = { route, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      return plain(await respond(call, calls));
    }
  };
  const document = { activeElement: { isConnected: true, focus() { document.focused = true; } } };
  const window = { addEventListener() {}, removeEventListener() {} };
  const environment = { console, window, URLSearchParams, Date, Intl, setInterval: () => 1, clearInterval: () => {}, setTimeout, clearTimeout, document };
  const modules = {};
  function load(name, extra = {}) {
    if (modules[name]) return modules[name];
    const module = { exports: {} };
    modules[name] = module.exports;
    vm.runInNewContext(compiled[name], { ...environment, module, exports: module.exports, require(dependency) {
      if (dependency === "react") return react;
      if (dependency === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (dependency.endsWith(".module.css")) return css;
      if (dependency === "../lib/api") return api;
      if (dependency === "./recordsFilters" || dependency === "../lib/recordsFilters") return load("filters");
      if (dependency === "../lib/historicalBacklog") return load("lib");
      if (dependency === "./RecordsTable" || dependency === "../components/RecordsTable") return load("table");
      if (dependency === "../components/RecordsFilters") return load("filtersComponent");
      if (dependency === "../components/BacklogVisitDialog") return load("dialog");
      if (dependency === "next/router") return { useRouter: () => router };
      if (dependency === "../context/AuthContext") return { useAuth: () => auth };
      if (dependency === "../components/SiteFrame") return { __esModule: true, default: ({ children, title }) => jsx("main", { title, children }) };
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
      if (!elements.has(address)) {
        elements.set(address, { open: false, showModal() { this.open = true; }, close() { this.open = false; },
          addEventListener() {}, removeEventListener() {}, scrollWidth: 0, clientWidth: 0, scrollLeft: 0, firstElementChild: null });
      }
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
    let tree;
    for (let round = 0; round < 20; round += 1) {
      tree = render();
      const effects = pending; pending = [];
      effects.forEach((effect) => effect());
      await tick();
      if (!pending.length && !effects.length) break;
    }
    return render();
  }
  return {
    calls, router, document, load, settle, render,
    mount(type, props) { root = { type, props }; return settle(); },
    setProps(props) { root = { ...root, props: { ...root.props, ...props } }; return settle(); }
  };
}

const visit = (overrides = {}) => ({
  id: 42, queue_number: "GP-007", patient_name: "Synthetic Patient", service_type: "consultation", status: "waiting",
  doctor: "Doctor 1", doctor_source: "service", priority_score: 1, priority_categories: [],
  created_at: "2026-10-20T01:00:00.000Z", called_at: null, consultation_started_at: null, completed_at: null, reason: null,
  visit_state_revision: "0f8fad5b-d9cb-469f-a165-70867728950e", flags: [], requires_review: false, cancel_blocked: null,
  eligible: true, ineligible_reason: null, ...overrides
});
const FLAGGED = visit({ id: 89, queue_number: "OB-089", doctor: "Doctor 2", doctor_source: "stored", called_at: "2026-09-26T02:05:00.000Z",
  requires_review: true, flags: [{ code: "previously_called", label: "Call recorded", detail: "A call timestamp is stored." },
    { code: "stored_assignment", label: "Doctor assignment stored", detail: "Stores Doctor 2." }] });
const BLOCKED = visit({ id: 7, queue_number: "GP-001", requires_review: true, cancel_blocked: "Doctor 1 still lists this waiting visit.",
  flags: [{ code: "counter_conflict", blocking: true, label: "Doctor counter points at this visit", detail: "Doctor 1 still lists this waiting visit." }] });

// ---------- request and form rules ----------

test("backlog requests carry only the backlog filters, cleaned, with server-side pagination", () => {
  const r = createRenderer();
  const { backlogPath } = r.load("lib");
  const { RECORD_FILTERS } = r.load("filters");
  assert.deepEqual(plain(RECORD_FILTERS.backlog.primary.map((field) => field.key)), ["search", "date", "service", "doctor"]);
  assert.equal(RECORD_FILTERS.backlog.primary[0].label, "Ticket number");
  assert.equal(backlogPath({}, 1), "/queue/backlog?page=1&limit=20");
  assert.equal(backlogPath({ search: " GP-0 ", date: "2026-10-20", service: "prenatal", doctor: "Doctor 2", status: "cancelled" }, 3, 20),
    "/queue/backlog?search=GP-0&date=2026-10-20&service=prenatal&doctor=Doctor+2&page=3&limit=20");
  assert.equal(backlogPath({ service: "dentistry", doctor: "Doctor 9", date: "yesterday" }, 1), "/queue/backlog?page=1&limit=20");
});

test("the cancel form needs a reason, an acknowledgement for flagged visits, and never allows blocked or ineligible visits", () => {
  const { cancelReadiness, MAX_REASON_LENGTH } = createRenderer().load("lib");
  assert.equal(cancelReadiness(null).ready, false);
  assert.match(cancelReadiness(visit(), { reason: "  " }).message, /Enter the reason/);
  assert.match(cancelReadiness(visit(), { reason: "x".repeat(MAX_REASON_LENGTH + 1) }).message, /too long/);
  assert.equal(cancelReadiness(visit(), { reason: "Not served" }).ready, true);
  assert.match(cancelReadiness(FLAGGED, { reason: "Not served" }).message, /reviewed this visit's flagged history/);
  assert.equal(cancelReadiness(FLAGGED, { reason: "Not served", acknowledged: true }).ready, true);
  assert.equal(cancelReadiness(BLOCKED, { reason: "Not served", acknowledged: true }).ready, false);
  assert.match(cancelReadiness(BLOCKED, { reason: "x", acknowledged: true }).message, /Doctor 1 still lists/);
  const gone = visit({ eligible: false, ineligible_reason: "This visit is no longer waiting (current status: serving)." });
  assert.match(cancelReadiness(gone, { reason: "x" }).message, /no longer waiting/);
});

test("the cancel request is pinned to the reviewed revision and acknowledges only flagged visits", () => {
  const { cancelRequest } = createRenderer().load("lib");
  assert.deepEqual(plain(cancelRequest(visit(), { reason: "  Not served  ", acknowledged: true })), {
    path: "/queue/backlog/42/cancel",
    body: { reason: "Not served", expected_revision: "0f8fad5b-d9cb-469f-a165-70867728950e", acknowledge_review: false }
  });
  assert.equal(cancelRequest(FLAGGED, { reason: "x", acknowledged: true }).body.acknowledge_review, true);
});

test("only a successful answer is reported as cancelled; conflicts and unknown outcomes ask for a reload", () => {
  const { cancelOutcome } = createRenderer().load("lib");
  assert.equal(cancelOutcome({ success: true }).kind, "cancelled");
  assert.equal(cancelOutcome({ success: true, already_cancelled: true }).kind, "already");
  const conflict = cancelOutcome({ error: "This visit changed after it was reviewed.", status: 409 });
  assert.deepEqual(plain([conflict.kind, conflict.reload]), ["conflict", true]);
  assert.equal(cancelOutcome({ error: "x", status: 401 }).kind, "session");
  assert.equal(cancelOutcome({ error: "x", status: 403 }).kind, "denied");
  assert.equal(cancelOutcome({ error: "Reason for cancel is required", status: 400 }).kind, "invalid");
  for (const failed of [{ error: "Could not confirm the cancellation.", status: 503 }, { error: "Cannot reach the API." }, undefined]) {
    const outcome = cancelOutcome(failed);
    assert.equal(outcome.kind, "unconfirmed");
    assert.equal(outcome.reload, true);
    assert.match(outcome.message, /Reload the visit/);
  }
});

// ---------- shared Records table ----------

test("the Records table shows review flags in words and several labelled row actions", () => {
  const r = createRenderer();
  const { recordsTable, recordCell } = r.load("table");
  assert.equal(text(recordCell({ flags: [] }, "flags")), "None");
  assert.match(text(recordCell(FLAGGED, "flags")), /^Requires reviewCall recorded · Doctor assignment stored$/);
  assert.match(text(recordCell(BLOCKED, "flags")), /^Cancel blocked/);
  const clicked = [];
  const table = recordsTable({ label: "Historical waiting visits", columns: [["queue_number", "Ticket"], ["flags", "Historical warnings"]],
    rows: [visit(), FLAGGED], actionsHeading: "Actions", actions: [
      { label: "Review visit", icon: "a", describe: (row) => `Review visit ${row.queue_number}`, onClick: (row) => clicked.push(["review", row.id]) },
      { label: "Cancel visit", icon: "b", tone: "danger", describe: (row) => `Cancel visit ${row.queue_number}`, onClick: (row) => clicked.push(["cancel", row.id]) }
    ] });
  const tableNode = nodes(table.props.children, (node) => node.type === "table")[0];
  assert.deepEqual(nodes(tableNode, (node) => node.type === "th" && node.props.scope === "col").map(text), ["Ticket", "Historical warnings", "Actions"]);
  const rowButtons = nodes(tableNode, (node) => node.type === "button");
  assert.deepEqual(rowButtons.map((node) => node.props["aria-label"]), ["Review visit GP-007", "Cancel visit GP-007", "Review visit OB-089", "Cancel visit OB-089"]);
  assert.ok(hasClass("dangerButton")(rowButtons[1]) && !hasClass("dangerButton")(rowButtons[0]));
  // The actions stay pinned at the right edge so they are visible without scrolling sideways.
  assert.ok(nodes(tableNode, (node) => ["th", "td"].includes(node.type) && hasClass("actionCell")(node)).every(hasClass("stickyEnd")));
  rowButtons[3].props.onClick();
  assert.deepEqual(clicked, [["cancel", 89]]);
  // The existing single-action form is unchanged.
  const single = recordsTable({ label: "x", columns: [["queue_number", "Ticket"]], rows: [visit()], action: { heading: "Details", label: "Retrieve ticket", icon: "c", onClick() {} } });
  const singleTable = nodes(single.props.children, (node) => node.type === "table")[0];
  assert.deepEqual(nodes(singleTable, (node) => node.type === "button").map(text), ["Retrieve ticket"]);
  assert.equal(nodes(singleTable, hasClass("stickyEnd")).length, 0, "the Records page layout is unchanged");
  assert.equal(text(nodes(singleTable, (node) => node.type === "th" && node.props.scope === "col").at(-1)), "Details");
});

// ---------- review / cancel dialog ----------

function dialogHarness(current, respond) {
  const events = { closed: 0, changed: [] };
  const r = createRenderer({
    respond: respond || ((call) => (call.method === "GET" ? { success: true, visit: current() } : { success: true }))
  });
  const Dialog = r.load("dialog").default;
  return { r, events, Dialog, props: (mode = "review", id = current().id) => ({
    visitId: id, mode, onClose: () => { events.closed += 1; }, onChanged: (message) => events.changed.push(message)
  }) };
}
const field = (tree, type) => nodes(tree, (node) => node.type === type)[0];

test("Review shows the current stored visit in Manila time; Keep waiting closes without any write", async () => {
  const { r, events, Dialog, props } = dialogHarness(() => FLAGGED);
  const tree = await r.mount(Dialog, props());
  assert.deepEqual(r.calls.map((call) => `${call.method} ${call.route}`), ["GET /queue/backlog/89"]);
  const content = text(tree);
  for (const expected of ["Review historical visit", "OB-089", "Synthetic Patient", "General Consultation", "Doctor 2", "Waiting",
    "Times shown in Manila", "Requires review", "Call recorded.", "Nothing here is repaired automatically"]) {
    assert.ok(content.includes(expected), expected);
  }
  const called = nodes(tree, (node) => node.type === "time" && node.props.dateTime === FLAGGED.called_at)[0];
  assert.equal(text(called), new Date(FLAGGED.called_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" }));
  assert.equal(nodes(tree, (node) => node.type === "time" && node.props.dateTime === null).length, 0);
  assert.match(content, /Consultation startedUnavailable/);
  buttons(tree, "Keep waiting")[0].props.onClick();
  assert.equal(events.closed, 1);
  assert.ok(r.calls.every((call) => call.method === "GET"));
});

test("Cancel requires a typed or explicitly chosen reason and an acknowledgement before submitting the reviewed revision", async () => {
  const { r, events, Dialog, props } = dialogHarness(() => FLAGGED);
  let tree = await r.mount(Dialog, props("cancel"));
  const confirm = () => buttons(r.render(), "Confirm cancellation")[0];
  assert.equal(field(tree, "textarea").props.value, "", "the suggested reason is never pre-filled");
  assert.equal(confirm().props.disabled, true);
  assert.match(text(tree), /Enter the reason/);
  buttons(tree, "Use suggested test reason")[0].props.onClick();
  tree = await r.settle();
  assert.equal(field(tree, "textarea").props.value, "Development test concluded — visit not served.");
  assert.equal(confirm().props.disabled, true, "flagged visits still need the acknowledgement");
  nodes(tree, (node) => node.type === "input" && node.props.type === "checkbox")[0].props.onChange({ target: { checked: true } });
  tree = await r.settle();
  assert.equal(confirm().props.disabled, false);
  assert.ok(r.calls.every((call) => call.method === "GET"), "nothing is submitted until Confirm");
  const form = field(tree, "form");
  await form.props.onSubmit({ preventDefault() {} });
  await r.settle();
  const post = r.calls.find((call) => call.method === "POST");
  assert.deepEqual(post, { route: "/queue/backlog/89/cancel", method: "POST", body: {
    reason: "Development test concluded — visit not served.", expected_revision: FLAGGED.visit_state_revision, acknowledge_review: true } });
  assert.deepEqual(events.changed, ["Visit cancelled. Its registration history was kept."]);
});

test("a visit that changed after review is refused, explained, and can be reloaded before trying again", async () => {
  let current = visit();
  const { r, events, Dialog, props } = dialogHarness(() => current, (call) => (call.method === "GET"
    ? { success: true, visit: current }
    : { error: "This visit changed after it was reviewed. Review it again before cancelling. Nothing was changed.", status: 409 }));
  let tree = await r.mount(Dialog, props("cancel"));
  field(tree, "textarea").props.onChange({ target: { value: "Not served" } });
  tree = await r.settle();
  await field(tree, "form").props.onSubmit({ preventDefault() {} });
  tree = await r.settle();
  assert.deepEqual(events.changed, []);
  assert.match(text(tree), /changed after it was reviewed/);
  current = visit({ status: "serving", eligible: false, ineligible_reason: "This visit is no longer waiting (current status: serving)." });
  buttons(tree, "Reload visit")[0].props.onClick();
  tree = await r.settle();
  assert.deepEqual(r.calls.map((call) => call.method), ["GET", "POST", "GET"]);
  assert.match(text(tree), /no longer waiting \(current status: serving\)/);
  assert.equal(buttons(tree, "Cancel visit…")[0].props.disabled, true);
});

test("an unconfirmed or failed cancel is never shown as success", async () => {
  for (const answer of [{ error: "Could not confirm the cancellation. Refresh the queue before retrying.", status: 503 }, { error: "Cannot reach the API." }]) {
    const { r, events, Dialog, props } = dialogHarness(() => visit(), (call) => (call.method === "GET" ? { success: true, visit: visit() } : answer));
    let tree = await r.mount(Dialog, props("cancel"));
    field(tree, "textarea").props.onChange({ target: { value: "Not served" } });
    tree = await r.settle();
    await field(tree, "form").props.onSubmit({ preventDefault() {} });
    tree = await r.settle();
    assert.deepEqual(events.changed, []);
    assert.match(text(tree), /Reload the visit to see its current status/);
    assert.equal(buttons(tree, "Reload visit").length, 1);
  }
});

test("a blocked anomaly cannot reach the cancel form, and Escape is ignored while submitting", async () => {
  const { r, events, Dialog, props } = dialogHarness(() => BLOCKED);
  let tree = await r.mount(Dialog, props("cancel"));
  assert.equal(field(tree, "form"), undefined);
  assert.match(text(tree), /Cancellation blocked/);
  assert.match(text(tree), /Doctor 1 still lists this waiting visit/);
  assert.equal(buttons(tree, "Cancel visit…")[0].props.disabled, true);
  const dialog = field(tree, "dialog");
  let prevented = false;
  dialog.props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(events.closed, 1, "Escape closes when nothing is in flight");
  assert.ok(r.calls.every((call) => call.method === "GET"));
});

test("a failed visit read shows an error with Retry, never a blank or stale review", async () => {
  let fail = true;
  const { r, Dialog, props } = dialogHarness(() => visit(), () => (fail ? { error: "Historical backlog storage is unavailable. Please retry.", status: 503 } : { success: true, visit: visit() }));
  let tree = await r.mount(Dialog, props("review", 42));
  assert.match(text(tree), /storage is unavailable.*Nothing was changed/);
  assert.equal(buttons(tree, "Cancel visit…").length, 0);
  fail = false;
  buttons(tree, "Retry")[0].props.onClick();
  tree = await r.settle();
  assert.match(text(tree), /GP-007/);
});

// ---------- page ----------

function pageHarness(respond, auth) {
  const r = createRenderer({ respond, auth });
  return { r, Page: r.load("page").default };
}
const LIST = { success: true, business_date: "2026-10-27", registered_before: "2026-10-26T16:00:00.000Z", total_backlog: 21,
  requires_review: 1, truncated: false, total: 2, page: 1, limit: 20, rows: [visit(), FLAGGED] };

test("Superadmin sees the backlog count, explanation, filters and rows from the server", async () => {
  const { r, Page } = pageHarness(() => LIST);
  const tree = await r.mount(Page, {});
  assert.deepEqual(r.calls.map((call) => call.route), ["/queue/backlog?page=1&limit=20"]);
  const content = text(tree);
  assert.match(content, /Historical Waiting Backlog/);
  assert.match(content, /21historical waiting visits · 1 requires review/);
  assert.match(content, /registered before today \(Manila time, 2026-10-27\)/);
  assert.match(content, /not counted in today's registrations/);
  assert.deepEqual(nodes(tree, (node) => node.type === "label" && String(node.props.htmlFor || "").startsWith("records-filter-backlog-"))
    .map((node) => text(node).replace("Manila", "")), ["Ticket number", "Registration date", "Service", "Assigned doctor"]);
  assert.equal(buttons(tree, "Review visit").length, 2);
  assert.equal(buttons(tree, "Cancel visit").length, 2);
  assert.equal(buttons(tree, "Cancel All").length + buttons(tree, "Bulk cancel").length, 0, "no bulk actions in Stage 1");
});

test("filters are applied server-side and the Cancel action opens the confirmation dialog for that visit", async () => {
  const { r, Page } = pageHarness((call) => (call.route.startsWith("/queue/backlog?") ? LIST : { success: true, visit: FLAGGED }));
  let tree = await r.mount(Page, {});
  nodes(tree, (node) => node.type === "select" && node.props.id === "records-filter-backlog-service")[0].props.onChange({ target: { value: "prenatal" } });
  tree = await r.settle();
  nodes(tree, (node) => node.type === "form" && node.props.role === "search")[0].props.onSubmit({ preventDefault() {} });
  tree = await r.settle();
  assert.equal(r.calls.at(-1).route, "/queue/backlog?service=prenatal&page=1&limit=20");
  buttons(tree, "Cancel visit")[1].props.onClick();
  tree = await r.settle();
  assert.equal(r.calls.at(-1).route, "/queue/backlog/89");
  assert.match(text(tree), /Cancel historical visit/);
  assert.equal(nodes(tree, (node) => node.type === "form" && node.props.role !== "search").length, 1);
});

test("a completed cancellation closes the dialog, shows a notice and refreshes the count from the server", async () => {
  let total = 21;
  const { r, Page } = pageHarness((call) => {
    if (call.method === "POST") { total -= 1; return { success: true }; }
    if (call.route.startsWith("/queue/backlog?")) return { ...LIST, total_backlog: total };
    return { success: true, visit: visit() };
  });
  let tree = await r.mount(Page, {});
  buttons(tree, "Cancel visit")[0].props.onClick();
  tree = await r.settle();
  nodes(tree, (node) => node.type === "textarea")[0].props.onChange({ target: { value: "Not served" } });
  tree = await r.settle();
  await nodes(tree, (node) => node.type === "form" && node.props.role !== "search")[0].props.onSubmit({ preventDefault() {} });
  tree = await r.settle();
  assert.equal(nodes(tree, (node) => node.type === "dialog").length, 0);
  assert.match(text(tree), /Visit cancelled\. Its registration history was kept\./);
  assert.match(text(tree), /20historical waiting visits/);
  assert.equal(r.calls.filter((call) => call.method === "POST").length, 1);
});

test("failures are explained instead of shown as an empty backlog, and the empty backlog says so", async () => {
  let answer = { error: "Historical backlog storage is unavailable. Please retry.", status: 503 };
  const { r, Page } = pageHarness(() => answer);
  let tree = await r.mount(Page, {});
  assert.match(text(tree), /Backlog storage unavailable/);
  assert.match(text(tree), /Backlog count unavailable/);
  assert.doesNotMatch(text(tree), /No historical waiting visits/);
  answer = { ...LIST, rows: [], total: 0, total_backlog: 0, requires_review: 0 };
  buttons(tree, "Retry")[0].props.onClick();
  tree = await r.settle();
  assert.match(text(tree), /No historical waiting visits\. Every waiting patient registered today\./);
});

test("Doctor and Frontdesk accounts are sent away without requesting the backlog", async () => {
  for (const user of [{ id_num: "admin1", role: "admin", doctor_name: "Doctor 1" }, { id_num: "frontdesk", role: "admin", doctor_name: null }, null]) {
    const { r, Page } = pageHarness(() => LIST, { user });
    const tree = await r.mount(Page, {});
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.router.replaced, ["/login"]);
    assert.match(text(tree), /Loading authorized backlog/);
  }
});
