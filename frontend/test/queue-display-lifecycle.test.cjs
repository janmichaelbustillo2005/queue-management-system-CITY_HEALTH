const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const vm = require("node:vm");

const frontendPath = path.resolve(__dirname, "..");
const pagePath = path.join(frontendPath, "pages/queue-display.js");
const source = fs.readFileSync(pagePath, "utf8");
const recoverySource = fs.readFileSync(path.join(frontendPath, "lib/announcementRecovery.js"), "utf8")
  .replace(/\bexport (?=const|function)/g, "");
const pageStart = source.indexOf("const ANNOUNCE_GAP_MS_DEFAULT");
const jsxStart = source.lastIndexOf("\n  return (");
assert.ok(pageStart >= 0 && jsxStart > pageStart, "The actual page lifecycle must be available");

// Preserve every actual hook, effect and announcement function. Only replace
// the visual JSX with null, allowing the real ReactDOM reconciler to run in a
// minimal root container without a browser, audio service or new dependency.
const lifecycleSource = source.slice(pageStart, jsxStart)
  .replace("export default function QueueDisplayPage()", "function QueueDisplayPage()") + `
  capture({ loadDisplay, displayRef, displayStartedAtRef, announcedKeysRef,
    announcementQueueRef, activeAnnouncementKeyRef, isProcessingRef });
  return null;
}
this.QueueDisplayPage = QueueDisplayPage;
`;

const at = (time) => Date.parse(`2026-10-10T01:00:${time}.000Z`);
const acceptance = (overrides = {}) => ({
  id: 103, queue_number: "FP-SYNTHETIC", id_num: "Synthetic Lifecycle Patient",
  status: "serving", counter_name: "Doctor 3", called_at: at("20"),
  accepted_at: new Date(at("45")).toISOString(), announcement_key: "lifecycle-acceptance", ...overrides
});

function createLifecycleHarness({ holdHealth = false } = {}) {
  let now = at("30"), currentDisplay = { voice_announcements: [] }, captured;
  let healthHeld = holdHealth, timerId = 0, activeRoot = null;
  const storageValues = new Map(), timeouts = new Map(), intervals = new Map();
  const pendingHealth = [], speech = [], errors = [];
  const storage = {
    getItem: key => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: key => storageValues.delete(key)
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Element {
    constructor(tag, ownerDocument) {
      this.nodeType = 1;
      this.tagName = this.nodeName = tag.toUpperCase();
      this.ownerDocument = ownerDocument;
      this.style = {};
      this.namespaceURI = "http://www.w3.org/1999/xhtml";
      this.childNodes = [];
    }
    addEventListener() {} removeEventListener() {} setAttribute() {} removeAttribute() {}
    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; }
    removeChild(child) { this.childNodes = this.childNodes.filter(item => item !== child); }
  }
  const document = {
    nodeType: 9, addEventListener() {}, removeEventListener() {},
    createElement(tag) { return new Element(tag, document); }
  };
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.activeElement = document.body;
  const window = { document, sessionStorage: storage, HTMLIFrameElement: class {} };
  document.defaultView = window;

  const response = data => ({ ok: true, json: async () => data });
  const ready = () => response({ engine: "pyttsx3", ready: true });
  const context = vm.createContext({
    window, document, navigator: { userAgent: "isolated-lifecycle-test" }, Date: ClockDate, AbortController, queueMicrotask,
    process: { env: { NODE_ENV: "development", NEXT_PUBLIC_TTS_DEBUG: "0" } },
    console: { info() {}, warn() {}, error(...args) { errors.push(args); } },
    setTimeout(callback) { const id = ++timerId; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback) { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    defaultQueueSettings: { voiceAnnouncements: true, soundNotifications: true, announceDoctorRoom: true, announceGapSeconds: 0 },
    mergeQueueSettings: raw => ({ voiceAnnouncements: true, soundNotifications: true, announceDoctorRoom: true, announceGapSeconds: 0, ...raw }),
    persistLocalQueueSettings() {},
    async request(route) { assert.equal(route, "/display"); return currentDisplay; },
    async fetch(url, options = {}) {
      if (url.includes("/health")) {
        if (healthHeld) return new Promise(resolve => pendingHealth.push(() => resolve(ready())));
        return ready();
      }
      assert.equal(url, "http://127.0.0.1:8765/speak");
      const payload = JSON.parse(options.body);
      speech.push(payload);
      return response({ success: true, key: payload.key });
    },
    capture(value) { captured = value; }
  });

  // React, ReactDOM and the scheduler mock have a private CommonJS cache and
  // globals inside this VM. No host require.cache/global.window changes leak
  // into other files when the suite uses --test-isolation=none.
  const moduleCache = new Map();
  const resolveFromFrontend = createRequire(path.join(frontendPath, "package.json"));
  const schedulerMockPath = resolveFromFrontend.resolve("scheduler/unstable_mock");
  function loadModule(filename) {
    if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
    const module = { exports: {} };
    moduleCache.set(filename, module);
    const resolveLocal = createRequire(filename);
    const localRequire = name => loadModule(name === "scheduler" ? schedulerMockPath : resolveLocal.resolve(name));
    const wrapper = vm.runInContext(`(function(exports, require, module, __filename, __dirname) {\n${fs.readFileSync(filename, "utf8")}\n})`, context, { filename });
    wrapper(module.exports, localRequire, module, filename, path.dirname(filename));
    return module.exports;
  }
  const React = loadModule(resolveFromFrontend.resolve("react"));
  const ReactDOM = loadModule(resolveFromFrontend.resolve("react-dom/client"));
  const scheduler = loadModule(schedulerMockPath);
  Object.assign(context, { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect });
  vm.runInContext(`${recoverySource}\n${lifecycleSource}`, context, { filename: pagePath });

  async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async function settle() {
    for (let i = 0; i < 5; i++) {
      await microtasks();
      scheduler.unstable_flushAllWithoutAsserting();
    }
  }
  return {
    speech,
    get refs() { return captured; },
    get intervalCount() { return intervals.size; },
    cursor() {
      const values = [...storageValues.values()];
      assert.equal(values.length, 1);
      return JSON.parse(values[0]);
    },
    advanceTo(value) { now = value; },
    async mount(data = currentDisplay) {
      currentDisplay = data;
      activeRoot = ReactDOM.createRoot(document.createElement("div"));
      activeRoot.render(React.createElement(context.QueueDisplayPage));
      await settle();
    },
    async load(data) { currentDisplay = data; await captured.loadDisplay(); },
    async commitUntilPaint() { await microtasks(); scheduler.unstable_flushUntilNextPaint(); },
    settle,
    unmount() { activeRoot.unmount(); activeRoot = null; },
    async releaseHealth() {
      healthHeld = false;
      pendingHealth.splice(0).forEach(resolve => resolve());
      await settle();
    },
    async dispose() {
      if (activeRoot) { activeRoot.unmount(); activeRoot = null; }
      healthHeld = false;
      pendingHealth.splice(0).forEach(resolve => resolve());
      await settle();
      assert.equal(intervals.size, 0, "Unmount must remove both display timers");
      assert.equal(timeouts.size, 0, "Settled health/speech requests must release their timeouts");
      assert.deepEqual(errors, [], "The real React lifecycle must finish without render errors");
    }
  };
}

test("a pending older passive effect cannot consume an unfinished acceptance across unmount and return", async (t) => {
  const h = createLifecycleHarness({ holdHealth: true });
  t.after(() => h.dispose());
  await h.mount();
  h.advanceTo(at("40"));
  await h.load({ voice_announcements: [] });
  await h.commitUntilPaint();

  // A slow earlier poll commits its empty snapshot. Before its passive effects
  // run, the next response exposes a still-unposted acceptance from :45.
  h.advanceTo(at("50"));
  const accepted = acceptance();
  await h.load({ voice_announcements: [accepted] });
  assert.equal(h.refs.activeAnnouncementKeyRef.current, accepted.announcement_key);
  assert.equal(h.cursor().sinceMs, at("45"));
  h.unmount();
  assert.equal(h.intervalCount, 0);
  assert.equal(h.cursor().sinceMs, at("45"), "Cleanup must retain the unfinished event even while old passive effects flush");

  h.advanceTo(at("55"));
  await h.mount({ voice_announcements: [accepted] });
  assert.equal(h.refs.announcedKeysRef.current.has(accepted.announcement_key), false, "An unplayed acceptance must remain recoverable on return");
  assert.equal(h.refs.activeAnnouncementKeyRef.current, accepted.announcement_key);
  await h.releaseHealth();
  assert.deepEqual(h.speech.map(item => item.key), [accepted.announcement_key]);
  assert.equal(h.refs.isProcessingRef.current, false);
});

test("an authoritative withdrawal remains silent through the real unmount and return lifecycle", async (t) => {
  const h = createLifecycleHarness({ holdHealth: true });
  t.after(() => h.dispose());
  await h.mount();
  h.advanceTo(at("50"));
  const accepted = acceptance();
  await h.load({ voice_announcements: [accepted] });
  h.advanceTo(at("52"));
  const withdrawn = { voice_announcements: [], recent_accepted: [{ ...accepted, status: "cancelled" }] };
  await h.load(withdrawn);
  h.unmount();
  h.advanceTo(at("55"));
  await h.mount(withdrawn);
  await h.releaseHealth();
  assert.equal(h.speech.length, 0);
  assert.equal(h.refs.announcementQueueRef.current.length, 0);
  assert.equal(h.refs.activeAnnouncementKeyRef.current, null);
});

test("a finished announcement does not replay after real unmount and return without service dedupe", async (t) => {
  const h = createLifecycleHarness();
  t.after(() => h.dispose());
  await h.mount();
  h.advanceTo(at("50"));
  const accepted = acceptance();
  await h.load({ voice_announcements: [accepted] });
  await h.settle();
  assert.deepEqual(h.speech.map(item => item.key), [accepted.announcement_key]);
  h.unmount();
  h.advanceTo(at("55"));
  await h.mount({ voice_announcements: [accepted] });
  assert.deepEqual(h.speech.map(item => item.key), [accepted.announcement_key]);
  assert.equal(h.refs.announcedKeysRef.current.has(accepted.announcement_key), true);
});
