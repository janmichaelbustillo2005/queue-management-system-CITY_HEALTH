// Doctor queue notifications: the rules (lib/queueNotifications.js) and the bell, toast, tab title
// and desktop notification (components/DoctorQueueNotifications.js), rendered with an isolated hook
// harness and a synthetic browser (Notification API, page visibility, storage).
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const compiled = {};
function compile(relative) {
  if (!compiled[relative]) {
    const filename = path.join(__dirname, "..", relative);
    compiled[relative] = swc.transformSync(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    }).code;
  }
  return compiled[relative];
}
function load(relative, context = {}, resolve = () => { throw new Error("no dependencies expected"); }) {
  const module = { exports: {} };
  vm.runInNewContext(compile(relative), { module, exports: module.exports, require: resolve, Set, Map, JSON, Date, Number, String, Array, Object, ...context });
  return module.exports;
}

let lib;
before(async () => {
  await swc.loadBindings();
  lib = load("lib/queueNotifications.js");
});

const DAY = "2026-11-14";
function summary(ids, { doctor = "Doctor 2", ready = 0, notPresent = 0, date = DAY } = {}) {
  return { doctor, business_date: date, waiting: ids.length, ready, awaiting_confirmation: ids.length - ready - notPresent,
    not_present: notPresent, visit_ids: ids, observed_at: "2026-11-14T01:00:00.000Z" };
}
const read = (raw) => lib.readDoctorQueueSummary(raw);
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

// ---- rules ----

test("the first observation is a baseline, never an arrival (initial page load)", () => {
  const s = read(summary([11, 12, 13]));
  const { tracker, arrival } = lib.observeDoctorQueue(null, s, { key: lib.trackerKey("admin2", s) });
  assert.equal(arrival, null);
  assert.deepEqual(tracker.seen, [11, 12, 13]);
  assert.equal(tracker.entries.length, 0);
});

test("a new patient for this doctor is one arrival; the count is the current total, not all new", () => {
  const key = lib.trackerKey("admin2", read(summary([11, 12, 13])));
  const base = lib.observeDoctorQueue(null, read(summary([11, 12, 13])), { key }).tracker;
  const { tracker, arrival } = lib.observeDoctorQueue(base, read(summary([11, 12, 13, 14])), { key, now: Date.parse("2026-11-14T01:05:00Z") });
  assert.equal(arrival.newCount, 1);
  assert.equal(arrival.waiting, 4);
  assert.equal(lib.newArrivalText(arrival.newCount), "1 new patient was assigned to your queue.");
  assert.equal(lib.patientsWaitingText(4), "4 patients are currently waiting in your queue.");
  assert.equal(tracker.entries.length, 1);
  // The same snapshot again (a repeated poll, a duplicate event) adds nothing.
  assert.equal(lib.observeDoctorQueue(tracker, read(summary([11, 12, 13, 14])), { key }).arrival, null);
});

test("a refresh restores the saved tracker, so already-waiting patients are not new", () => {
  const storage = memoryStorage();
  const s = read(summary([11, 12, 13]));
  const key = lib.trackerKey("admin2", s);
  lib.saveTracker(storage, lib.observeDoctorQueue(null, s, { key }).tracker);
  const restored = lib.loadTracker(storage);
  assert.ok(restored);
  assert.equal(lib.observeDoctorQueue(restored, s, { key }).arrival, null);
});

test("confirmation, Call, completion and Undo change the count without a new-arrival alert", () => {
  const key = lib.trackerKey("admin2", read(summary([11, 12, 13])));
  let tracker = lib.observeDoctorQueue(null, read(summary([11, 12, 13])), { key }).tracker;
  for (const next of [
    summary([11, 12, 13], { ready: 1 }), // Front Desk confirms 11
    summary([12, 13]), // 11 called (serving), then completed
    summary([11, 12, 13], { ready: 1 }), // Undo returns 11 to waiting
    summary([13]) // 11 and 12 cancelled / no-show
  ]) {
    const result = lib.observeDoctorQueue(tracker, read(next), { key });
    assert.equal(result.arrival, null, JSON.stringify(next));
    tracker = result.tracker;
  }
});

test("missed updates during an outage give one arrival for the visits that really arrived", () => {
  const key = lib.trackerKey("admin2", read(summary([11, 12])));
  const base = lib.observeDoctorQueue(null, read(summary([11, 12])), { key }).tracker;
  const { arrival } = lib.observeDoctorQueue(base, read(summary([12, 15, 16])), { key });
  assert.equal(arrival.newCount, 2);
  assert.equal(arrival.waiting, 3);
});

test("another account, doctor or business day starts a new baseline", () => {
  const s = read(summary([11, 12]));
  const base = lib.observeDoctorQueue(null, s, { key: lib.trackerKey("admin2", s) }).tracker;
  const nextDay = read(summary([11, 12, 21], { date: "2026-11-15" }));
  const result = lib.observeDoctorQueue(base, nextDay, { key: lib.trackerKey("admin2", nextDay) });
  assert.equal(result.arrival, null);
  const other = read(summary([11, 12, 31], { doctor: "Doctor 1" }));
  assert.equal(lib.observeDoctorQueue(base, other, { key: lib.trackerKey("admin1", other) }).arrival, null);
});

test("dismissing or clearing notifications never changes the waiting count", () => {
  const key = lib.trackerKey("admin2", read(summary([11])));
  const base = lib.observeDoctorQueue(null, read(summary([11])), { key }).tracker;
  const withArrival = lib.observeDoctorQueue(base, read(summary([11, 12])), { key }).tracker;
  assert.equal(lib.unreadCount(withArrival), 1);
  assert.equal(lib.unreadCount(lib.markEntriesRead(withArrival)), 0);
  const cleared = lib.clearEntries(withArrival);
  assert.equal(cleared.entries.length, 0);
  assert.deepEqual(cleared.seen, [11, 12], "cleared patients are still known, so they never re-alert");
});

test("only a consistent server summary is used", () => {
  assert.equal(read(null), null);
  assert.equal(read({ ...summary([1, 2]), waiting: 3 }), null);
  assert.equal(read({ ...summary([1, 2]), ready: 5 }), null);
  assert.equal(read({ ...summary([1, 2]), visit_ids: [1, "2"] }), null);
  assert.equal(read({ ...summary([1]), doctor: "" }), null);
  assert.equal(read(summary([2, 1])).visitIds.join(), "1,2");
});

test("tab title shows the doctor's own count and returns to the page title at zero", () => {
  assert.equal(lib.queueTabTitle(3, "Doctor 2 Queue"), "(3) Doctor 2 Queue | Smart Queue System");
  assert.equal(lib.queueTabTitle(0, "Doctor 2 Queue"), null);
  assert.equal(lib.badgeText(120), "99+");
});

test("desktop support and the one-tab-notifies rule", () => {
  assert.equal(lib.desktopNotificationState({}), "unsupported");
  function N() {}
  N.permission = "granted";
  assert.equal(lib.desktopNotificationState({ Notification: N, isSecureContext: false }), "unsupported");
  assert.equal(lib.desktopNotificationState({ Notification: N, isSecureContext: true }), "granted");
  N.permission = "denied";
  assert.equal(lib.desktopNotificationState({ Notification: N }), "denied");
  const shared = memoryStorage();
  assert.equal(lib.claimDesktopAlert(shared, "a"), true);
  assert.equal(lib.claimDesktopAlert(shared, "a"), false);
  assert.equal(lib.claimDesktopAlert(shared, "b"), true);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(lib.loadTracker(broken), null);
  assert.doesNotThrow(() => lib.saveTracker(broken, {}));
  assert.doesNotThrow(() => lib.clearNotificationStorage(broken, broken));
  assert.equal(lib.claimDesktopAlert(broken, "a"), true);
});

// ---- component ----

function browser({ permission = "granted", hidden = false, notificationThrows = false, session = memoryStorage(), local = memoryStorage({ city_health_token: "t" }) } = {}) {
  const listeners = { window: new Map(), document: new Map() };
  const add = (target) => (type, fn) => { if (!listeners[target].has(type)) listeners[target].set(type, new Set()); listeners[target].get(type).add(fn); };
  const remove = (target) => (type, fn) => listeners[target].get(type)?.delete(fn);
  const shown = [];
  function Notification(title, options) {
    if (notificationThrows) throw new TypeError("Illegal constructor");
    const n = { title, ...options, closed: false, close() { this.closed = true; } };
    shown.push(n);
    return n;
  }
  Notification.permission = permission;
  Notification.requestPermission = async () => Notification.permission;
  const timers = [];
  const win = {
    Notification, isSecureContext: true, sessionStorage: session, localStorage: local,
    addEventListener: add("window"), removeEventListener: remove("window"),
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, focus() {}
  };
  const doc = {
    visibilityState: hidden ? "hidden" : "visible",
    addEventListener: add("document"), removeEventListener: remove("document"),
    getElementById: () => null
  };
  const fire = (target, type) => [...(listeners[target].get(type) || [])].forEach((fn) => fn({}));
  return { win, doc, shown, session, local, fire, timers };
}

function mount(env, initialProps) {
  const hooks = [], deps = [], cleanups = [];
  let cursor = 0, pending = [];
  const jsx = (type, props) => ({ type, props: props || {} });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === "function" ? initial() : initial;
      return [hooks[i], (next) => { hooks[i] = typeof next === "function" ? next(hooks[i]) : next; }];
    },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useEffect(fn, d) {
      const i = cursor++;
      if (!deps[i] || !d || d.some((v, k) => v !== deps[i][k])) { deps[i] = d; pending.push([i, fn]); }
    }
  };
  const component = load("components/DoctorQueueNotifications.js", { window: env.win, document: env.doc, Promise }, (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
    if (name === "next/head") return function Head() {};
    if (name === "../lib/api") return { AUTH_SESSION_CHANGED_EVENT: "city-health-auth-session-changed" };
    if (name === "../lib/branding") return { OFFICE_IDENTITY: { name: "Cabadbaran City Health Office" }, SYSTEM_BRANDING: { logoSrc: "/cho_logo-transparent.png" } };
    if (name === "../lib/queueNotifications") return lib;
    throw new Error(`Unexpected dependency: ${name}`);
  }).default;
  let props = initialProps;
  const render = () => { cursor = 0; return component(props); };
  const flush = () => {
    let tree;
    for (let round = 0; round < 4; round++) {
      tree = render();
      const run = pending.splice(0);
      for (const [i, fn] of run) { cleanups[i]?.(); cleanups[i] = fn() || null; }
      if (!run.length) break;
    }
    return render();
  };
  return {
    flush,
    update(next) { props = { ...props, ...next }; return flush(); },
    unmount() { cleanups.forEach((fn) => fn?.()); }
  };
}

function nodes(tree, predicate, out = []) {
  if (Array.isArray(tree)) tree.forEach((n) => nodes(n, predicate, out));
  else if (tree && typeof tree === "object") { if (predicate(tree)) out.push(tree); nodes(tree.props?.children, predicate, out); }
  return out;
}
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("") : tree && typeof tree === "object" ? text(tree.props?.children) : tree == null || typeof tree === "boolean" ? "" : String(tree);
const byClass = (tree, cls) => nodes(tree, (n) => typeof n.props?.className === "string" && n.props.className.split(" ").includes(cls));
const tabTitle = (tree) => nodes(tree, (n) => n.type === "title").map(text)[0] ?? null;
const props = (ids, extra = {}) => ({ summary: summary(ids, extra), status: "ready", accountId: "admin2", queueLabel: "Doctor 2 Queue", onRefresh() {}, queueAnchorId: "my-patient-queue" });

test("bell badge and tab title show the doctor's current count; the first load raises nothing", () => {
  const env = browser({ hidden: true });
  const view = mount(env, props([11, 12, 13]));
  const tree = view.flush();
  assert.equal(text(byClass(tree, "queue-notify-badge")), "3");
  assert.equal(tabTitle(tree), "(3) Doctor 2 Queue | Smart Queue System");
  assert.equal(byClass(tree, "queue-toast").length, 0);
  assert.equal(env.shown.length, 0);
});

test("a new patient while the tab is hidden: toast, title and one desktop notification without patient details", () => {
  const env = browser({ hidden: true });
  const view = mount(env, props([11, 12, 13]));
  view.flush();
  const tree = view.update({ summary: summary([11, 12, 13, 14]) });
  assert.equal(tabTitle(tree), "(4) Doctor 2 Queue | Smart Queue System");
  assert.match(text(byClass(tree, "queue-toast")), /New Patient Waiting.*1 new patient was assigned to your queue\. 4 patients are currently waiting/);
  assert.equal(env.shown.length, 1);
  const [n] = env.shown;
  assert.equal(n.title, "New Patient Waiting");
  assert.match(n.body, /^4 patients are currently waiting in your queue\.\nCabadbaran City Health Office – Smart Queue System$/);
  assert.equal(n.icon, "/cho_logo-transparent.png");
  assert.equal(n.tag, "city-health-queue-Doctor 2");
  // The same queue state polled again does not notify twice.
  view.update({ summary: { ...summary([11, 12, 13, 14]), observed_at: "2026-11-14T01:00:05.000Z" } });
  assert.equal(env.shown.length, 1);
});

test("while the dashboard is visible a new patient shows the in-app toast only", () => {
  const env = browser({ hidden: false });
  const view = mount(env, props([11]));
  view.flush();
  const tree = view.update({ summary: summary([11, 12]) });
  assert.equal(byClass(tree, "queue-toast").length, 1);
  assert.equal(env.shown.length, 0);
});

test("denied, unsupported or failing desktop notifications leave the in-app alerts working", () => {
  for (const env of [browser({ hidden: true, permission: "denied" }), browser({ hidden: true, notificationThrows: true })]) {
    const view = mount(env, props([11]));
    view.flush();
    let tree;
    assert.doesNotThrow(() => { tree = view.update({ summary: summary([11, 12]) }); });
    assert.equal(byClass(tree, "queue-toast").length, 1);
    assert.equal(tabTitle(tree), "(2) Doctor 2 Queue | Smart Queue System");
    assert.equal(env.shown.length, 0);
  }
  const unsupported = browser({ hidden: true });
  delete unsupported.win.Notification;
  const view = mount(unsupported, props([11]));
  view.flush();
  assert.equal(byClass(view.update({ summary: summary([11, 12]) }), "queue-toast").length, 1);
});

test("Front Desk confirmation and a Call update the count without any alert", () => {
  const env = browser({ hidden: true });
  const view = mount(env, props([11, 12]));
  view.flush();
  let tree = view.update({ summary: summary([11, 12], { ready: 1 }) });
  assert.equal(byClass(tree, "queue-toast").length, 0);
  tree = view.update({ summary: summary([12]) });
  assert.equal(text(byClass(tree, "queue-notify-badge")), "1");
  assert.equal(byClass(tree, "queue-toast").length, 0);
  assert.equal(env.shown.length, 0);
});

test("at zero waiting there is no badge and the page keeps its own title", () => {
  const view = mount(browser(), props([]));
  const tree = view.flush();
  assert.equal(byClass(tree, "queue-notify-badge").length, 0);
  assert.equal(tabTitle(tree), null);
  assert.equal(byClass(tree, "queue-notify-button").length, 1);
});

test("refreshing the page with the same waiting patients raises no alert", () => {
  const session = memoryStorage();
  const first = mount(browser({ session }), props([11, 12, 13]));
  first.flush();
  first.unmount();
  const env = browser({ session, hidden: true });
  const tree = mount(env, props([11, 12, 13])).flush();
  assert.equal(byClass(tree, "queue-toast").length, 0);
  assert.equal(env.shown.length, 0);
});

test("only one of several open tabs of the same doctor shows the desktop notification", () => {
  const local = memoryStorage({ city_health_token: "t" });
  const tabs = [browser({ hidden: true, local }), browser({ hidden: true, local })];
  const views = tabs.map((env) => mount(env, props([11])));
  views.forEach((view) => view.flush());
  views.forEach((view) => view.update({ summary: summary([11, 12]) }));
  assert.equal(tabs[0].shown.length + tabs[1].shown.length, 1);
});

test("returning to the tab or reconnecting reads the queue again at once", () => {
  const env = browser({ hidden: true });
  let refreshes = 0;
  const view = mount(env, { ...props([11]), onRefresh: () => { refreshes++; } });
  view.flush();
  env.doc.visibilityState = "visible";
  env.fire("document", "visibilitychange");
  env.fire("window", "online");
  assert.equal(refreshes, 2);
});

test("signing out forgets this account's notifications", () => {
  const env = browser();
  const view = mount(env, props([11]));
  view.flush();
  view.update({ summary: summary([11, 12]) });
  assert.ok(env.session.getItem(lib.NOTIFICATION_STORAGE_KEY));
  env.local.removeItem("city_health_token");
  env.fire("window", "city-health-auth-session-changed");
  assert.equal(env.session.getItem(lib.NOTIFICATION_STORAGE_KEY), null);
  assert.equal(byClass(view.flush(), "queue-toast").length, 0);
});

test("a connection problem keeps the last known count and says so", () => {
  const view = mount(browser(), props([11, 12]));
  view.flush();
  const tree = view.update({ status: "unavailable" });
  assert.equal(text(byClass(tree, "queue-notify-badge")), "2");
  assert.equal(tabTitle(tree), "(2) Doctor 2 Queue | Smart Queue System");
});

test("no summary (Superadmin, Front Desk or an older backend) renders nothing", () => {
  assert.equal(mount(browser(), { ...props([1]), summary: null }).flush(), null);
});
