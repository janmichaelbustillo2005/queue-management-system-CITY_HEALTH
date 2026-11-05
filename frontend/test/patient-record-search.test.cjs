// Front Desk "Search Existing Patient" component (components/PatientRecordSearch.js), rendered
// with stubbed React hooks and a recorded API.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let compiled;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "..", "components/PatientRecordSearch.js");
  compiled = (await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
});

const jsx = (type, props) => ({ type, props: props || {} });
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

const rows = [
  { id: 1, patient_code: "PAT-0001", full_name: "Juan D. Dela Cruz", birthdate: "1990-04-12", sex: "Male" },
  { id: 4, patient_code: "PAT-0004", full_name: "Juan Dela Cruz", birthdate: "1972-09-03", sex: "Male" }
];

function harness({ respond = () => ({ success: true, patients: rows, truncated: false }), props = {} } = {}) {
  let cursor = 0;
  const hooks = [], calls = [], effects = [], selected = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect) { effects.push(effect); }
  };
  const request = async route => { calls.push(route); return respond(route); };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, Date, setTimeout, clearTimeout,
    encodeURIComponent,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "../lib/api") return { request };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  const Search = module.exports.default;
  const render = () => { cursor = 0; effects.length = 0; return Search({ onSelect: row => selected.push(row), ...props }); };
  const input = () => nodes(render(), node => node.props.id === "patient-record-search")[0];
  const type = value => input().props.onChange({ target: { value } });
  const search = async value => {
    type(value);
    nodes(render(), node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
  };
  return { render, calls, selected, input, type, search, effects, module: module.exports };
}

test("the search field has the required label and placeholder and reads nothing until used", () => {
  const h = harness();
  const screen = h.render();
  const label = nodes(screen, node => node.type === "label")[0];
  assert.equal(label.props.htmlFor, "patient-record-search");
  assert.match(text(label), /Search Existing Patient/);
  assert.equal(h.input().props.placeholder, "Search patient by name...");
  assert.equal(nodes(screen, node => node.type === "form")[0].props.role, "search");
  assert.deepEqual(h.calls, []);
});

test("results list name, Patient ID, birthdate and sex, and Select hands back the chosen row", async () => {
  const h = harness();
  await h.search("  Juan Dela Cruz ");
  assert.deepEqual(h.calls, ["/patient-records?search=Juan%20Dela%20Cruz"]);
  const screen = h.render();
  assert.match(text(screen), /Search Results/);
  assert.deepEqual(nodes(screen, node => node.type === "th").map(text), ["Patient Name", "Patient ID", "Birthdate", "Sex", "Action"]);
  const bodyRows = nodes(screen, node => node.type === "tr").slice(1);
  assert.deepEqual(bodyRows.map(row => nodes(row, node => node.type === "td").slice(0, 4).map(text)), [
    ["Juan D. Dela Cruz", "PAT-0001", "Apr 12, 1990", "Male"],
    ["Juan Dela Cruz", "PAT-0004", "Sep 3, 1972", "Male"]
  ]);
  const select = nodes(bodyRows[1], node => node.type === "button")[0];
  assert.equal(text(select), "Select");
  assert.equal(select.props.type, "button");
  assert.equal(select.props["aria-label"], "Select Juan Dela Cruz, PAT-0004");
  select.props.onClick();
  assert.deepEqual(h.selected, [rows[1]]);
  assert.equal(h.calls.length, 1, "selecting does not search again");
});

test("no match shows a message that points to new-patient registration", async () => {
  const h = harness({ respond: () => ({ success: true, patients: [] }) });
  await h.search("Pedro");
  const shown = text(h.render());
  assert.match(shown, /No registered patient matches “Pedro”/);
  assert.match(shown, /register a new patient using the form below/);
  assert.equal(nodes(h.render(), node => node.type === "table").length, 0);
});

test("errors are shown instead of results, and a too-short search sends nothing", async () => {
  const h = harness({ respond: () => ({ error: "Only Front Desk staff and the Super Admin can search or register patient records.", status: 403 }) });
  await h.search("j");
  assert.deepEqual(h.calls, []);
  await h.search("ju");
  assert.equal(nodes(h.render(), node => node.props.role === "alert").map(text)[0], "Only Front Desk staff and the Super Admin can search or register patient records.");
  assert.equal(nodes(h.render(), node => node.type === "table").length, 0);
});

test("typing searches after a short pause, and a slower earlier answer cannot replace a later one", async () => {
  const pending = [];
  const h = harness({ respond: route => new Promise(resolve => pending.push({ route, resolve })) });
  h.type("Ju");
  h.render();
  assert.equal(h.effects.length, 1);
  const cleanup = h.effects[0]();
  assert.equal(typeof cleanup, "function");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(pending.map(item => item.route), ["/patient-records?search=Ju"]);

  h.type("Maria");
  nodes(h.render(), node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  pending[1].resolve({ success: true, patients: [{ id: 9, patient_code: "PAT-0009", full_name: "Maria Santos", birthdate: null, sex: null }] });
  await new Promise(resolve => setImmediate(resolve));
  pending[0].resolve({ success: true, patients: rows });
  await new Promise(resolve => setImmediate(resolve));
  const shown = text(h.render());
  assert.match(shown, /Maria Santos/);
  assert.match(shown, /Not recorded/);
  assert.doesNotMatch(shown, /Dela Cruz/);
});

test("the selected patient is marked, controls follow disabled, and long result lists ask for more of the name", async () => {
  const h = harness({ respond: () => ({ success: true, patients: rows, truncated: true }), props: { selectedId: 4, disabled: true } });
  await h.search("juan");
  const screen = h.render();
  assert.equal(h.input().props.disabled, true);
  const buttons = nodes(screen, node => node.type === "button" && node.props.type === "button");
  assert.deepEqual(buttons.map(text), ["Select", "Selected"]);
  assert.ok(buttons.every(button => button.props.disabled === true));
  assert.match(text(screen), /Showing the first 2 matches\. Type more of the name/);
});

test("birthdates are formatted as calendar dates without a time-zone shift", () => {
  const { formatRecordBirthdate } = harness().module;
  assert.equal(formatRecordBirthdate("1990-04-12"), "Apr 12, 1990");
  assert.equal(formatRecordBirthdate("2000-01-01"), "Jan 1, 2000");
  assert.equal(formatRecordBirthdate(null), "Not recorded");
  assert.equal(formatRecordBirthdate("12/04/1990"), "Not recorded");
});
