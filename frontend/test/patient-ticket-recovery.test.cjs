const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const code = {};
before(async () => {
  await swc.loadBindings();
  for (const [name, relative] of Object.entries({
    table: "../components/PatientQueueTable.js",
    management: "../pages/patient-management.js"
  })) {
    const filename = path.join(__dirname, relative);
    code[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

function patient(id, overrides = {}) {
  return { id, id_num: `Patient ${id}`, queue_number: `GP-${String(id).padStart(3, "0")}`,
    service_type: "consultation", counter_id: null, status: "waiting", priority_score: 1,
    created_at: "2026-10-13T01:00:00Z", ...overrides };
}

// Mirrors the shared module's safe-ticket contract; its actual whitelist and
// endpoint implementation are covered by the queue-ticket module tests.
function safeTicket(row) {
  return { patientId: row.id, queueNumber: row.queue_number, serviceLabel: "Consultation",
    doctorName: row.counter_id || "Doctor 1", registeredDate: "13 Oct 2026", registeredTime: "9:00 AM",
    status: row.status, statusLabel: row.status, isActive: ["waiting", "serving"].includes(row.status) };
}

function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) tree.forEach(node => nodes(node, predicate, result));
  else if (tree && typeof tree === "object") {
    if (predicate(tree)) result.push(tree);
    nodes(tree.props?.children, predicate, result);
  }
  return result;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
const buttons = (tree, label) => nodes(tree, node => node.type === "button" && text(node) === label);

function harness(name, options = {}) {
  const hooks = [];
  let cursor = 0;
  const requests = [], retrievals = [];
  const react = {
    useMemo: callback => callback(),
    useCallback: callback => callback,
    useEffect() {},
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    }
  };
  const doctors = [1, 2, 3].map(number => ({ name: `Doctor ${number}`, assignment: "Test services" }));
  const props = { doctors, queueRows: options.rows || [], counters: [], queueSettings: {},
    onRefresh: async () => {}, onNotify: () => {}, onConfirm: () => {}, ...options.props };
  const jsx = (type, props) => ({ type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(code[name], {
    module, exports: module.exports, Set, Map, console, setTimeout: () => 1, clearTimeout: () => {},
    require(dependency) {
      if (dependency === "react") return react;
      if (dependency === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (dependency === "next/router") return { useRouter: () => ({ replace() {} }) };
      if (dependency === "../context/AuthContext") return { useAuth: () => ({
        user: options.user || { id_num: "frontdesk", role: "admin" }, loading: false
      }) };
      if (dependency === "../lib/api") return { request: async (route, init) => {
        requests.push({ route, method: init?.method || "GET" });
        return options.request ? options.request(route, init) : { patients: options.rows || [], counters: [] };
      } };
      if (dependency === "../lib/queueTicket") return {
        createQueueTicket: safeTicket,
        fetchExistingQueueTicket: async id => {
          retrievals.push(id);
          return options.retrieve ? options.retrieve(id) : safeTicket(options.savedPatient || patient(id));
        }
      };
      if (dependency === "../components/PatientQueueTable") return { __esModule: true, default: "PatientQueueTable", DOCTORS: doctors };
      if (dependency === "../components/SettingsModal") return { defaultQueueSettings: {} };
      if (dependency === "../lib/frontdeskNav") return { frontdeskSidebarLinks: () => [] };
      if (dependency === "../lib/queueSettings") return { mergeQueueSettings: value => value, loadLocalQueueSettings: () => ({}), fetchQueueSettings: async () => ({}) };
      if (["../components/SiteFrame", "../components/FrontdeskNavigation", "../components/QueueTicketDialog"].includes(dependency)) {
        return dependency.split("/").pop();
      }
      throw new Error(`Unexpected dependency: ${dependency}`);
    }
  });
  const render = () => { cursor = 0; return module.exports.default(props); };
  const table = () => nodes(render(), node => node.type === "PatientQueueTable")[0];
  const dialog = () => nodes(render(), node => node.type === "QueueTicketDialog")[0];
  return { render, props, requests, retrievals, table, dialog };
}

test("ticket recovery is available for non-head waiting rows without relaxing Call Now priority", async () => {
  const opened = [];
  const rows = [patient(1), patient(2, { priority_score: 4 })];
  const h = harness("table", { rows, props: { onViewTicket: row => opened.push(row.id) } });
  const tickets = buttons(h.render(), "View Ticket");
  assert.equal(tickets.length, 2);
  await tickets[1].props.onClick();
  assert.deepEqual(opened, [1], "lower-priority patient can retrieve an existing ticket");
  assert.equal(buttons(h.render(), "Call Now").length, 1);
  assert.deepEqual(h.requests, [], "viewing does not submit queue mutations");
  assert.equal(rows[0].priority_score, 1);
  assert.equal(rows[0].queue_number, "GP-001");
});

test("completed, cancelled and no-show records expose ticket recovery independently of queue actions", () => {
  for (const status of ["completed", "cancelled", "no-show"]) {
    const row = patient(7, { status, counter_id: "Doctor 1" });
    const h = harness("table", { rows: [row], props: { statusFilter: status, onViewTicket() {} } });
    assert.equal(buttons(h.render(), "View Ticket").length, 1, status);
    assert.equal(buttons(h.render(), "Call Now").length, 0, status);
    assert.equal(h.props.queueRows[0].status, status);
  }
});

test("all and active patient searches recover tickets beyond 20 rows without changing the callable head", async () => {
  const rows = Array.from({ length: 25 }, (_, index) => patient(index + 1));
  rows.push(patient(26, { status: "completed", counter_id: "Doctor 1" }));
  const opened = [];
  const h = harness("table", { rows, props: { statusFilter: "all", onViewTicket: row => opened.push(row.id) } });
  assert.equal(buttons(h.render(), "View Ticket").length, 26);
  assert.equal(buttons(h.render(), "Call Now").length, 1, "existing queue head alone remains callable");
  h.props.search = "GP-025";
  const recovered = buttons(h.render(), "View Ticket");
  assert.equal(recovered.length, 1);
  await recovered[0].props.onClick();
  assert.deepEqual(opened, [25]);
  assert.equal(buttons(h.render(), "Call Now").length, 0);
  assert.deepEqual(h.requests, [], "recovery never registers or changes queue state");
  h.props.statusFilter = "active";
  assert.equal(buttons(h.render(), "View Ticket").length, 1, "active search includes matching patients beyond the first 20 rows");
  assert.equal(buttons(h.render(), "Call Now").length, 0, "finding a lower-priority patient does not make them callable");
});

test("ticket controls stay absent without a staff callback and show disabled loading state", () => {
  assert.equal(buttons(harness("table", { rows: [patient(1)] }).render(), "View Ticket").length, 0);
  const h = harness("table", { rows: [patient(1), patient(2)], props: { onViewTicket() {}, ticketLoadingId: 2 } });
  const pending = buttons(h.render(), "Opening ticket...")[0];
  assert.equal(pending.props.disabled, true);
  assert.equal(pending.props["aria-busy"], true);
  assert.equal(buttons(h.render(), "View Ticket")[0].props.disabled, true);
});

test("Frontdesk reopens the exact saved patient, with no registration or queue mutation", async () => {
  const saved = patient(8, { queue_number: "GP-041", status: "completed", counter_id: "Doctor 2",
    birthdate: "1992-04-01", philhealth_id: "private", address: "private", priority_score: 6 });
  const before = JSON.stringify(saved);
  const h = harness("management", { rows: [saved], savedPatient: saved });
  await h.table().props.onViewTicket(patient(8, { queue_number: "stale" }));
  assert.deepEqual(h.retrievals, [8]);
  assert.equal(h.dialog().props.ticket.queueNumber, "GP-041");
  assert.equal(h.dialog().props.ticket.status, "completed");
  assert.equal(h.dialog().props.ticket.isActive, false);
  assert.doesNotMatch(JSON.stringify(h.dialog().props.ticket), /private|birthdate|priority_score/);
  assert.equal(JSON.stringify(saved), before);
  assert.deepEqual(h.requests, []);
  assert.equal(nodes(h.render(), node => node.type === "FrontdeskNavigation")[0].props.activePath, "/patient-management");
  h.dialog().props.onClose();
  assert.equal(h.dialog(), undefined);
});

test("immediate duplicate ticket clicks produce one retrieval and release loading on completion", async () => {
  let resolve;
  const h = harness("management", { retrieve: () => new Promise(done => { resolve = done; }) });
  const onViewTicket = h.table().props.onViewTicket;
  const first = onViewTicket(patient(3));
  await onViewTicket(patient(3));
  assert.deepEqual(h.retrievals, [3]);
  assert.equal(h.table().props.ticketLoadingId, 3);
  resolve(safeTicket(patient(3)));
  await first;
  assert.equal(h.table().props.ticketLoadingId, null);
  assert.equal(h.dialog().props.ticket.patientId, 3);
});

test("ticket retrieval errors stay actionable and permit retry", async () => {
  let attempt = 0;
  const h = harness("management", { retrieve: async id => {
    if (attempt++ === 0) throw new Error("Saved ticket unavailable");
    return safeTicket(patient(id));
  } });
  await h.table().props.onViewTicket(patient(5));
  assert.equal(h.dialog(), undefined);
  assert.match(text(h.render()), /Saved ticket unavailable/);
  assert.equal(h.table().props.ticketLoadingId, null);
  await h.table().props.onViewTicket(patient(5));
  assert.equal(h.dialog().props.ticket.patientId, 5);
  assert.doesNotMatch(text(h.render()), /Saved ticket unavailable/);
});

test("polling keeps open ticket status current and closes it if the record disappears", async () => {
  const row = patient(9);
  let response = { patients: [{ ...row, status: "completed" }], counters: [] };
  const h = harness("management", { savedPatient: row, request: async () => response });
  await h.table().props.onViewTicket(row);
  await h.table().props.onRefresh();
  assert.equal(h.dialog().props.ticket.status, "completed");
  assert.equal(h.dialog().props.ticket.isActive, false);
  response = { patients: [], counters: [] };
  await h.table().props.onRefresh();
  assert.equal(h.dialog(), undefined);
  assert.match(text(h.render()), /no longer available/);
  assert.ok(h.requests.every(item => item.route === "/queue" && item.method === "GET"));
  assert.equal(row.status, "waiting", "the page never changes the saved record itself");
});

test("an older polling read cannot replace the just-retrieved ticket status", async () => {
  let resolve;
  const h = harness("management", { savedPatient: patient(6, { status: "completed" }),
    request: () => new Promise(done => { resolve = done; }) });
  const pendingPoll = h.table().props.onRefresh();
  await h.table().props.onViewTicket(patient(6));
  resolve({ patients: [patient(6)], counters: [] });
  await pendingPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
});

test("a fresh delivery result invalidates a preceding queue poll for the open ticket", async () => {
  let resolve;
  const h = harness("management", { savedPatient: patient(6),
    request: () => new Promise(done => { resolve = done; }) });
  await h.table().props.onViewTicket(patient(6));
  const pendingPoll = h.table().props.onRefresh();
  h.dialog().props.onTicketUpdate(safeTicket(patient(6, { status: "completed" })));
  resolve({ patients: [patient(6)], counters: [] });
  await pendingPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
  assert.equal(h.dialog().props.ticket.isActive, false);
});

test("delayed delivery updates cannot reopen a closed ticket or replace another patient's ticket", async () => {
  const h = harness("management");
  await h.table().props.onViewTicket(patient(6));
  const previousDialog = h.dialog();
  previousDialog.props.onClose();
  previousDialog.props.onTicketUpdate(safeTicket(patient(6, { status: "completed" })));
  assert.equal(h.dialog(), undefined);
  await h.table().props.onViewTicket(patient(7));
  previousDialog.props.onTicketUpdate(safeTicket(patient(6, { status: "completed" })));
  assert.equal(h.dialog().props.ticket.patientId, 7);
  assert.equal(h.dialog().props.ticket.status, "waiting");
});

test("delivery callbacks reject updates after ticket permission is lost", async () => {
  const user = { id_num: "frontdesk", role: "admin" };
  const h = harness("management", { user });
  await h.table().props.onViewTicket(patient(6));
  const update = h.dialog().props.onTicketUpdate;
  user.id_num = "other";
  h.render();
  update(safeTicket(patient(6, { status: "completed" })));
  user.id_num = "frontdesk";
  h.render();
  assert.equal(h.dialog().props.ticket.status, "waiting", "unauthorized callback did not update cached state");
});

test("an older overlapping queue read cannot restore a waiting ticket after a newer completed result", async () => {
  const reads = [];
  const h = harness("management", { savedPatient: patient(6),
    request: () => new Promise(resolve => { reads.push(resolve); }) });
  await h.table().props.onViewTicket(patient(6));
  const olderPoll = h.table().props.onRefresh();
  const newerPoll = h.table().props.onRefresh();
  reads[1]({ patients: [patient(6, { status: "completed" })], counters: [] });
  await newerPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
  reads[0]({ patients: [patient(6)], counters: [] });
  await olderPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
  assert.equal(h.dialog().props.ticket.isActive, false);
  assert.equal(h.table().props.queueRows[0].status, "completed");
});

test("a stale overlapping refresh error cannot close a ticket verified by the latest queue read", async () => {
  const reads = [];
  const h = harness("management", { savedPatient: patient(6),
    request: () => new Promise(resolve => { reads.push(resolve); }) });
  await h.table().props.onViewTicket(patient(6));
  const olderPoll = h.table().props.onRefresh();
  const newerPoll = h.table().props.onRefresh();
  reads[1]({ patients: [patient(6, { status: "completed" })], counters: [] });
  await newerPoll;
  reads[0]({ error: "Older connection failure" });
  await olderPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
  assert.doesNotMatch(text(h.render()), /Older connection failure/);
});

test("a slow queue read still updates the pass while a newer poll is pending", async () => {
  const reads = [];
  const h = harness("management", { savedPatient: patient(6),
    request: () => new Promise(resolve => { reads.push(resolve); }) });
  await h.table().props.onViewTicket(patient(6));
  const olderPoll = h.table().props.onRefresh();
  const newerPoll = h.table().props.onRefresh();
  reads[0]({ patients: [patient(6, { status: "serving" })], counters: [] });
  await olderPoll;
  assert.equal(h.dialog().props.ticket.status, "serving");
  reads[1]({ patients: [patient(6, { status: "completed" })], counters: [] });
  await newerPoll;
  assert.equal(h.dialog().props.ticket.status, "completed");
});

test("a failed queue status refresh closes the open pass instead of presenting stale validity", async () => {
  const h = harness("management", { request: async () => ({ error: "Queue connection lost" }) });
  await h.table().props.onViewTicket(patient(4));
  await h.table().props.onRefresh();
  assert.equal(h.dialog(), undefined);
  assert.match(text(h.render()), /Queue connection lost/);
});

test("ticket actions are exposed for Frontdesk and Superadmin, but not other accounts", () => {
  for (const user of [{ id_num: "frontdesk", role: "admin" }, { id_num: "superadmin", role: "superadmin" }]) {
    assert.equal(typeof harness("management", { user }).table().props.onViewTicket, "function");
  }
  assert.equal(harness("management", { user: { id_num: "other", role: "admin" } }).table().props.onViewTicket, undefined);
});
