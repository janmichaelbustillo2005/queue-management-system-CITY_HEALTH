const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const sources = ["lib/navigation.js", "lib/branding.js", "components/SiteFrame.js", "components/AppSidebar.js",
  "components/AccountMenu.js", "components/SystemLogo.js", "pages/records.js"];
const compiled = {};
before(async () => {
  await swc.loadBindings();
  await Promise.all(sources.map(async relative => {
    const filename = path.join(__dirname, "..", relative);
    compiled[relative] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }));
});

const jsx = (type, props) => ({ type, props: props || {} });
const plain = value => JSON.parse(JSON.stringify(value));
function Link() {}

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
  const react = {
    useMemo(callback) { cursor++; return callback(); },
    useCallback(callback, deps) {
      const index = cursor++, previous = dependencies[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) { hooks[index] = callback; dependencies[index] = deps; }
      return hooks[index];
    },
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
  };
  return { react, reset() { cursor = 0; }, flush() { pending.splice(0).forEach(effect => effect()); } };
}

function load(relative, require, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compiled[relative], { module, exports: module.exports, console, URLSearchParams, ...globals, require });
  return module.exports;
}
const navigation = () => load("lib/navigation.js", () => { throw new Error("no deps"); });
const branding = () => load("lib/branding.js", () => { throw new Error("no deps"); });
const location = (url, ready = true) => {
  const parsed = new URL(url, "http://localhost");
  return { ready, path: parsed.pathname, section: parsed.searchParams.get("section") || "",
    category: parsed.searchParams.get("category") || "", hash: parsed.hash.slice(1) };
};

const accounts = {
  superadmin: { id_num: "superadmin", role: "superadmin", doctor_name: null },
  frontdesk: { id_num: "frontdesk", role: "admin", doctor_name: null },
  admin1: { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" },
  admin2: { id_num: "admin2", role: "admin", doctor_name: "doctor2" },
  admin3: { id_num: "admin3", role: "admin", doctor_name: "3" }
};

// --- Account identity --------------------------------------------------------

test("accounts are identified from session role, id and doctor assignment, never from a guess", () => {
  const { resolveAccount } = navigation();
  const summary = user => { const a = resolveAccount(user); return a && [a.kind, a.roleLabel, a.assignment, a.homeHref]; };
  assert.deepEqual(plain(summary(accounts.superadmin)), ["superadmin", "Super Administrator", "All sections", "/?section=home"]);
  assert.deepEqual(plain(summary(accounts.frontdesk)), ["frontdesk", "Front Desk Staff", "Front desk", "/fill-up_form"]);
  assert.deepEqual(plain(summary(accounts.admin1)), ["doctor", "Doctor", "Doctor 1", "/admin1"]);
  assert.deepEqual(plain(summary(accounts.admin2)), ["doctor", "Doctor", "Doctor 2", "/admin2"]);
  assert.deepEqual(plain(summary(accounts.admin3)), ["doctor", "Doctor", "Doctor 3", "/admin3"]);
  assert.equal(resolveAccount({ id_num: "admin2", role: "admin" }).assignment, "Not recorded in this session");
  assert.equal(resolveAccount(null), null);
  assert.equal(resolveAccount({ role: "superadmin" }), null, "no account id, no identity");
  assert.equal(resolveAccount({ id_num: "x", role: "patient" }).kind, "unknown");
});

test("a legacy 'Front Desk' assignment is the front desk, never a doctor", () => {
  const { resolveAccount } = navigation();
  for (const doctor_name of ["Front Desk", "frontdesk", " FRONT DESK ", "", null]) {
    const account = resolveAccount({ id_num: "reception", role: "admin", doctor_name });
    assert.equal(account.kind, "frontdesk", String(doctor_name));
    assert.equal(account.roleLabel, "Front Desk Staff");
  }
  const other = resolveAccount({ id_num: "admin9", role: "admin", doctor_name: "Doctor 1" });
  assert.equal(other.kind, "staff", "a doctor label without a doctor console is not shown as a Doctor");
  assert.equal(other.homeHref, "/patient-management");
});

// --- Role navigation -----------------------------------------------------------

const menu = (user) => {
  const { navigationFor, resolveAccount } = navigation();
  return navigationFor(resolveAccount(user)).map(group => [group.label, group.items.map(item => item.label)]);
};
const links = (user) => {
  const { navigationFor, resolveAccount } = navigation();
  return navigationFor(resolveAccount(user)).flatMap(group => group.items).filter(item => item.href).map(item => item.href);
};

test("each role sees one organized menu of its own sections", () => {
  assert.deepEqual(plain(menu(accounts.superadmin)), [
    ["Overview", ["Dashboard"]],
    ["Queue Operations", ["Queue Management", "Doctor & Counter Monitoring", "Historical Backlog", "Live Queue Display"]],
    ["Records Management", ["Patient Records", "Staff Records", "User Accounts"]],
    ["Reports & Analytics", ["Analytics"]],
    ["System Administration", ["Staff Management", "System Settings"]]
  ]);
  assert.deepEqual(plain(menu(accounts.frontdesk)), [
    ["Patient Operations", ["Patient Registration", "Patient Management"]],
    ["Queue Monitoring", ["Live Queue Display"]]
  ]);
  for (const id of ["admin1", "admin2", "admin3"]) {
    assert.deepEqual(plain(menu(accounts[id])), [
      ["Patient Queue", ["My Patient Queue"]], ["Queue Monitoring", ["Live Queue Display"]]
    ], `${id} uses the same structure`);
  }
  assert.deepEqual(plain(menu(null)), [], "guests get no staff navigation");
  assert.deepEqual(plain(menu({ id_num: "x", role: "patient" })), [], "an unrecognized role has no work pages");
});

test("the sidebar holds work pages only; account actions are never duplicated there", () => {
  const { navigationFor, resolveAccount } = navigation();
  const users = [...Object.values(accounts), { id_num: "reception", role: "admin", doctor_name: "Front Desk" },
    { id_num: "admin9", role: "admin", doctor_name: "Doctor 1" }, { id_num: "x", role: "patient" }];
  for (const user of users) {
    for (const item of navigationFor(resolveAccount(user)).flatMap(group => group.items)) {
      assert.doesNotMatch(item.label, /profile|sign out|log ?out|cancel account/i, `${user.id_num}: ${item.label}`);
      assert.ok(item.href, `${user.id_num}: ${item.label} is a real page link`);
      assert.equal(item.action, undefined);
    }
  }
});

test("every menu link is an existing page, and no role is shown another role's pages", () => {
  for (const user of Object.values(accounts)) {
    for (const href of links(user)) {
      const route = href.split(/[?#]/)[0];
      const file = route === "/" ? "index" : route.slice(1);
      assert.ok(fs.existsSync(path.join(__dirname, "../pages", `${file}.js`)), `${user.id_num}: ${href}`);
    }
  }
  const superadminOnly = href => href.startsWith("/?") || href.startsWith("/records") || href === "/analytics";
  assert.ok(!links(accounts.frontdesk).some(superadminOnly));
  assert.ok(!links(accounts.frontdesk).some(href => /^\/admin\d/.test(href)), "front desk gets no doctor console");
  for (const id of ["admin1", "admin2", "admin3"]) {
    const own = links(accounts[id]);
    assert.ok(!own.some(superadminOnly), id);
    assert.deepEqual(plain(own.filter(href => /^\/admin\d/.test(href))), [`/${id}`], `${id} sees only its own console`);
    assert.ok(!own.includes("/fill-up_form") && !own.includes("/patient-management"));
  }
});

test("the highlighted item follows the URL, including Records categories and the monitoring anchor", () => {
  const { navigationFor, resolveAccount } = navigation();
  const active = (user, url, ready) => navigationFor(resolveAccount(user)).flatMap(group => group.items)
    .filter(item => item.isActive?.(location(url, ready))).map(item => item.label);
  const cases = [
    ["/?section=home", "Dashboard"], ["/", "Dashboard"], ["/?section=unknown", "Dashboard"],
    ["/?section=queue", "Queue Management"], ["/?section=queue#doctor-monitoring", "Doctor & Counter Monitoring"],
    ["/?section=staff", "Staff Management"], ["/?section=settings", "System Settings"],
    ["/records", "Patient Records"], ["/records?category=patients", "Patient Records"],
    ["/records?category=staff", "Staff Records"], ["/records?category=accounts", "User Accounts"],
    ["/records?category=unknown", "Patient Records"], ["/analytics", "Analytics"], ["/queue-backlog", "Historical Backlog"]
  ];
  for (const [url, label] of cases) assert.deepEqual(plain(active(accounts.superadmin, url)), [label], url);
  assert.deepEqual(plain(active(accounts.superadmin, "/admin1")), [], "no false highlight on pages outside the menu");
  assert.deepEqual(plain(active(accounts.frontdesk, "/patient-management")), ["Patient Management"]);
  assert.deepEqual(plain(active(accounts.frontdesk, "/fill-up_form")), ["Patient Registration"]);
  assert.deepEqual(plain(active(accounts.admin2, "/admin2")), ["My Patient Queue"]);
  assert.deepEqual(plain(active(accounts.admin2, "/admin1")), []);
});

// --- Shared layout -------------------------------------------------------------

function mountFrame({ user = accounts.superadmin, url = "/?section=home", props = {}, docked = false, storage = {} } = {}) {
  const runtime = hookRuntime();
  const listeners = new Map(), focused = [];
  const auth = { user, logouts: 0, logout() { auth.logouts++; }, logoutError: "" };
  const media = { matches: docked, listeners: [], addEventListener(_type, fn) { media.listeners.push(fn); }, removeEventListener() {} };
  const window = { matchMedia: () => media, localStorage: storage.throws
    ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
    : { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } } };
  const document = {
    activeElement: null,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); }
  };
  const parts = { AppSidebar: function AppSidebar() {}, AccountMenu: function AccountMenu() {}, ProfileDialog: function ProfileDialog() {} };
  const SystemLogo = load("components/SystemLogo.js", name => name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" } : branding());
  const frame = { router: null, auth, listeners, focused, storage, media, props, document };
  const routerFor = target => { const parsed = new URL(target, "http://localhost");
    return { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams), asPath: target, isReady: true }; };
  frame.router = routerFor(url);
  const module = load("components/SiteFrame.js", name => {
    if (name === "react") return runtime.react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "next/router") return { useRouter: () => frame.router };
    if (name === "../context/AuthContext") return { useAuth: () => auth };
    if (name === "./SystemLogo") return SystemLogo;
    if (name === "./AppSidebar") return parts.AppSidebar;
    if (name === "./AccountMenu") return { __esModule: true, default: parts.AccountMenu, ProfileDialog: parts.ProfileDialog };
    if (name === "../lib/branding") return branding();
    if (name === "../lib/navigation") return navigation();
    throw new Error(`Unexpected dependency: ${name}`);
  }, { window, document, setInterval: () => 1, clearInterval() {} });
  frame.navigate = target => { frame.router = routerFor(target); return frame.render(); };
  frame.render = () => {
    runtime.reset();
    let tree = module.default({ title: "Records Management", icon: "fas fa-folder", ...frame.props });
    for (const node of nodes(tree, node => node.props.ref && typeof node.props.ref === "object")) {
      node.props.ref.current = { focus: () => focused.push(node.props.className), isConnected: true };
    }
    for (const node of nodes(tree, node => node.props.closeRef)) {
      node.props.closeRef.current = { focus: () => focused.push("Close navigation"), isConnected: true };
    }
    runtime.flush();
    runtime.reset();
    tree = module.default({ title: "Records Management", icon: "fas fa-folder", ...frame.props });
    return frame.tree = tree;
  };
  frame.sidebar = () => nodes(frame.tree, node => node.type === parts.AppSidebar)[0];
  frame.account = () => nodes(frame.tree, node => node.type === parts.AccountMenu)[0];
  frame.dialog = () => nodes(frame.tree, node => node.type === parts.ProfileDialog)[0];
  frame.toggle = () => nodes(frame.tree, hasClass("app-menu-toggle"))[0];
  frame.overlay = () => nodes(frame.tree, hasClass("app-overlay"))[0];
  frame.identity = () => nodes(frame.tree, node => node.type === SystemLogo.OfficeIdentity)[0];
  frame.render();
  return frame;
}

test("every signed-in role gets the same header: office identity, page title and account entry", () => {
  const { OFFICE_IDENTITY } = branding();
  assert.equal(OFFICE_IDENTITY.fullName, "Cabadbaran City Health Office and Family Planning Center");
  const expected = { superadmin: "Super Administrator", frontdesk: "Front Desk Staff", admin1: "Doctor", admin2: "Doctor", admin3: "Doctor" };
  for (const [id, roleLabel] of Object.entries(expected)) {
    const frame = mountFrame({ user: accounts[id], props: { title: "Patient Management" } });
    assert.equal(frame.identity().props.variant, "header", id);
    assert.equal(text(nodes(frame.tree, node => node.type === "h1")[0]), "Patient Management", id);
    assert.equal(frame.account().props.account.id, id);
    assert.equal(frame.account().props.account.roleLabel, roleLabel);
    assert.ok(frame.sidebar(), `${id} has the sidebar`);
    assert.match(text(nodes(frame.tree, node => node.type === "footer")[0]), /Cabadbaran City Health Office and Family Planning Center/);
    assert.doesNotMatch(text(frame.tree), /Welcome|Admin Menu|Smart Queuing System/, id);
  }
});

test("a guest on a public page sees the office identity but no staff navigation or account menu", () => {
  const frame = mountFrame({ user: null, url: "/fill-up_form", props: { title: "Patient Registration" } });
  assert.ok(frame.identity());
  assert.equal(frame.sidebar(), undefined);
  assert.equal(frame.toggle(), undefined);
  assert.equal(frame.account(), undefined);
  assert.equal(frame.overlay(), undefined);
});

test("the sidebar menu follows the URL across page changes, Back/Forward and refresh without logging out", () => {
  const frame = mountFrame({ url: "/records?category=patients" });
  const expectedActive = ["/records?category=staff", "/records?category=accounts", "/?section=home", "/analytics", "/records?category=patients"];
  for (const url of expectedActive) {
    frame.navigate(url);
    const at = frame.sidebar().props.location;
    assert.equal(at.path, new URL(url, "http://x").pathname, url);
    assert.equal(frame.account().props.account.roleLabel, "Super Administrator", url);
  }
  assert.equal(frame.auth.logouts, 0);
  const refreshed = mountFrame({ url: "/records?category=accounts" });
  assert.equal(refreshed.sidebar().props.location.category, "accounts");
  assert.equal(refreshed.sidebar().props.visible, false, "a narrow screen starts with the drawer closed");
});

test("on narrow screens the drawer opens and closes by button, overlay, link and Escape, managing focus", () => {
  const frame = mountFrame();
  assert.equal(frame.toggle().props["aria-expanded"], false);
  assert.equal(frame.toggle().props["aria-controls"], "app-sidebar");
  const open = () => { frame.toggle().props.onClick(); return frame.render(); };
  open();
  assert.equal(frame.sidebar().props.visible, true);
  assert.ok(hasClass("is-visible")(frame.overlay()));
  assert.equal(frame.toggle().props["aria-label"], "Hide navigation");
  assert.equal(frame.focused.at(-1), "Close navigation", "focus moves into the drawer");

  frame.sidebar().props.onClose(true);
  frame.render();
  assert.equal(frame.sidebar().props.visible, false);
  assert.equal(frame.focused.at(-1), "app-menu-toggle", "focus returns to the menu button");

  open();
  frame.listeners.get("keydown")({ key: "Escape" });
  frame.render();
  assert.equal(frame.sidebar().props.visible, false);
  assert.equal(frame.listeners.has("keydown"), false);

  open();
  frame.overlay().props.onClick();
  assert.equal(frame.render() && frame.sidebar().props.visible, false);

  open();
  const before = frame.focused.length;
  frame.sidebar().props.onNavigate();
  assert.equal(frame.render() && frame.sidebar().props.visible, false, "following a link closes the drawer");
  assert.equal(frame.focused.length, before);
});

test("on wide screens the sidebar is docked; the toggle collapses it and the choice is remembered", () => {
  const storage = {};
  const frame = mountFrame({ docked: true, storage });
  assert.equal(frame.sidebar().props.visible, true);
  assert.equal(frame.sidebar().props.docked, true);
  assert.ok(!hasClass("is-visible")(frame.overlay()), "no overlay beside a docked sidebar");
  frame.toggle().props.onClick();
  frame.render();
  assert.equal(frame.sidebar().props.visible, false);
  assert.ok(hasClass("is-collapsed")(frame.tree));
  assert.equal(storage.city_health_sidebar_collapsed, "1");
  frame.sidebar().props.onNavigate();
  assert.equal(frame.render() && hasClass("is-collapsed")(frame.tree), true, "navigation keeps the collapsed choice");

  const next = mountFrame({ docked: true, storage, url: "/analytics" });
  assert.equal(next.sidebar().props.visible, false, "the next page remembers the collapsed sidebar");
  const blocked = mountFrame({ docked: true, storage: { throws: true } });
  assert.equal(blocked.sidebar().props.visible, true, "blocked storage falls back to an open sidebar");
  blocked.toggle().props.onClick();
  assert.equal(blocked.render() && blocked.sidebar().props.visible, false);
});

test("My Profile and Sign Out come only from the header account menu; Sign Out is the existing logout", () => {
  const frame = mountFrame({ user: accounts.admin2 });
  assert.equal(frame.sidebar().props.onProfile, undefined, "the sidebar has no account actions");
  assert.equal(frame.sidebar().props.onLogout, undefined);
  assert.equal(frame.dialog(), undefined);
  frame.account().props.onProfile();
  frame.render();
  assert.equal(frame.dialog().props.account.assignment, "Doctor 2");
  frame.dialog().props.onClose();
  frame.render();
  assert.equal(frame.dialog(), undefined);
  frame.account().props.onLogout();
  assert.equal(frame.auth.logouts, 1, "Sign Out calls the session-revoking logout once");
});

test("page account actions such as Cancel Account are offered in My Profile, not the quick menu", () => {
  const actions = [{ label: "Cancel Account", icon: "fas fa-user-times", onClick() {} }];
  const frame = mountFrame({ user: accounts.admin1, props: { accountActions: actions } });
  assert.equal(frame.account().props.actions, undefined);
  frame.account().props.onProfile();
  frame.render();
  assert.equal(frame.dialog().props.actions, actions);
  const unknown = mountFrame({ user: { id_num: "x", role: "patient" } });
  assert.equal(unknown.sidebar(), undefined, "no empty sidebar for an account without work pages");
  assert.equal(unknown.toggle(), undefined);
  assert.equal(unknown.account().props.account.roleLabel, "Unrecognized role", "the account menu still offers Sign Out");
});

// --- Sidebar, account menu and profile dialog ----------------------------------

function renderSidebar(props) {
  const SystemLogo = { OfficeIdentity: function OfficeIdentity() {} };
  const module = load("components/AppSidebar.js", name => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "next/link") return Link;
    if (name === "./SystemLogo") return SystemLogo;
    throw new Error(`Unexpected dependency: ${name}`);
  });
  const { navigationFor, resolveAccount } = navigation();
  const calls = [];
  const tree = module.default({
    groups: navigationFor(resolveAccount(props.user || accounts.superadmin)), location: location(props.url || "/records?category=staff"),
    visible: props.visible ?? true, docked: props.docked ?? false, closeRef: {},
    onNavigate: () => calls.push("navigate"), onClose: restore => calls.push(`close:${restore}`),
    onSettings: props.onSettings
  });
  return { tree, calls, OfficeIdentity: SystemLogo.OfficeIdentity };
}
const items = tree => nodes(tree, hasClass("app-nav-item"));

test("the sidebar renders work links only, with one active item", () => {
  const { tree, calls, OfficeIdentity } = renderSidebar({});
  assert.equal(nodes(tree, node => node.type === OfficeIdentity)[0].props.variant, "sidebar");
  assert.equal(tree.props.inert, false);
  const active = items(tree).filter(node => node.props["aria-current"] === "page");
  assert.deepEqual(active.map(node => text(node).trim()), ["Staff Records"]);
  const live = items(tree).find(node => text(node).includes("Live Queue Display"));
  assert.equal(live.props.target, "_blank");
  assert.match(text(live), /opens in a new tab/);
  assert.doesNotMatch(text(tree), /My Profile|Sign Out|Cancel Account/);
  assert.ok(items(tree).every(node => node.type === Link), "without a page Settings dialog every row is a link");
  for (const id of ["admin1", "frontdesk"]) {
    assert.doesNotMatch(text(renderSidebar({ user: accounts[id], url: "/admin1" }).tree), /My Profile|Sign Out|Cancel Account/, id);
  }
  items(tree)[0].props.onClick();
  assert.deepEqual(calls, ["navigate"]);
  nodes(tree, hasClass("app-sidebar-close"))[0].props.onClick();
  assert.equal(calls.at(-1), "close:true");
  assert.equal(nodes(tree, node => node.type === "nav")[0].props["aria-label"], "Main navigation");
});

test("System Settings opens the page's dialog when it has one, otherwise links to the dashboard", () => {
  let opened = 0;
  const withDialog = renderSidebar({ onSettings: () => opened++ });
  const settings = items(withDialog.tree).find(node => text(node).includes("System Settings"));
  assert.equal(settings.type, "button");
  settings.props.onClick();
  assert.equal(opened, 1);
  const without = items(renderSidebar({}).tree).find(node => text(node).includes("System Settings"));
  assert.equal(without.type, Link);
  assert.equal(without.props.href, "/?section=settings");
});

test("a hidden drawer is inert and a docked sidebar has no close button", () => {
  assert.equal(renderSidebar({ visible: false }).tree.props.inert, true);
  assert.equal(nodes(renderSidebar({ docked: true }).tree, hasClass("app-sidebar-close")).length, 0);
});

function mountAccountMenu(props = {}) {
  const runtime = hookRuntime();
  const listeners = new Map(), focused = [];
  const document = {
    activeElement: null,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); }
  };
  const module = load("components/AccountMenu.js", name => {
    if (name === "react") return runtime.react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    throw new Error(`Unexpected dependency: ${name}`);
  }, { document });
  const { resolveAccount } = navigation();
  const calls = [];
  const menu = {
    listeners, focused, calls,
    props: { account: resolveAccount(accounts.frontdesk), onProfile: () => calls.push("profile"), onLogout: () => calls.push("logout"), ...props },
    render(component = module.default) {
      runtime.reset();
      const tree = component(menu.props);
      for (const node of nodes(tree, node => node.props.ref && typeof node.props.ref === "object")) {
        node.props.ref.current = { focus: () => focused.push(node.props.className), contains: () => false,
          querySelectorAll: () => [] };
      }
      runtime.flush();
      runtime.reset();
      return menu.tree = component(menu.props);
    },
    module
  };
  return menu;
}

test("the account menu summarizes the session account and closes on Escape, outside click or a choice", () => {
  // A stray actions prop is ignored: quick-menu choices are only My Profile and Sign Out.
  const menu = mountAccountMenu({ actions: [{ label: "Cancel Account", icon: "fas fa-user-times", onClick: () => menu.calls.push("cancel") }] });
  let tree = menu.render();
  const button = () => nodes(menu.tree, hasClass("app-account-button"))[0];
  assert.equal(button().props["aria-expanded"], false);
  assert.equal(button().props["aria-label"], "Account: frontdesk, Front Desk Staff");
  assert.equal(nodes(tree, hasClass("app-account-panel")).length, 0);

  button().props.onClick();
  tree = menu.render();
  const panel = nodes(tree, hasClass("app-account-panel"))[0];
  assert.equal(text(nodes(panel, hasClass("app-account-summary"))[0]), "frontdeskFront Desk StaffFront desk");
  assert.deepEqual(nodes(panel, node => node.type === "button").map(node => text(node)), ["My Profile", "Sign Out"]);

  menu.listeners.get("keydown")({ key: "Escape" });
  tree = menu.render();
  assert.equal(nodes(tree, hasClass("app-account-panel")).length, 0);
  assert.equal(menu.focused.at(-1), "app-account-button");

  button().props.onClick(); menu.render();
  menu.listeners.get("mousedown")({ target: {} });
  assert.equal(nodes(menu.render(), hasClass("app-account-panel")).length, 0);

  for (const label of ["My Profile", "Sign Out"]) {
    button().props.onClick();
    const choice = nodes(menu.render(), node => node.type === "button" && text(node) === label)[0];
    choice.props.onClick();
    assert.equal(nodes(menu.render(), hasClass("app-account-panel")).length, 0, label);
  }
  assert.deepEqual(menu.calls, ["profile", "logout"]);
});

test("the account menu shows each doctor's verified assignment", () => {
  const { resolveAccount } = navigation();
  for (const id of ["admin1", "admin2", "admin3"]) {
    const menu = mountAccountMenu({ account: resolveAccount(accounts[id]) });
    nodes(menu.render(), hasClass("app-account-button"))[0].props.onClick();
    const summary = text(nodes(menu.render(), hasClass("app-account-summary"))[0]);
    assert.equal(summary, `${id}Doctor${`Doctor ${id.slice(-1)}`}`);
  }
});

test("Cancel Account sits in My Profile under Account management and opens the page's own confirmation", () => {
  const steps = [];
  const { resolveAccount } = navigation();
  const menu = mountAccountMenu({
    account: resolveAccount(accounts.admin1), onClose: () => steps.push("close-profile"),
    actions: [{ label: "Cancel Account", icon: "fas fa-user-times", onClick: () => steps.push("open-confirmation") }]
  });
  const tree = menu.render(menu.module.ProfileDialog);
  const section = nodes(tree, hasClass("app-profile-manage"))[0];
  assert.match(text(section), /^Account management/);
  const action = nodes(section, node => node.type === "button")[0];
  assert.equal(action.props.type, "button");
  action.props.onClick();
  assert.deepEqual(steps, ["close-profile", "open-confirmation"], "nothing is submitted from the profile itself");
  const plainProfile = mountAccountMenu({ account: resolveAccount(accounts.superadmin), onClose() {} });
  assert.equal(nodes(plainProfile.render(plainProfile.module.ProfileDialog), hasClass("app-profile-manage")).length, 0);
});

test("My Profile is read-only and shows only session fields", () => {
  let closed = 0;
  const { resolveAccount } = navigation();
  const menu = mountAccountMenu({ account: resolveAccount({ ...accounts.admin3, token: "secret-jwt", password: "hash" }), onClose: () => closed++ });
  const tree = menu.render(menu.module.ProfileDialog);
  const dialog = nodes(tree, node => node.props.role === "dialog")[0];
  assert.equal(dialog.props["aria-modal"], "true");
  assert.deepEqual(nodes(dialog, node => node.type === "dt").map(text), ["Account ID", "Role", "Stored role", "Assignment"]);
  assert.deepEqual(nodes(dialog, node => node.type === "dd").map(text), ["admin3", "Doctor", "admin", "Doctor 3"]);
  assert.doesNotMatch(text(tree), /secret-jwt|hash|password/i);
  assert.equal(nodes(dialog, node => ["input", "select", "textarea"].includes(node.type)).length, 0, "nothing editable");
  assert.equal(menu.focused.at(-1), "app-dialog-close", "focus starts on Close");
  menu.listeners.get("keydown")({ key: "Escape" });
  assert.equal(closed, 1);
});

test("the office identity uses one wording, with the system name only in the sidebar", () => {
  const SystemLogo = load("components/SystemLogo.js", name => name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" } : branding());
  const header = SystemLogo.OfficeIdentity({ variant: "header" });
  const sidebar = SystemLogo.OfficeIdentity({ variant: "sidebar" });
  assert.equal(text(header), "Cabadbaran City Health Officeand Family Planning Center");
  assert.equal(text(sidebar), "Cabadbaran City Health Officeand Family Planning CenterQueue Management System");
  const logo = nodes(header, node => node.type === SystemLogo.default)[0];
  assert.equal(logo.props.decorative, true, "the name beside it already identifies the office");
  assert.equal(SystemLogo.default({ variant: "login" }).props.alt, "Cabadbaran City Health Office and Family Planning Center official logo");
  assert.equal(SystemLogo.default({ decorative: true }).props.alt, "");
});

// --- Records page uses the shell -------------------------------------------------

test("Records renders inside the shared shell and keeps its Super Admin guard", () => {
  const mount = ({ user = accounts.superadmin, loading = false } = {}) => {
    const runtime = hookRuntime();
    const router = { query: { category: "patients" }, replaced: [], replace(to) { router.replaced.push(to); }, push() {} };
    function SiteFrame() {}
    const page = load("pages/records.js", name => {
      if (name === "react") return runtime.react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/router") return { useRouter: () => router };
      if (name === "../context/AuthContext") return { useAuth: () => ({ user, loading }) };
      if (name === "../components/SiteFrame") return SiteFrame;
      if (name === "../components/RecordsFilters") return function RecordsFilters() {};
      if (name === "../components/RecordsTable") return { recordsTable: () => null, recordsPagination: () => null, recordsButtonClass: "" };
      if (name === "../lib/recordsFilters") return { cleanRecordFilters: () => ({}), recordsQuery: () => "page=1&limit=20" };
      if (name === "../lib/api") return { request: () => new Promise(() => {}) };
      throw new Error(`Unexpected dependency: ${name}`);
    }, { setInterval: () => 1, clearInterval() {} });
    runtime.reset();
    const tree = page.default();
    runtime.flush();
    return { tree, router, SiteFrame };
  };
  const ok = mount();
  assert.equal(ok.tree.type, ok.SiteFrame);
  assert.equal(ok.tree.props.title, "Records Management");
  assert.equal(ok.tree.props.sidebarLinks, undefined);
  const doctor = mount({ user: accounts.admin1 });
  assert.deepEqual(doctor.router.replaced, ["/login"]);
  assert.notEqual(doctor.tree.type, doctor.SiteFrame);
});
