// AR1 Staff Archives UI: the floating Archives modal (list, search, restore, permanent delete,
// each behind a confirmation) and the Staff Management wiring (Archive replaces Delete).
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
  const filename = path.join(__dirname, "../components/StaffArchives.js");
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A one-component hook runtime: enough to drive state, refs and effects between renders.
function mount(api, Component, props) {
  const slots = [];
  const effects = [];
  let index = 0;
  let tree;
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
    document: { activeElement: null },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "../lib/api") return { request: api };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = async () => {
    for (let round = 0; round < 5; round += 1) {
      index = 0;
      tree = module.exports[Component](props);
      const pending = effects.splice(0);
      pending.forEach((run) => run());
      await flush();
      if (!pending.length) break;
    }
    index = 0;
    tree = module.exports[Component](props);
    return tree;
  };
  return { render, exports: module.exports, get tree() { return tree; } };
}

const ARCHIVED = [
  { id_num: "admin2", role: "admin", doctor_name: "Doctor 2", archived_at: "2026-11-10T02:00:00.000Z", archived_by: "superadmin" },
  { id_num: "frontdesk", role: "admin", doctor_name: null, archived_at: "2026-11-09T02:00:00.000Z", archived_by: "superadmin" }
];

function backend({ fail = {} } = {}) {
  const calls = [];
  let archived = JSON.parse(JSON.stringify(ARCHIVED));
  const api = async (route, init = {}) => {
    calls.push({ route, method: init.method || "GET" });
    if (route === "/users/archived") return { success: true, users: archived };
    const key = `${init.method} ${route}`;
    if (fail[key]) return { error: fail[key], status: 409 };
    archived = archived.filter((u) => !route.includes(`/users/${u.id_num}`));
    return { success: true };
  };
  return { api, calls };
}

const rowIds = (tree) => nodes(tree, (n) => n.type === "tr" && n.props.children?.length === 5 && !nodes(n, (c) => c.type === "th").length)
  .map((row) => text(row.props.children[0]));
const confirmDialog = (tree) => nodes(tree, (n) => typeof n.type === "function" && n.type.name === "StaffConfirmDialog")[0];
const button = (tree, label) => nodes(tree, (n) => n.type === "button" && n.props["aria-label"] === label)[0];

test("search matches user ID and display name, case-insensitively", () => {
  const { exports } = mount(async () => ({}), "StaffArchivesModal", {});
  const { matchesArchiveSearch } = exports;
  assert.equal(matchesArchiveSearch(ARCHIVED[0], ""), true);
  assert.equal(matchesArchiveSearch(ARCHIVED[0], "ADMIN2"), true);
  assert.equal(matchesArchiveSearch(ARCHIVED[0], "doctor 2"), true);
  assert.equal(matchesArchiveSearch(ARCHIVED[1], "doctor"), false);
  assert.equal(matchesArchiveSearch(ARCHIVED[1], " front "), true);
});

test("the modal renders nothing while closed and loads archived accounts from the backend when opened", async () => {
  const closed = backend();
  assert.equal(await mount(closed.api, "StaffArchivesModal", { open: false, onClose() {} }).render(), null);
  assert.deepEqual(closed.calls, []);

  const b = backend();
  const tree = await mount(b.api, "StaffArchivesModal", { open: true, onClose() {} }).render();
  assert.equal(tree.type, "dialog");
  assert.match(text(tree), /Staff Archives/);
  assert.deepEqual(b.calls, [{ route: "/users/archived", method: "GET" }]);
  assert.deepEqual(rowIds(tree), ["admin2", "frontdesk"]);
  assert.match(text(tree), /by superadmin/);
  assert.ok(button(tree, "Close Staff Archives"));
});

test("an empty archive shows an empty-state message", async () => {
  const api = async () => ({ success: true, users: [] });
  const tree = await mount(api, "StaffArchivesModal", { open: true, onClose() {} }).render();
  assert.match(text(tree), /No archived staff accounts/);
});

test("search narrows the rows", async () => {
  const b = backend();
  const view = mount(b.api, "StaffArchivesModal", { open: true, onClose() {} });
  let tree = await view.render();
  const input = nodes(tree, (n) => n.type === "input" && n.props.type === "search")[0];
  input.props.onChange({ target: { value: "front" } });
  tree = await view.render();
  assert.deepEqual(rowIds(tree), ["frontdesk"]);
  input.props.onChange({ target: { value: "nobody" } });
  tree = await view.render();
  assert.match(text(tree), /No archived accounts match your search/);
});

test("restore asks for confirmation, then removes the row and refreshes the staff list", async () => {
  const b = backend();
  let changed = 0;
  const view = mount(b.api, "StaffArchivesModal", { open: true, onClose() {}, onChanged: () => { changed += 1; } });
  let tree = await view.render();
  assert.equal(confirmDialog(tree).props.open, false);
  button(tree, "Restore admin2").props.onClick();
  tree = await view.render();
  const dialog = confirmDialog(tree);
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.title, "Restore Staff Account?");
  assert.equal(dialog.props.confirmLabel, "Restore Account");
  assert.equal(b.calls.length, 1, "nothing is sent before confirming");
  await dialog.props.onConfirm();
  tree = await view.render();
  assert.deepEqual(b.calls.at(-1), { route: "/users/admin2/restore", method: "POST" });
  assert.deepEqual(rowIds(tree), ["frontdesk"]);
  assert.equal(confirmDialog(tree).props.open, false);
  assert.equal(changed, 1);
});

test("permanent delete warns it cannot be undone; a refused delete keeps the row and shows why", async () => {
  const b = backend({ fail: { "DELETE /users/frontdesk": "This account has a pending cancellation request." } });
  const view = mount(b.api, "StaffArchivesModal", { open: true, onClose() {} });
  let tree = await view.render();
  button(tree, "Permanently delete frontdesk").props.onClick();
  tree = await view.render();
  let dialog = confirmDialog(tree);
  assert.equal(dialog.props.title, "Permanently Delete Staff Account?");
  assert.equal(dialog.props.tone, "danger");
  assert.match(text(dialog.props.children), /cannot be undone/);
  await dialog.props.onConfirm();
  tree = await view.render();
  dialog = confirmDialog(tree);
  assert.equal(dialog.props.open, true);
  assert.match(dialog.props.error, /pending cancellation request/);
  assert.deepEqual(rowIds(tree), ["admin2", "frontdesk"]);

  dialog.props.onCancel();
  tree = await view.render();
  button(tree, "Permanently delete admin2").props.onClick();
  tree = await view.render();
  await confirmDialog(tree).props.onConfirm();
  tree = await view.render();
  assert.deepEqual(b.calls.at(-1), { route: "/users/admin2", method: "DELETE" });
  assert.deepEqual(rowIds(tree), ["frontdesk"]);
});

test("Staff Management archives instead of deleting, and offers Archives beside Add New Staff", () => {
  const header = indexSource.slice(indexSource.indexOf('activeSection === "staff" ? "" : "hidden"'), indexSource.indexOf("Doctor Cancellation Requests"));
  assert.ok(header.indexOf("Add New Staff") < header.indexOf("Archives"), "Archives follows Add New Staff");
  assert.match(header, /setArchivesOpen\(true\)/);
  assert.match(indexSource, /\/archive`, \{ method: "POST" \}/);
  assert.doesNotMatch(indexSource, /method: "DELETE"/, "the active list never deletes directly");
  assert.doesNotMatch(indexSource, /handleDeleteUser/);
  assert.match(indexSource, /title="Archive Staff Account\?"/);
  assert.match(indexSource, /confirmLabel="Archive Account"/);
  assert.match(indexSource, /no longer be allowed to log in/);
  assert.match(indexSource, /Approving archives the account/);
});
