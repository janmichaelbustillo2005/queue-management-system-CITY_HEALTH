const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const relative of ["components/RecordsTable.js", "lib/recordsFilters.js"]) {
    const filename = path.join(__dirname, "..", relative);
    compiled[relative] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
});

const jsx = (type, props) => ({ type, props: props || {} });
const css = new Proxy({}, { get: (_target, key) => key === "__esModule" || typeof key === "symbol" ? undefined : key });
const cssSource = fs.readFileSync(path.join(__dirname, "../components/RecordsTable.module.css"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, predicate, found));
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
const hasClass = name => node => String(node.props.className || "").split(/\s+/).includes(name);

function hookRuntime() {
  const hooks = [], dependencies = [], cleanups = [], pending = [];
  let cursor = 0;
  return {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
        return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
      },
      useRef(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; },
      useEffect(callback, deps) {
        const index = cursor++, previous = dependencies[index];
        if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
          dependencies[index] = deps;
          pending.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
        }
      }
    },
    reset() { cursor = 0; },
    flush() { pending.splice(0).forEach(effect => effect()); }
  };
}

function loadTable(react = hookRuntime().react, globals = {}) {
  const lib = { exports: {} };
  vm.runInNewContext(compiled["lib/recordsFilters.js"], { module: lib, exports: lib.exports, URLSearchParams, Date });
  const module = { exports: {} };
  vm.runInNewContext(compiled["components/RecordsTable.js"], { module, exports: module.exports, Date, ...globals, require(name) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "./RecordsTable.module.css") return css;
    if (name === "../lib/recordsFilters") return lib.exports;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  return module.exports;
}

// --- Pagination footer --------------------------------------------------------

function footer(overrides = {}) {
  const calls = [];
  const tree = loadTable().recordsPagination({
    page: 1, total: 45, limit: 20, rowCount: 20, busy: false, failed: false,
    onPrevious: () => calls.push("previous"), onNext: () => calls.push("next"), onRefresh: () => calls.push("refresh"),
    ...overrides
  });
  const button = label => nodes(tree, node => node.type === "button" && text(node).trim() === label)[0];
  return { tree, calls, button, summary: text(nodes(tree, node => node.props.role === "status")[0]),
    indicator: text(nodes(tree, node => node.props["aria-current"] === "page")[0]) };
}

test("the footer shows real buttons with icons, a page indicator and a polite live summary", () => {
  const { tree, button, summary, indicator, calls } = footer();
  const pager = nodes(tree, node => node.type === "nav")[0];
  assert.equal(pager.props["aria-label"], "Records pages");
  assert.deepEqual(plain(nodes(pager, node => node.type === "button").map(node => text(node).trim())), ["Previous", "Next", "Refresh"]);
  for (const label of ["Previous", "Next", "Refresh"]) {
    assert.equal(button(label).props.type, "button");
    assert.ok(hasClass("pagerButton")(button(label)), `${label} uses the bordered button style`);
    assert.equal(nodes(button(label), node => node.type === "i")[0].props["aria-hidden"], "true");
  }
  assert.ok(nodes(button("Previous"), node => node.type === "i" && /chevron-left/.test(node.props.className)).length);
  assert.ok(nodes(button("Next"), node => node.type === "i" && /chevron-right/.test(node.props.className)).length);
  assert.ok(nodes(button("Refresh"), node => node.type === "i" && /sync-alt/.test(node.props.className)).length);
  assert.equal(summary, "Showing 1–20 of 45 records");
  assert.equal(indicator, "Page 1 of 3");
  assert.equal(nodes(tree, node => node.props.role === "status")[0].props["aria-live"], "polite");
  assert.match(text(tree), /Times shown in Manila/);
  button("Next").props.onClick(); button("Refresh").props.onClick();
  assert.deepEqual(calls, ["next", "refresh"]);
});

test("Previous is disabled on the first page and Next on the last page the server's total allows", () => {
  const first = footer();
  assert.equal(first.button("Previous").props.disabled, true);
  assert.equal(first.button("Next").props.disabled, false);
  const middle = footer({ page: 2, rowCount: 20 });
  assert.equal(middle.summary, "Showing 21–40 of 45 records");
  assert.equal(middle.button("Previous").props.disabled, false);
  assert.equal(middle.button("Next").props.disabled, false);
  const last = footer({ page: 3, rowCount: 5 });
  assert.equal(last.summary, "Showing 41–45 of 45 records");
  assert.equal(last.indicator, "Page 3 of 3");
  assert.equal(last.button("Next").props.disabled, true);
  const exact = footer({ total: 40, page: 2, rowCount: 20 });
  assert.equal(exact.button("Next").props.disabled, true, "40 records at 20 per page is exactly two pages");
  const single = footer({ total: 5, rowCount: 5 });
  assert.equal(single.summary, "Showing 1–5 of 5 records");
  assert.equal(single.indicator, "Page 1 of 1");
  assert.equal(single.button("Next").props.disabled, true);
  assert.equal(footer({ total: 1, rowCount: 1 }).summary, "Showing 1–1 of 1 record");
});

test("while a request runs every control is disabled, so fast clicks cannot queue conflicting pages", () => {
  const refreshing = footer({ page: 2, busy: true });
  assert.equal(refreshing.summary, "Refreshing records…");
  for (const label of ["Previous", "Next", "Refresh"]) assert.equal(refreshing.button(label).props.disabled, true, label);
  assert.ok(nodes(refreshing.button("Refresh"), node => node.type === "i" && /\bspin\b/.test(node.props.className)).length);
  const loading = footer({ busy: true, rowCount: 0 });
  assert.equal(loading.summary, "Loading records…");
  assert.equal(loading.indicator, "Page 1", "no page count before the server has answered");
});

test("a failed request shows no counts or page totals and offers no Next page", () => {
  const failed = footer({ page: 2, failed: true, total: 0, rowCount: 0 });
  assert.equal(failed.summary, "Results unavailable");
  assert.equal(failed.indicator, "Page 2");
  assert.equal(failed.button("Next").props.disabled, true);
  assert.equal(failed.button("Previous").props.disabled, false, "the user can still step back");
  assert.equal(failed.button("Refresh").props.disabled, false);
  assert.equal(footer({ total: 0, rowCount: 0 }).summary, "0 records");
  assert.equal(footer({ page: 4, total: 45, rowCount: 0 }).summary, "No records on this page · 45 records in total");
});

// --- Tables -------------------------------------------------------------------

const patientColumns = [["patient_name", "Patient"], ["queue_number", "Ticket"], ["service_type", "Service"], ["doctor", "Assigned doctor"],
  ["priority_score", "Priority score"], ["status", "Status"], ["created_at", "Registered"], ["called_at", "Called"],
  ["consultation_started_at", "Consultation started"], ["completed_at", "Completed / cancelled"]];
const identityColumns = [["id", "Account / staff ID"], ["display_name", "Display name"], ["role", "Stored role"], ["position", "Position"],
  ["doctor", "Assigned doctor / counter"], ["account_status", "Account status"], ["online", "Presence"], ["authenticated", "Authentication"],
  ["last_login", "Last login"], ["last_seen", "Last seen"], ["created_at", "Account created"]];
const at = "2026-10-23T02:15:00.000Z";

function render(label, columns, rows, extra = {}) {
  const calls = [];
  const tree = loadTable().recordsTable({ label, columns, rows, ...extra,
    action: extra.action === false ? undefined : { heading: "Details", label: "Activity", icon: "fas fa-history", onClick: row => calls.push(row.id) } });
  const table = nodes(tree, node => node.type === "table")[0];
  const body = nodes(table, node => node.type === "tbody")[0];
  const cellsOf = row => nodes(row, node => ["td", "th"].includes(node.type)).map(text);
  return { tree, table, calls, rows: nodes(body, node => node.type === "tr"), cellsOf,
    headers: nodes(nodes(table, node => node.type === "thead")[0], node => node.type === "th") };
}
const indicators = tree => plain(nodes(tree, hasClass("indicator")).map(node => [node.props.className.split(" ")[1], text(node)]));

test("Patient Records keeps every column and shows queue status as a labelled indicator", () => {
  const view = render("Patient Records", patientColumns, [
    { id: 1, patient_name: "Synthetic Patient", queue_number: "FP-001", service_type: "family_planning", doctor: "Doctor 3", doctor_source: "assigned",
      priority_score: 4, status: "serving", created_at: at, called_at: at, consultation_started_at: null, completed_at: null },
    { id: 2, patient_name: "Second Synthetic", queue_number: "GP-002", service_type: "consultation", doctor: "Doctor 1", doctor_source: "service",
      priority_score: 1, status: "no-show", created_at: at, called_at: null, consultation_started_at: null, completed_at: at }
  ]);
  assert.deepEqual(plain(view.headers.map(text)), [...patientColumns.map(([, label]) => label), "Details"]);
  assert.ok(view.headers.every(header => header.props.scope === "col"));
  assert.equal(text(nodes(view.table, node => node.type === "caption")[0]), "Patient Records");
  const [first, second] = view.rows;
  assert.equal(nodes(first, node => node.type === "th")[0].props.scope, "row", "the patient name labels its row");
  assert.deepEqual(plain(view.cellsOf(first).slice(0, 6)), ["Synthetic Patient", "FP-001", "Family Planning", "Doctor 3", "4", "Being served"]);
  assert.equal(view.cellsOf(second)[3], "Doctor 1 (by service)");
  assert.equal(view.cellsOf(second)[7], "Unavailable", "a missing timestamp says so");
  assert.deepEqual(indicators(view.tree), [["blue", "Being served"], ["gray", "No-show"]]);
  const time = nodes(first, node => node.type === "time")[0];
  assert.equal(time.props.dateTime, at);
  const priority = nodes(first, node => node.type === "td")[3];
  assert.ok(hasClass("numeric")(priority), "numbers are right-aligned");
});

test("each queue status has its own indicator with an icon and words", () => {
  const statuses = ["waiting", "serving", "completed", "cancelled", "no-show"];
  const view = render("Patient Records", [["queue_number", "Ticket"], ["status", "Status"]],
    statuses.map((status, id) => ({ id, queue_number: `Q-${id}`, status })), { action: false });
  assert.deepEqual(indicators(view.tree), [["amber", "Waiting"], ["blue", "Being served"], ["green", "Completed"], ["red", "Cancelled"], ["gray", "No-show"]]);
  assert.ok(nodes(view.tree, hasClass("indicator")).every(node => nodes(node, child => child.type === "i").length === 1));
  const unknown = render("Patient Records", [["queue_number", "Ticket"], ["status", "Status"]], [{ id: 1, queue_number: "Q", status: "archived" }], { action: false });
  assert.equal(unknown.cellsOf(unknown.rows[0])[1], "archived", "an unexpected value is shown as stored");
});

test("User Accounts and Staff Records keep account status, presence and authentication separate", () => {
  const rows = [
    { id: "superadmin", display_name: "superadmin", role: "superadmin", position: "Super Admin", doctor: null, account_status: "Enabled (existing account)",
      online: true, authenticated: true, last_login: at, last_seen: at, created_at: null, password: "hash", token: "jwt" },
    { id: "frontdesk", display_name: "frontdesk", role: "admin", position: "Frontdesk", doctor: null, account_status: "Enabled (existing account)",
      online: false, authenticated: false, last_login: null, last_seen: null, created_at: null }
  ];
  for (const label of ["User Accounts", "Staff Records"]) {
    const view = render(label, identityColumns, rows);
    assert.deepEqual(plain(view.headers.map(text)), [...identityColumns.map(([, heading]) => heading), "Details"]);
    assert.deepEqual(indicators(view.tree), [
      ["neutral", "Enabled (existing account)"], ["green", "Online"], ["teal", "Active session"],
      ["neutral", "Enabled (existing account)"], ["gray", "Offline"], ["neutral", "No active session"]
    ]);
    assert.doesNotMatch(text(view.tree), /Disabled|hash|jwt|password/i, "offline is not disabled, and secrets are never columns");
    assert.equal(view.cellsOf(view.rows[1])[10], "Not recorded", "no stored creation date");
    assert.equal(view.cellsOf(view.rows[1])[4], "Unavailable");
    const action = nodes(view.rows[0], node => node.type === "button")[0];
    assert.equal(action.props.type, "button");
    action.props.onClick();
    assert.deepEqual(view.calls, ["superadmin"]);
    assert.equal(nodes(view.rows[0], node => node.props.onClick && node.type !== "button").length, 0, "rows themselves are not clickable");
  }
});

test("empty tables keep their headers and span the message across every column", () => {
  const view = render("User Accounts", identityColumns, [], { emptyMessage: "No records match the applied filters." });
  assert.equal(view.rows.length, 1);
  const cell = nodes(view.rows[0], node => node.type === "td")[0];
  assert.equal(cell.props.colSpan, identityColumns.length + 1);
  assert.equal(text(cell), "No records match the applied filters.");
});

// --- Horizontal overflow ---------------------------------------------------------

function mountScroll(size) {
  const runtime = hookRuntime();
  const listeners = {};
  const element = { ...size, firstElementChild: {}, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener() {} };
  const { TableScroll } = loadTable(runtime.react, { window: { addEventListener() {}, removeEventListener() {} } });
  const render = () => {
    runtime.reset();
    const tree = TableScroll({ label: "User Accounts", children: "table" });
    nodes(tree, node => node.props.ref)[0].props.ref.current = element;
    runtime.flush();
    runtime.reset();
    return TableScroll({ label: "User Accounts", children: "table" });
  };
  return { element, listeners, render };
}

test("the sideways-scroll hint and edge fade appear only when columns are actually hidden", () => {
  const fits = mountScroll({ scrollWidth: 900, clientWidth: 900, scrollLeft: 0 });
  let tree = fits.render(); tree = fits.render();
  assert.equal(nodes(tree, hasClass("scrollHint")).length, 0);
  const region = nodes(tree, node => node.props.role === "region")[0];
  assert.equal(region.props["aria-label"], "User Accounts");
  assert.equal(region.props.tabIndex, undefined, "nothing to scroll, nothing to focus");

  const wide = mountScroll({ scrollWidth: 1600, clientWidth: 900, scrollLeft: 0 });
  wide.render(); tree = wide.render();
  assert.match(text(nodes(tree, hasClass("scrollHint"))[0]), /Scroll sideways to see all columns/);
  assert.ok(hasClass("moreRight")(tree));
  assert.equal(nodes(tree, node => node.props.role === "region")[0].props.tabIndex, 0, "keyboard users can scroll it");
  wide.element.scrollLeft = 700;
  wide.listeners.scroll();
  tree = wide.render();
  assert.ok(!hasClass("moreRight")(tree), "no fade once the last column is visible");
  assert.ok(hasClass("scrolled")(nodes(tree, node => node.props.role === "region")[0]), "the pinned column shows its edge shadow");
});

test("the stylesheet bounds scrolling to the table, stacks the footer on phones and avoids pill shapes", () => {
  assert.match(cssSource, /\.scroll \{[^}]*overflow: auto/);
  assert.match(cssSource, /\.table thead th \{[^}]*position: sticky/);
  assert.match(cssSource, /\.sticky \{[^}]*position: sticky/);
  const phone = /@media \(max-width: 639px\) \{([\s\S]*?)\n\}/.exec(cssSource)[1];
  assert.match(phone, /\.footer \{[^}]*flex-direction: column/);
  assert.match(phone, /\.pagerButton, \.pageIndicator \{ height: 44px; \}/, "touch-sized controls");
  assert.match(phone, /\.sticky \{ position: static; \}/);
  for (const [, radius] of cssSource.matchAll(/border-radius: (\d+)px/g)) assert.ok(Number(radius) <= 8, `radius ${radius}px`);
  assert.match(cssSource, /\.pagerButton:disabled \{[^}]*cursor: not-allowed/);
  assert.match(cssSource, /:focus-visible/);
  assert.match(cssSource, /prefers-reduced-motion/);
});

test("D1 shared dispatch: a never-called visit reads as unassigned, separate from its service", () => {
  const view = render("Patient Records", patientColumns, [
    { id: 3, patient_name: "Synthetic Shared", queue_number: "OB-003", service_type: "prenatal", doctor: null, doctor_source: "unassigned",
      priority_score: 1, status: "cancelled", created_at: at, called_at: null, consultation_started_at: null, completed_at: at },
    { id: 4, patient_name: "Synthetic Treated", queue_number: "OB-004", service_type: "prenatal", doctor: "Doctor 1", doctor_source: "assigned",
      priority_score: 1, status: "completed", created_at: at, called_at: at, consultation_started_at: at, completed_at: at }
  ]);
  const [uncalled, treated] = view.rows;
  assert.deepEqual(plain(view.cellsOf(uncalled).slice(2, 4)), ["Prenatal", "Unassigned (not called)"]);
  assert.deepEqual(plain(view.cellsOf(treated).slice(2, 4)), ["Prenatal", "Doctor 1"], "the treating doctor, not the service doctor");
});
