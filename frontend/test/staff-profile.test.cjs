// EP1 Edit Profile UI: the Staff Management pencil button beside Archive, and the floating
// Edit User Profile modal (fresh load, read-only protected fields, validation under the field,
// save, server field errors).
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let code;
const indexSource = fs.readFileSync(path.join(__dirname, "../pages/index.js"), "utf8");
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../components/StaffProfileDialog.js");
  code = (await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
});

const jsx = (type, props) => ({ type, props: props || {} });
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
// Expands function components (ReadOnlyField) so their inputs are inspectable.
function expand(tree) {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== "object" || !tree.props) return tree;
  if (typeof tree.type === "function") return expand(tree.type(tree.props));
  return { ...tree, props: { ...tree.props, children: expand(tree.props.children) } };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mount(api, props) {
  const slots = [];
  const effects = [];
  let index = 0;
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(effect, deps) {
      const i = index++;
      const previous = slots[i];
      if (!previous || !deps || deps.some((dep, k) => dep !== previous.deps[k])) {
        effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setImmediate,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: api };
      if (name === "./StaffArchives") return { useModalDialog: () => ({ ref: { current: null }, onCancel() {} }) };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = async () => {
    let tree;
    for (let round = 0; round < 6; round += 1) {
      index = 0;
      tree = module.exports.StaffProfileDialog(props);
      const pending = effects.splice(0);
      pending.forEach((run) => run());
      await flush();
      await flush();
      if (!pending.length) break;
    }
    index = 0;
    return expand(module.exports.StaffProfileDialog(props));
  };
  return { render, exports: module.exports };
}

const PROFILE = { id_num: "admin1", role: "admin", doctor_name: "Doctor 1", display_name: null, display_name_supported: true };

function backend({ profile = PROFILE, save } = {}) {
  const calls = [];
  const api = async (route, init = {}) => {
    calls.push({ route, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if ((init.method || "GET") === "GET") return { success: true, profile };
    if (save) return save(JSON.parse(init.body));
    return { success: true, profile: { ...profile, display_name: JSON.parse(init.body).display_name || null } };
  };
  return { api, calls };
}

const input = (tree, id) => nodes(tree, (n) => n.type === "input" && n.props.id === id)[0];
const form = (tree) => nodes(tree, (n) => n.type === "form")[0];
const submit = (tree) => nodes(tree, (n) => n.type === "button" && n.props.type === "submit")[0];

test("display name validation mirrors the backend rules", () => {
  const { exports } = mount(async () => ({}), {});
  assert.equal(exports.normalizeDisplayName("  Dr.   Maria \n Santos "), "Dr. Maria Santos");
  assert.equal(exports.validateDisplayName(""), "");
  assert.equal(exports.validateDisplayName("é".repeat(100)), "");
  assert.match(exports.validateDisplayName("x".repeat(101)), /100 characters or fewer/);
  assert.match(exports.validateDisplayName("bad\u0007"), /control characters/);
  assert.equal(exports.validateDisplayName("tab\tis whitespace"), "");
});

test("closed renders nothing and sends nothing; opening loads the selected account fresh", async () => {
  const closed = backend();
  assert.equal(await mount(closed.api, { open: false, account: null, onClose() {} }).render(), null);
  assert.deepEqual(closed.calls, []);

  const b = backend({ profile: { ...PROFILE, display_name: "Dr. Santos" } });
  const tree = await mount(b.api, { open: true, account: { id_num: "admin1" }, onClose() {} }).render();
  assert.equal(tree.type, "dialog");
  assert.match(text(tree), /Edit User Profile/);
  assert.deepEqual(b.calls.map((c) => [c.method, c.route]), [["GET", "/users/admin1/profile"]]);
  assert.equal(input(tree, "staff-profile-display-name").props.value, "Dr. Santos", "populated with the saved value");
  for (const [id, value] of [["staff-profile-id", "admin1"], ["staff-profile-role", "ADMIN"], ["staff-profile-assignment", "Doctor 1"]]) {
    const field = input(tree, id);
    assert.equal(field.props.value, value);
    assert.equal(field.props.readOnly, true, `${id} is read-only`);
  }
  assert.match(text(tree), /Read only/);
  assert.ok(nodes(tree, (n) => n.type === "button" && text(n).includes("Cancel"))[0]);
  assert.equal(text(submit(tree)), "Save Changes");
  assert.equal(submit(tree).props.disabled, true, "nothing to save until the value changes");
});

test("invalid input shows the error under the field and blocks submission", async () => {
  const b = backend();
  const view = mount(b.api, { open: true, account: { id_num: "admin1" }, onClose() {} });
  let tree = await view.render();
  input(tree, "staff-profile-display-name").props.onChange({ target: { value: "x".repeat(101) } });
  tree = await view.render();
  const field = input(tree, "staff-profile-display-name");
  assert.equal(field.props["aria-invalid"], "true");
  const error = nodes(tree, (n) => n.props.id === "staff-profile-display-name-error")[0];
  assert.match(text(error), /100 characters or fewer/);
  assert.equal(submit(tree).props.disabled, true);
  await form(tree).props.onSubmit({ preventDefault() {} });
  assert.equal(b.calls.filter((c) => c.method !== "GET").length, 0, "nothing sent");
});

test("save sends only the normalized display name and hands the saved profile back", async () => {
  const b = backend();
  let saved = null;
  const view = mount(b.api, { open: true, account: { id_num: "admin1" }, onClose() {}, onSaved: (p) => { saved = p; } });
  let tree = await view.render();
  input(tree, "staff-profile-display-name").props.onChange({ target: { value: "  Dr.  Maria Santos " } });
  tree = await view.render();
  assert.equal(submit(tree).props.disabled, false);
  await form(tree).props.onSubmit({ preventDefault() {} });
  const put = b.calls.at(-1);
  assert.deepEqual([put.method, put.route], ["PUT", "/users/admin1/profile"]);
  assert.deepEqual(put.body, { display_name: "Dr. Maria Santos" }, "no role, password, id or assignment is sent");
  assert.equal(saved.display_name, "Dr. Maria Santos");
});

test("a server field error appears under the field; other errors appear in the modal; nothing is saved", async () => {
  let reply = { error: "Display name must be 100 characters or fewer.", status: 400, details: { field: "display_name" } };
  const b = backend({ save: () => reply });
  let saved = 0;
  const view = mount(b.api, { open: true, account: { id_num: "admin1" }, onClose() {}, onSaved: () => { saved += 1; } });
  let tree = await view.render();
  input(tree, "staff-profile-display-name").props.onChange({ target: { value: "Dr. Santos" } });
  tree = await view.render();
  await form(tree).props.onSubmit({ preventDefault() {} });
  tree = await view.render();
  assert.match(text(nodes(tree, (n) => n.props.id === "staff-profile-display-name-error")[0]), /100 characters/);

  reply = { error: "This account is archived. Restore it from Archives before editing its profile.", status: 409 };
  input(tree, "staff-profile-display-name").props.onChange({ target: { value: "Dr. Santos B" } });
  tree = await view.render();
  await form(tree).props.onSubmit({ preventDefault() {} });
  tree = await view.render();
  assert.match(text(nodes(tree, (n) => n.props.role === "alert")), /archived/);
  assert.equal(saved, 0);
});

test("when EP1 is not installed the modal says so and cannot save", async () => {
  const b = backend({ profile: { ...PROFILE, display_name_supported: false } });
  const view = mount(b.api, { open: true, account: { id_num: "admin1" }, onClose() {} });
  const tree = await view.render();
  assert.match(text(tree), /not installed/);
  assert.equal(input(tree, "staff-profile-display-name").props.disabled, true);
  assert.equal(submit(tree).props.disabled, true);
});

test("Staff Management: Edit Profile sits immediately before Archive, which is unchanged", () => {
  const table = indexSource.slice(indexSource.indexOf("<th className=\"px-6 py-4\">User ID</th>"), indexSource.indexOf("No staff accounts found"));
  const edit = table.indexOf('title="Edit Profile"');
  const archive = table.indexOf("onClick={() => openArchiveConfirm(u)}");
  assert.ok(edit > 0 && archive > edit, "Edit Profile comes first, Archive follows");
  assert.match(table, /fas fa-pen/);
  assert.match(table, /aria-label=\{`Edit Profile \$\{u\.id_num\}`\}/);
  assert.match(table, /aria-label=\{`Archive \$\{u\.id_num\}`\}/);
  assert.match(table, /disabled=\{u\.id_num === user\.id_num\}/, "archive self-protection kept");
  assert.match(table, /u\.display_name \|\| u\.doctor_name \|\| "—"/);
  assert.match(indexSource, /<StaffProfileDialog/);
  assert.match(indexSource, /Profile Updated Successfully/);
  assert.match(indexSource, /The user&apos;s profile information has been saved successfully\./);
});
