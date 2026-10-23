const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let libCode, toolbarCode, pageCode;
before(async () => {
  await swc.loadBindings();
  const compile = async relative => {
    const filename = path.join(__dirname, relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  };
  [libCode, toolbarCode, pageCode] = await Promise.all([
    compile("../lib/recordsFilters.js"), compile("../components/RecordsFilters.js"), compile("../pages/records.js")
  ]);
});

const jsx = (type, props) => ({ type, props: props || {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
// Class names resolve to their own key; __esModule stays undefined so the default import is this object.
const cssModule = new Proxy({}, { get: (_target, key) => key === "__esModule" || typeof key === "symbol" ? undefined : key });
// Values built inside a vm context carry that context's prototypes; compare plain copies.
const deepEqual = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

function loadLib() {
  const module = { exports: {} };
  vm.runInNewContext(libCode, { module, exports: module.exports, URLSearchParams, Date });
  return module.exports;
}

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
const button = (tree, label) => nodes(tree, node => node.type === "button" && text(node).trim() === label)[0];

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
      useRef(initial) {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { current: initial };
        return hooks[index];
      },
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

// --- Toolbar component --------------------------------------------------------

function mountToolbar(props) {
  const runtime = hookRuntime();
  const module = { exports: {} };
  const lib = loadLib();
  vm.runInNewContext(toolbarCode, {
    module, exports: module.exports,
    require(name) {
      if (name === "react") return runtime.react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "./RecordsFilters.module.css") return cssModule;
      if (name === "../lib/recordsFilters") return lib;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const calls = { change: [], apply: 0, reset: 0, remove: [] };
  const mount = {
    calls,
    props: {
      draft: {}, applied: {},
      onChange: (key, value) => calls.change.push([key, value]),
      onApply: () => calls.apply++, onReset: () => calls.reset++, onRemove: key => calls.remove.push(key),
      ...props
    },
    render() { runtime.reset(); return mount.tree = module.exports.default(mount.props); }
  };
  mount.render();
  return mount;
}

const controls = tree => nodes(tree, node => ["input", "select"].includes(node.type));
const labelFor = (tree, id) => text(nodes(tree, node => node.type === "label" && node.props.htmlFor === id)[0]);
const optionsOf = select => nodes(select, node => node.type === "option").map(node => [node.props.value, text(node)]);
const advancedRegion = tree => nodes(tree, hasClass("advanced"))[0];
const moreButton = tree => nodes(tree, hasClass("moreButton"))[0];

test("the filter options map to the exact values the Records RPC compares", () => {
  const { RECORD_FILTERS } = loadLib();
  const values = (category, key) => [...RECORD_FILTERS[category].primary, ...RECORD_FILTERS[category].advanced]
    .find(field => field.key === key).options.map(option => option.value);
  deepEqual(values("patients", "status"), ["waiting", "serving", "completed", "cancelled", "no-show"]);
  deepEqual(values("patients", "service"), ["consultation", "checkup", "prenatal", "maternity", "family_planning"]);
  deepEqual(values("patients", "doctor"), ["Doctor 1", "Doctor 2", "Doctor 3"]);
  for (const category of ["staff", "accounts"]) {
    deepEqual(values(category, "position"), ["Super Admin", "Doctor", "Frontdesk"], "server-derived positions only (Phase B.2)");
    deepEqual(values(category, "role"), ["superadmin", "admin"], "stored roles only");
    deepEqual(values(category, "presence"), ["online", "offline"]);
    deepEqual(values(category, "doctor"), ["Doctor 1", "Doctor 2", "Doctor 3"], "no Unassigned: the server resolves counters");
  }
  const keys = category => [...RECORD_FILTERS[category].primary, ...RECORD_FILTERS[category].advanced].map(field => field.key).sort();
  deepEqual(keys("patients"), ["date", "doctor", "search", "service", "status"]);
  deepEqual(keys("staff"), ["doctor", "position", "presence", "role", "search"]);
  deepEqual(keys("accounts"), keys("staff"), "no invented account-status filter");
});

test("cleaning drops other categories' keys, blanks, bad dates and unknown options", () => {
  const { cleanRecordFilters, recordsQuery, recordFilterChips } = loadLib();
  const mixed = { search: "  Juan ", status: "serving", presence: "online", date: "22/10/2026", doctor: "Doctor 9", service: "" };
  deepEqual({ ...cleanRecordFilters("patients", mixed) }, { search: "Juan", status: "serving" });
  deepEqual({ ...cleanRecordFilters("staff", mixed) }, { search: "Juan", presence: "online" });
  assert.equal(recordsQuery("patients", { status: "serving", search: "A-01" }, 3), "search=A-01&status=serving&page=3&limit=20");
  const chips = recordFilterChips("patients", { date: "2026-10-22", doctor: "Doctor 2", status: "serving", search: "Cruz" });
  deepEqual(chips.map(chip => `${chip.label}: ${chip.value}`),
    ["Search: “Cruz”", "Registration date: Oct 22, 2026", "Assigned doctor: Doctor 2", "Queue status: Being served"]);
});

test("Patient Records shows all five filters with labels, a search icon, a date picker and All defaults", () => {
  const tree = mountToolbar({ category: "patients" }).tree;
  const fields = controls(tree);
  deepEqual(fields.map(node => labelFor(tree, node.props.id).replace(/Manila date$/, "")),
    ["Search patients", "Registration date", "Service", "Assigned doctor", "Queue status"]);
  assert.equal(fields[0].props.type, "search");
  assert.equal(fields[0].props.placeholder, "Patient name or ticket number");
  assert.ok(nodes(tree, node => node.type === "i" && node.props.className === "fas fa-search").length >= 1);
  assert.equal(fields[1].props.type, "date");
  deepEqual(optionsOf(fields[2])[0], ["", "All services"]);
  deepEqual(optionsOf(fields[2])[1], ["consultation", "General Consultation"]);
  deepEqual(optionsOf(fields[3])[0], ["", "All doctors"]);
  deepEqual(optionsOf(fields[4]).map(([, label]) => label), ["All statuses", "Waiting", "Being served", "Completed", "Cancelled", "No-show"]);
  assert.equal(moreButton(tree), undefined, "every patient filter stays visible");
  assert.equal(advancedRegion(tree), undefined);
});

test("Staff Records keeps search, position and presence visible and folds role and doctor into More filters", () => {
  const toolbar = mountToolbar({ category: "staff", draft: { role: "admin" } });
  let tree = toolbar.tree;
  const primary = nodes(nodes(tree, hasClass("primary"))[0], node => ["input", "select"].includes(node.type));
  deepEqual(primary.map(node => labelFor(tree, node.props.id)), ["Search staff", "Position", "Presence"]);
  deepEqual(optionsOf(primary[1]).map(([, label]) => label), ["All positions", "Super Admin", "Doctor", "Front desk"]);
  const region = advancedRegion(tree);
  const advanced = nodes(region, node => node.type === "select");
  deepEqual(advanced.map(node => labelFor(tree, node.props.id)), ["Stored role", "Doctor assignment"]);
  deepEqual(optionsOf(advanced[1])[0], ["", "All doctor assignments"]);
  assert.equal(advanced[0].props.value, "admin", "collapsed filters keep their values");
  assert.equal(region.props.inert, true, "collapsed filters are out of the tab order");
  const more = moreButton(tree);
  assert.equal(more.props.type, "button", "toggling never submits the form");
  assert.equal(more.props["aria-expanded"], false);
  assert.equal(more.props["aria-controls"], region.props.id);
  assert.match(text(more), /More filters\s*1/, "the count shows a set advanced filter");

  more.props.onClick();
  tree = toolbar.render();
  assert.equal(moreButton(tree).props["aria-expanded"], true);
  assert.equal(advancedRegion(tree).props.inert, false);
  assert.ok(hasClass("advancedOpen")(advancedRegion(tree)));
  moreButton(tree).props.onClick();
  tree = toolbar.render();
  assert.equal(advancedRegion(tree).props.inert, true);
  assert.equal(nodes(advancedRegion(tree), node => node.type === "select")[0].props.value, "admin");
  assert.equal(toolbar.calls.apply + toolbar.calls.reset + toolbar.calls.change.length, 0, "expanding filters nothing");
});

test("User Accounts shows search, role and position, with presence and doctor link under More filters", () => {
  const tree = mountToolbar({ category: "accounts" }).tree;
  const primary = nodes(nodes(tree, hasClass("primary"))[0], node => ["input", "select"].includes(node.type));
  deepEqual(primary.map(node => labelFor(tree, node.props.id)), ["Search accounts", "Account role", "Position"]);
  deepEqual(optionsOf(primary[1]), [["", "All roles"], ["superadmin", "Super Admin"], ["admin", "Admin (doctors & front desk)"]]);
  deepEqual(nodes(advancedRegion(tree), node => node.type === "select").map(node => labelFor(tree, node.props.id)),
    ["Session presence", "Linked doctor"]);
  assert.doesNotMatch(text(tree), /account status/i);
});

test("controls report edits, Enter or Apply submits, and chips remove single filters or clear all", () => {
  const toolbar = mountToolbar({ category: "patients", draft: { status: "serving", doctor: "Doctor 2" }, applied: { status: "serving" } });
  let tree = toolbar.tree;
  const doctor = controls(tree).find(node => node.props.id.endsWith("-doctor"));
  doctor.props.onChange({ target: { value: "Doctor 3" } });
  deepEqual(toolbar.calls.change, [["doctor", "Doctor 3"]]);
  assert.equal(text(nodes(tree, node => node.props.role === "status")[0]), "Changes not applied yet");

  let prevented = false;
  nodes(tree, node => node.type === "form")[0].props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(toolbar.calls.apply, 1);
  assert.ok(prevented, "Enter in any field submits without a page reload");
  assert.equal(button(tree, "Apply filters").props.type, "submit");
  button(tree, "Reset").props.onClick();
  assert.equal(toolbar.calls.reset, 1);

  const chips = nodes(tree, hasClass("chip"));
  deepEqual(chips.map(chip => chip.props["aria-label"]), ["Remove filter Queue status: Being served"]);
  chips[0].props.onClick();
  deepEqual(toolbar.calls.remove, ["status"]);
  button(tree, "Clear all").props.onClick();
  assert.equal(toolbar.calls.reset, 2);

  toolbar.props = { ...toolbar.props, draft: { status: "serving" }, applied: { status: "serving" } };
  tree = toolbar.render();
  assert.equal(text(nodes(tree, node => node.props.role === "status")[0]), "", "nothing pending once applied");
  toolbar.props = { ...toolbar.props, draft: {}, applied: {} };
  assert.equal(nodes(toolbar.render(), hasClass("chips")).length, 0, "no chips without applied filters");
});

// --- Records page -------------------------------------------------------------

async function mountPage({ category = "patients" } = {}) {
  const runtime = hookRuntime();
  const calls = [], intervals = [];
  const auth = { user: { id_num: "superadmin", role: "superadmin" }, loading: false }; // stable, like React state
  const router = { query: { category }, replace() {}, push() {} };
  function SiteFrame() {}
  function RecordsFilters() {}
  const module = { exports: {} };
  vm.runInNewContext(pageCode, {
    module, exports: module.exports, console, URLSearchParams,
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
    require(name) {
      if (name === "react") return runtime.react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../context/AuthContext") return { useAuth: () => auth };
      if (name === "../components/SiteFrame") return SiteFrame;
      if (name === "../components/RecordsFilters") return RecordsFilters;
      if (name === "../lib/recordsFilters") return loadLib();
      if (name === "../lib/api") return { request: requestPath => new Promise(resolve => calls.push({ path: requestPath, resolve })) };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const page = {
    calls, router, intervals,
    render() { runtime.reset(); return page.tree = module.exports.default(); },
    async settle() { for (let i = 0; i < 4; i++) { page.render(); runtime.flush(); await tick(); } return page.render(); },
    toolbar() { return nodes(page.tree, node => node.type === RecordsFilters)[0].props; },
    async respond(value, index = calls.length - 1) { calls[index].resolve(value); return page.settle(); },
    paths() { return calls.map(call => call.path); }
  };
  await page.settle();
  return page;
}
const rows = (...ids) => ({ rows: ids.map(id => ({ id, patient_name: `Patient ${id}` })), total: ids.length });

test("the page applies filters together on the server and keeps them through pagination and refresh", async () => {
  const page = await mountPage();
  deepEqual(page.paths(), ["/records/patients?page=1&limit=20"]);
  await page.respond({ rows: [{ id: 1 }], total: 45 });

  page.toolbar().onChange("status", "serving");
  await page.settle();
  page.toolbar().onChange("doctor", "Doctor 2");
  await page.settle();
  assert.equal(page.calls.length, 1, "editing a control does not search yet");
  deepEqual({ ...page.toolbar().draft }, { status: "serving", doctor: "Doctor 2" }, "one change keeps the other");

  page.toolbar().onApply();
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/patients?doctor=Doctor+2&status=serving&page=1&limit=20");
  await page.respond({ rows: [{ id: 2 }], total: 45 });
  deepEqual({ ...page.toolbar().applied }, { status: "serving", doctor: "Doctor 2" });

  button(page.tree, "Next").props.onClick();
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/patients?doctor=Doctor+2&status=serving&page=2&limit=20");
  await page.respond({ rows: [{ id: 3 }], total: 45 });

  const before = page.calls.length;
  button(page.tree, "Refresh").props.onClick();
  await page.settle();
  page.intervals[0]();
  await page.settle();
  deepEqual(page.paths().slice(before), Array(2).fill("/records/patients?doctor=Doctor+2&status=serving&page=2&limit=20"));
  assert.match(text(page.tree), /Patient|records/i);
  assert.equal(nodes(page.tree, node => node.props.role === "status" && /Loading records/.test(text(node))).length, 0,
    "a refresh keeps the current rows instead of flashing a loader");
});

test("removing a chip or resetting reloads from page 1 without the removed filters", async () => {
  const page = await mountPage();
  await page.respond(rows());
  page.toolbar().onChange("status", "waiting");
  page.toolbar().onChange("search", "Cruz");
  await page.settle();
  page.toolbar().onApply();
  await page.settle();
  await page.respond({ rows: [{ id: 1 }], total: 60 });
  button(page.tree, "Next").props.onClick();
  await page.settle();
  await page.respond({ rows: [{ id: 2 }], total: 60 });

  page.toolbar().onRemove("status");
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/patients?search=Cruz&page=1&limit=20");
  deepEqual({ ...page.toolbar().draft }, { search: "Cruz" }, "the control is cleared with its chip");
  await page.respond(rows(4));

  page.toolbar().onReset();
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/patients?page=1&limit=20");
  deepEqual({ ...page.toolbar().draft }, {});
  deepEqual({ ...page.toolbar().applied }, {});
});

test("switching categories starts clean and never sends another category's filters", async () => {
  const page = await mountPage();
  await page.respond(rows());
  page.toolbar().onChange("status", "serving");
  page.toolbar().onChange("search", "Cruz");
  await page.settle();
  page.toolbar().onApply();
  await page.settle();
  await page.respond(rows(1));

  page.router.query = { category: "staff" };
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/staff?page=1&limit=20");
  assert.ok(!page.paths().some(p => p.startsWith("/records/staff") && /status|search/.test(p)));
  deepEqual({ ...page.toolbar().draft }, {});
  assert.equal(page.toolbar().category, "staff");
  await page.respond(rows());

  page.router.query = { category: "accounts" };
  await page.settle();
  assert.equal(page.paths().at(-1), "/records/accounts?page=1&limit=20");
});

test("an older response never replaces the results of a newer query", async () => {
  const page = await mountPage();
  await page.respond(rows());
  page.toolbar().onChange("status", "waiting");
  await page.settle();
  page.toolbar().onApply();
  await page.settle();
  const older = page.calls.length - 1;
  page.toolbar().onChange("status", "completed");
  await page.settle();
  page.toolbar().onApply();
  await page.settle();
  await page.respond(rows(20));
  await page.respond(rows(10), older);
  const shown = nodes(page.tree, node => node.type === "tr").length;
  assert.equal(shown, 2, "header plus the newer query's one row");
  assert.match(text(page.tree), /Patient 20/);
  assert.doesNotMatch(text(page.tree), /Patient 10/);
});

test("failures are reported as failures, not as empty results", async () => {
  const cases = [
    [{ error: "Failed to fetch" }, "Records API unreachable", "Failed to fetch"],
    [{ error: "Records storage unavailable. Verify the Phase B migration is installed." }, "Records storage unavailable", "Phase B"],
    [{ success: true }, "Records could not be loaded", "unexpected records response"]
  ];
  for (const [response, title, detail] of cases) {
    const page = await mountPage({ category: "staff" });
    await page.respond(response);
    const alert = nodes(page.tree, node => node.props.role === "alert")[0];
    assert.match(text(alert), new RegExp(title), title);
    assert.match(text(alert), new RegExp(detail), title);
    assert.doesNotMatch(text(page.tree), /No records/, `${title} is not shown as empty`);
    assert.match(text(page.tree), /Results unavailable/);
    button(page.tree, "Retry").props.onClick();
    await page.settle();
    assert.equal(page.calls.length, 2, "Retry repeats the request");
    await page.respond(rows());
    assert.equal(nodes(page.tree, node => node.props.role === "alert").length, 0, "a successful retry clears the error");
  }
});

test("loading and the two empty states say what they mean", async () => {
  const page = await mountPage();
  assert.match(text(page.tree), /Loading records/);
  await page.respond(rows());
  assert.match(text(page.tree), /No records are stored in this category yet/);
  page.toolbar().onChange("status", "no-show");
  await page.settle();
  page.toolbar().onApply();
  await page.settle();
  await page.respond(rows());
  assert.match(text(page.tree), /No records match the applied filters/);
});

test("Phase B.2 values: missing account creation dates read Not recorded and routed doctors are labelled", async () => {
  const accounts = await mountPage({ category: "accounts" });
  await accounts.respond({ rows: [{ id: "frontdesk", display_name: "frontdesk", role: "admin", position: "Frontdesk", doctor: null, created_at: null, online: false, authenticated: false }], total: 1 });
  assert.match(text(accounts.tree), /Not recorded/);
  assert.match(text(accounts.tree), /Frontdesk/);
  assert.doesNotMatch(text(accounts.tree), /Invalid Date|1970/);
  const patients = await mountPage();
  const at = "2026-10-23T00:00:00Z";
  await patients.respond({ rows: [
    { id: 1, patient_name: "Juan Dela Cruz", doctor: "Doctor 1", doctor_source: "service", created_at: at },
    { id: 2, patient_name: "PHIL-123-SYNTH", doctor: "Doctor 2", doctor_source: "assigned", created_at: at },
    { id: 3, patient_name: "Legacy", doctor: "Doctor 9", doctor_source: "unresolved", created_at: at }
  ], total: 3 });
  const shown = text(patients.tree);
  assert.match(shown, /Juan Dela Cruz/, "names are shown exactly as stored");
  assert.match(shown, /PHIL-123-SYNTH/);
  assert.match(shown, /Doctor 1 \(by service\)/);
  assert.match(shown, /Doctor 2/);
  assert.doesNotMatch(shown, /Doctor 2 \(/, "a stored assignment carries no qualifier");
  assert.match(shown, /Doctor 9 \(no matching counter\)/);
  assert.doesNotMatch(shown, /Not recorded/, "patient registration times are always stored");
});
