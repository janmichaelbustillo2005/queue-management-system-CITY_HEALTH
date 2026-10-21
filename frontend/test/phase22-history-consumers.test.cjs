const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const compiled = {};
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const filterKeys = ["status", "service", "doctor", "dateFilter", "date", "startDate", "endDate"];
const allTimeFilters = { status: "", service: "", doctor: "", dateFilter: "", date: "", startDate: "", endDate: "" };
const jsx = (type, props) => ({ type, props: props || {} });

before(async () => {
  await swc.loadBindings();
  await Promise.all([
    "pages/records.js", "pages/analytics.js", "lib/api.js", "lib/queueSettings.js",
    "lib/historyFilters.js", "components/SettingsModal.js"
  ].map(async relative => {
    const filename = path.join(__dirname, "..", relative);
    compiled[relative] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }));
});

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
function button(tree, label) {
  const result = nodes(tree, node => node.type === "button" && text(node).trim() === label)[0];
  assert.ok(result, `Missing button: ${label}`);
  return result;
}
function selectedFilters(call) {
  return Object.fromEntries(filterKeys.map(key => [key, call.params[key]]));
}

function harness(component, options = {}) {
  const hooks = [], effectDeps = [], effects = [], calls = [], downloads = [], blobs = [], revoked = [], opens = [];
  const stored = new Map([["city_health_token", "synthetic-superadmin-token"]]);
  const storage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key)
  };
  const now = Date.parse(options.now || "2026-10-09T16:30:00Z");
  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  let cursor = 0;
  const react = {
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
    useMemo(callback) { cursor++; return callback(); },
    useEffect(callback, deps) {
      const index = cursor++;
      const previous = effectDeps[index];
      if (!previous || !deps || deps.some((value, i) => value !== previous[i])) {
        effectDeps[index] = deps;
        effects.push(callback);
      }
    }
  };
  const user = { id_num: "superadmin", role: "superadmin" };
  const router = { push() {} };
  const window = {
    localStorage: storage, open: (...args) => opens.push(args), confirm: () => true,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:synthetic-${blobs.length}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    dispatchEvent() {}
  };
  const document = {
    documentElement: {}, getElementById: () => null,
    body: { appendChild(link) { link.appended = true; } },
    createElement(tag) {
      assert.equal(tag, "a");
      const link = {
        click() { downloads.push({ href: link.href, filename: link.download, appended: link.appended }); },
        remove() { link.removed = true; }
      };
      return link;
    }
  };
  const csv = "Queue,Doctor\nOLD-001,Doctor 2\n";
  let blobReads = 0;
  function response(status, data, csvResponse = false) {
    return {
      ok: status >= 200 && status < 300, status, statusText: "Synthetic response",
      headers: { get: () => csvResponse ? "text/csv" : "application/json" },
      text: async () => csvResponse ? csv : JSON.stringify(data),
      json: async () => data,
      blob: async () => { blobReads++; return new Blob([csv], { type: "text/csv" }); }
    };
  }
  const globals = {
    console: { log() {}, error() {} }, Date: FixedDate, Intl, URL, URLSearchParams, Blob, Event,
    window, document, localStorage: storage, process: { env: { NEXT_PUBLIC_API_BASE_URL: "https://synthetic.invalid/api" } },
    getComputedStyle: () => ({ getPropertyValue: () => "#123456" }),
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
    fetch: async (rawUrl, init = {}) => {
      const url = new URL(rawUrl);
      const route = url.pathname.replace(/^\/api/, "");
      const call = { route, url: rawUrl, params: Object.fromEntries(url.searchParams),
        method: init.method || "GET", headers: clone(init.headers || {}) };
      calls.push(call);
      if (options.fetch) {
        const override = await options.fetch(call, response);
        if (override !== undefined) return override;
      }
      if (route === "/settings") return response(200, { settings: {} });
      if (route.endsWith("/export")) return response(200, null, true);
      if (route === "/transactions") {
        const page = Number(call.params.page || 1);
        return response(200, { transactions: [], stats: { completed: 0, cancelled: 0 }, pagination: {
          currentPage: page, totalPages: 2, totalRecords: 30, recordsPerPage: 20, hasNext: page < 2, hasPrev: page > 1
        } });
      }
      if (route === "/analytics") return response(200, { metrics: {}, tableData: [], charts: {
        serviceTypes: { labels: [], data: [] }, dailyTrends: { labels: [], data: [] }
      } });
      throw new Error(`Unexpected synthetic request: ${route}`);
    }
  };
  const dependencies = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "next/link": "Link", "next/script": "Script", "next/router": { useRouter: () => router },
    "../context/AuthContext": { useAuth: () => ({ user, loading: false }) },
    "../components/SiteFrame": "SiteFrame"
  };
  function load(relative) {
    const module = { exports: {} };
    vm.runInNewContext(compiled[relative], { ...globals, module, exports: module.exports,
      require(name) {
        if (name in dependencies) return dependencies[name];
        throw new Error(`Unexpected dependency ${name} from ${relative}`);
      }
    });
    return module.exports;
  }
  const modal = load("components/SettingsModal.js");
  dependencies["../components/SettingsModal"] = { __esModule: true, default: "SettingsModal", defaultQueueSettings: modal.defaultQueueSettings };
  const api = load("lib/api.js");
  dependencies["./api"] = api;
  dependencies["../lib/api"] = api;
  const history = load("lib/historyFilters.js");
  dependencies["./historyFilters"] = history;
  dependencies["../lib/historyFilters"] = history;
  const queue = load("lib/queueSettings.js");
  dependencies["../lib/queueSettings"] = queue;
  const page = component === "modal" ? modal.default : component ? load(`pages/${component}.js`).default : null;
  const props = component === "modal" ? {
    isOpen: true, settings: { ...modal.defaultQueueSettings, autoBackupReminder: false },
    onExport: options.onExport || (() => {}), onClose() {}, setSettings() {}
  } : undefined;
  const render = () => { cursor = 0; return page ? page(props) : null; };
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      render();
      effects.splice(0).forEach(effect => effect());
      await tick();
    }
    return render();
  };
  const field = label => {
    const result = nodes(render(), node => node.props["aria-label"] === label)[0];
    assert.ok(result, `Missing field: ${label}`);
    return result;
  };
  const change = (label, value) => field(label).props.onChange({ target: { value } });
  return { render, flush, field, change, calls, downloads, blobs, revoked, opens, storage, csv, history, queue,
    get blobReads() { return blobReads; },
    callsTo: route => calls.filter(call => call.route === route),
    lastCall: route => calls.filter(call => call.route === route).at(-1)
  };
}

test("history defaults use Manila dates at UTC midnight crossover and calendar year boundaries", () => {
  const h = harness();
  assert.equal(h.history.getManilaDate(new Date("2026-10-09T15:59:59.999Z")), "2026-10-09");
  assert.equal(h.history.getManilaDate(new Date("2026-10-09T16:00:00.000Z")), "2026-10-10");
  assert.deepEqual(clone(h.history.getDefaultHistoryFilters(new Date("2026-10-09T16:30:00Z"))), {
    ...allTimeFilters, dateFilter: "range", startDate: "2026-10-04", endDate: "2026-10-10"
  });
  assert.deepEqual(clone(h.history.getDefaultHistoryFilters(new Date("2025-12-31T16:00:00Z"))), {
    ...allTimeFilters, dateFilter: "range", startDate: "2025-12-26", endDate: "2026-01-01"
  });
});

test("Records initial All Time request and Export Records retain the explicit blank date filter", async () => {
  const h = harness("records"); await h.flush();
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), allTimeFilters);
  await button(h.render(), "Export Records").props.onClick();
  assert.deepEqual(selectedFilters(h.lastCall("/queue/export")), allTimeFilters);
  assert.equal(h.lastCall("/queue/export").headers.Authorization, "Bearer synthetic-superadmin-token");
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].filename, "queue_data_2026-10-10.csv");
});

test("Records specific date, doctor, service and status share exactly the selected export filters", async () => {
  const h = harness("records"); await h.flush();
  h.change("Date filter", "date");
  h.change("Specific date", "2026-10-09");
  h.change("Doctor", "Doctor 2");
  h.change("Service", "prenatal");
  h.change("Status", "completed");
  await h.flush();
  await button(h.render(), "Apply").props.onClick();
  const expected = { ...allTimeFilters, dateFilter: "date", date: "2026-10-09", doctor: "Doctor 2", service: "prenatal", status: "completed" };
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), expected);
  await button(h.render(), "Export Records").props.onClick();
  assert.deepEqual(selectedFilters(h.lastCall("/queue/export")), expected);
  assert.equal(h.lastCall("/queue/export").params.format, "csv");
});

test("Records range filters survive pagination and refresh, then Reset clears dates and doctor", async () => {
  const h = harness("records"); await h.flush();
  h.change("Date filter", "date"); h.change("Specific date", "2026-10-08");
  h.change("Date filter", "range");
  h.change("Start date", "2026-10-09"); h.change("End date", "2026-10-10");
  h.change("Doctor", "Doctor 3"); await h.flush();
  const expected = { ...allTimeFilters, dateFilter: "range", startDate: "2026-10-09", endDate: "2026-10-10", doctor: "Doctor 3" };
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), expected);
  await button(h.render(), "Next").props.onClick();
  assert.equal(h.lastCall("/transactions").params.page, "2");
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), expected);
  await button(h.render(), "Refresh").props.onClick();
  assert.equal(h.lastCall("/transactions").params.page, "2");
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), expected);
  await button(h.render(), "Export Records").props.onClick();
  assert.deepEqual(selectedFilters(h.lastCall("/queue/export")), expected);
  await button(h.render(), "Reset").props.onClick(); await h.flush();
  assert.deepEqual(selectedFilters(h.lastCall("/transactions")), allTimeFilters);
  assert.equal(h.lastCall("/transactions").params.page, "1");
});

test("Records incomplete date filters suppress automatic reads and report explicit read/export validation", async () => {
  const h = harness("records", { fetch(call, response) {
    if (!["/transactions", "/queue/export"].includes(call.route)) return undefined;
    if ((call.params.dateFilter === "date" && !call.params.date) ||
        (call.params.dateFilter === "range" && (!call.params.startDate || !call.params.endDate))) {
      return response(400, { message: "Synthetic date validation failed" });
    }
    return undefined;
  } });
  await h.flush();
  for (const mode of ["date", "range"]) {
    const reads = h.callsTo("/transactions").length;
    h.change("Date filter", mode); await h.flush();
    if (mode === "range") { h.change("Start date", "2026-10-09"); await h.flush(); }
    assert.equal(h.callsTo("/transactions").length, reads);
    await button(h.render(), "Apply").props.onClick();
    assert.equal(h.callsTo("/transactions").length, reads + 1);
    assert.match(text(h.render()), /Synthetic date validation failed/);
    await button(h.render(), "Export Records").props.onClick();
    assert.match(text(h.render()), /Synthetic date validation failed/);
    assert.equal(h.downloads.length, 0);
  }
});

test("Records ignores an older date response that resolves after the newly selected date", async () => {
  let releaseOlder;
  const data = label => ({
    transactions: [{ id: label === "OLDER" ? 1 : 2, queue_number: `${label}-001`, id_num: `${label} synthetic patient`,
      service_type: "prenatal", status: "completed", counter_id: "Doctor 2", created_at: "2026-10-09T01:00:00Z" }],
    stats: { completed: 1, cancelled: 0 },
    pagination: { currentPage: 1, totalPages: 1, totalRecords: 1, recordsPerPage: 20, hasNext: false, hasPrev: false }
  });
  const h = harness("records", { fetch(call, response) {
    if (call.route !== "/transactions") return undefined;
    if (call.params.date === "2026-10-09") return new Promise(resolve => { releaseOlder = () => resolve(response(200, data("OLDER"))); });
    if (call.params.date === "2026-10-10") return response(200, data("NEWER"));
    return undefined;
  } });
  await h.flush();
  h.change("Date filter", "date"); h.change("Specific date", "2026-10-09"); await h.flush();
  assert.equal(typeof releaseOlder, "function");
  h.change("Specific date", "2026-10-10"); await h.flush();
  assert.match(text(h.render()), /NEWER synthetic patient/);
  assert.doesNotMatch(text(h.render()), /OLDER synthetic patient/);
  releaseOlder(); await h.flush();
  assert.match(text(h.render()), /NEWER synthetic patient/);
  assert.doesNotMatch(text(h.render()), /OLDER synthetic patient/);
});

test("Analytics renders blank dates before effects, then loads the Manila range once with authentication", async () => {
  const h = harness("analytics");
  h.render();
  assert.equal(h.field("Start date").props.value, "");
  assert.equal(h.field("End date").props.value, "");
  assert.equal(h.callsTo("/analytics").length, 0);
  await h.flush();
  assert.deepEqual(selectedFilters(h.lastCall("/analytics")), {
    ...allTimeFilters, dateFilter: "range", startDate: "2026-10-04", endDate: "2026-10-10"
  });
  assert.equal(h.field("Start date").props.value, "2026-10-04");
  assert.equal(h.field("End date").props.value, "2026-10-10");
  assert.equal(h.lastCall("/analytics").headers.Authorization, "Bearer synthetic-superadmin-token");
  assert.equal(h.callsTo("/analytics").length, 1);
});

test("Analytics specific-date CSV uses identical filters, current bearer token and Response.blob download", async () => {
  const h = harness("analytics"); await h.flush();
  h.change("Date filter", "date"); h.change("Specific date", "2026-10-09");
  h.change("Doctor", "Doctor 2"); h.change("Service", "prenatal"); h.change("Status", "completed");
  await button(h.render(), "Apply").props.onClick();
  const expected = { ...allTimeFilters, dateFilter: "date", date: "2026-10-09", doctor: "Doctor 2", service: "prenatal", status: "completed" };
  assert.deepEqual(selectedFilters(h.lastCall("/analytics")), expected);
  h.storage.setItem("city_health_token", "replacement-synthetic-token");
  await button(h.render(), "Export").props.onClick();
  assert.deepEqual(selectedFilters(h.lastCall("/analytics/export")), expected);
  assert.equal(h.lastCall("/analytics/export").headers.Authorization, "Bearer replacement-synthetic-token");
  assert.equal(h.blobReads, 1);
  assert.equal(await h.blobs[0].text(), h.csv);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].href, "blob:synthetic-1");
  assert.match(h.downloads[0].filename, /\.csv$/);
  assert.equal(h.downloads[0].appended, true);
  assert.deepEqual(h.revoked, ["blob:synthetic-1"]);
  assert.equal(h.opens.length, 0);
});

test("Analytics range and All Time exports preserve the applied filters and clear hidden dates", async () => {
  const h = harness("analytics"); await h.flush();
  h.change("Date filter", "date"); h.change("Specific date", "2026-10-08");
  h.change("Date filter", "range"); h.change("Start date", "2026-10-09"); h.change("End date", "2026-10-10");
  h.change("Doctor", "Doctor 1");
  await button(h.render(), "Apply").props.onClick(); await button(h.render(), "Export").props.onClick();
  const expected = { ...allTimeFilters, dateFilter: "range", startDate: "2026-10-09", endDate: "2026-10-10", doctor: "Doctor 1" };
  assert.deepEqual(selectedFilters(h.lastCall("/analytics")), expected);
  assert.deepEqual(selectedFilters(h.lastCall("/analytics/export")), expected);
  h.change("Date filter", "");
  await button(h.render(), "Apply").props.onClick(); await button(h.render(), "Export").props.onClick();
  assert.deepEqual(selectedFilters(h.lastCall("/analytics")), { ...allTimeFilters, doctor: "Doctor 1" });
  assert.deepEqual(selectedFilters(h.lastCall("/analytics/export")), { ...allTimeFilters, doctor: "Doctor 1" });
});

test("Analytics ignores an older applied date response that resolves after the newer metrics", async () => {
  let releaseOlder;
  const data = totalPatients => ({ metrics: { totalPatients }, tableData: [], charts: {
    serviceTypes: { labels: [], data: [] }, dailyTrends: { labels: [], data: [] }
  } });
  const h = harness("analytics", { fetch(call, response) {
    if (call.route !== "/analytics") return undefined;
    if (call.params.date === "2026-10-09") return new Promise(resolve => { releaseOlder = () => resolve(response(200, data(9))); });
    if (call.params.date === "2026-10-10") return response(200, data(10));
    return undefined;
  } });
  await h.flush();
  h.change("Date filter", "date"); h.change("Specific date", "2026-10-09");
  const older = button(h.render(), "Apply").props.onClick(); await tick();
  assert.equal(typeof releaseOlder, "function");
  h.change("Specific date", "2026-10-10"); await button(h.render(), "Apply").props.onClick();
  const total = () => nodes(h.render(), node => node.props.label === "Total Patients")[0].props.value;
  assert.equal(total(), 10);
  releaseOlder(); await older; await h.flush();
  assert.equal(total(), 10);
});

test("exportQueueData distinguishes omitted dateFilter from explicit All Time and forwards date/doctor fields", async () => {
  for (const dateFilter of [undefined, null, ""]) {
    const h = harness();
    const filters = { doctor: "Doctor 2", date: "2026-10-09", startDate: "2026-10-08", endDate: "2026-10-10" };
    if (dateFilter !== undefined) filters.dateFilter = dateFilter;
    await h.queue.exportQueueData(filters);
    const call = h.lastCall("/queue/export");
    assert.equal(call.params.dateFilter, dateFilter ?? "today");
    for (const key of ["doctor", "date", "startDate", "endDate"]) assert.equal(call.params[key], filters[key]);
    assert.equal(h.blobReads, 1);
    assert.equal(h.downloads[0].filename, "queue_data_2026-10-10.csv");
  }
});

test("SettingsModal forwards an explicitly selected All Time export without replacing it with today", async () => {
  const exported = [];
  const h = harness("modal", { onExport: async filters => exported.push(clone(filters)) });
  await h.flush();
  button(h.render(), "Data Management").props.onClick();
  const dateSelect = nodes(h.render(), node => node.type === "select" &&
    nodes(node, child => child.type === "option" && text(child) === "All Time").length)[0];
  assert.ok(dateSelect);
  dateSelect.props.onChange({ target: { value: "" } });
  await button(h.render(), "Export Data").props.onClick();
  assert.deepEqual(exported, [{ status: "", service: "", dateFilter: "", format: "csv" }]);
});
