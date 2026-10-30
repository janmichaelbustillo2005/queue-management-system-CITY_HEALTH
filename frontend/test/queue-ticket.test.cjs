const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let helperCode, actionsCode, componentCode;
before(async () => {
  await swc.loadBindings();
  async function compile(relative) {
    const filename = path.join(__dirname, relative);
    return (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
  [helperCode, actionsCode, componentCode] = await Promise.all([
    compile("../lib/queueTicket.js"), compile("../components/QueueTicketActions.js"), compile("../components/DigitalQueuePass.js")
  ]);
});

function patient(overrides = {}) {
  return { id: 12, queue_number: "OB-002", service_type: "prenatal", status: "waiting",
    created_at: "2026-10-13T00:15:00Z", priority_score: 4, counter_id: null,
    id_num: "Private Patient Name", birthdate: "1960-01-01", philhealth_id: "CONFIDENTIAL-ID",
    mobile_number: "09123456789", residency: "Private Address", vulnerability_flags: ["pregnant"],
    reason: "Private medical condition", ...overrides };
}

function helpers(options = {}) {
  const module = { exports: {} };
  const requests = [];
  vm.runInNewContext(helperCode, {
    module, exports: module.exports, console, URL, Blob, Date, ...options.globals,
    require(name) {
      if (name === "./api") return { request: async (...args) => {
        requests.push(args);
        return options.response ? options.response(...args) : { patients: [patient()] };
      } };
      if (name === "./branding") return { SYSTEM_BRANDING: { logoSrc: "/cho_logo-transparent.png" } };
      throw new Error(`Unexpected import ${name}`);
    }
  });
  return { api: module.exports, requests };
}

test("ticket whitelists saved queue information and uses the saved Philippine registration time", () => {
  const { api } = helpers();
  const ticket = api.createQueueTicket(patient());
  assert.deepEqual(Object.keys(ticket).sort(), ["doctorName", "isActive", "patientId", "queueNumber", "registeredDate", "registeredTime", "serviceLabel", "status", "statusLabel"].sort());
  assert.equal(ticket.queueNumber, "OB-002");
  assert.equal(ticket.doctorName, "Doctor 2");
  assert.equal(ticket.registeredDate, "Oct 13, 2026");
  assert.equal(ticket.registeredTime, "8:15 AM");
  assert.equal(ticket.serviceLabel, "Prenatal");
  for (const secret of ["Private", "CONFIDENTIAL-ID", "09123456789", "1960-01-01", "pregnant"]) assert.ok(!JSON.stringify(ticket).includes(secret));
});

test("known assigned counter is retained; inactive and unknown statuses never look like a new waiting ticket", () => {
  const { api } = helpers();
  const completed = api.createQueueTicket(patient({ counter_id: "Doctor 3", status: "completed" }));
  assert.equal(completed.doctorName, "Doctor 3");
  assert.equal(completed.isActive, false);
  assert.match(api.createQueuePassSvg(completed), /INACTIVE TICKET/);
  assert.match(api.thermalTicketHtml(completed), /not a new waiting ticket/);
  const unknown = api.createQueueTicket(patient({ status: "Private medical condition", counter_id: "Private Patient Name" }));
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.isActive, false);
  assert.ok(!api.createQueuePassSvg(unknown).includes("Private"));
});

test("patient-ahead snapshot follows backend weighted order and service-specific doctor, with no serving count", () => {
  const { api } = helpers();
  const registered = patient();
  const rows = [registered,
    patient({ id: 1, priority_score: 9, status: "serving", counter_id: "Doctor 2" }),
    patient({ id: 2, priority_score: 10, service_type: "consultation" }),
    patient({ id: 5, service_type: "maternity", created_at: registered.created_at }),
    patient({ id: 3, service_type: "maternity", priority_score: 8 }),
    patient({ id: 4, priority_score: 1 }),
    patient({ id: 7, status: "cancelled", priority_score: 10 })];
  assert.equal(api.getPatientsAheadSnapshot(rows, registered), 2);
  assert.equal(api.getPatientsAheadSnapshot(rows, patient({ id: 99 })), null);
  assert.equal(api.getPatientsAheadSnapshot(rows, patient({ status: "completed" })), null);
  // Like the backend, waiting eligibility uses service mapping even with a legacy counter.
  assert.equal(api.getPatientsAheadSnapshot(rows, patient({ counter_id: "Doctor 3" })), 2);
});

test("lost-ticket retrieval reads authenticated queue by exact ID and performs no writes", async () => {
  const { api, requests } = helpers({ response: () => ({ patients: [patient({ id: 99, queue_number: "OB-002" }), patient({ id: 12, status: "completed" })] }) });
  const ticket = await api.fetchExistingQueueTicket("12");
  assert.equal(ticket.patientId, 12);
  assert.equal(ticket.status, "completed");
  assert.equal(ticket.queueNumber, "OB-002");
  assert.deepEqual(requests, [["/queue"]]);
  await assert.rejects(() => api.fetchExistingQueueTicket(100), /no longer available/);
  assert.deepEqual(requests, [["/queue"], ["/queue"]]);
});

test("retrieval cannot fall back to queue number or stale row after an API error", async () => {
  const missing = helpers({ response: () => ({ patients: [patient({ id: 99 })] }) });
  await assert.rejects(() => missing.api.fetchExistingQueueTicket(12), /no longer available/);
  const denied = helpers({ response: () => ({ error: "Permission denied" }) });
  await assert.rejects(() => denied.api.fetchExistingQueueTicket(12), /Permission denied/);
  assert.deepEqual(denied.requests, [["/queue"]]);
});

test("screen SVG and exported drawing share queue/status content and exclude protected patient details", () => {
  const { api } = helpers();
  const ticket = api.createQueueTicket(patient());
  const component = { exports: {} };
  vm.runInNewContext(componentCode, { module: component, exports: component.exports,
    require(name) {
      if (name === "../lib/queueTicket") return api;
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
      throw new Error(name);
    }
  });
  const svg = component.exports.default({ ticket });
  assert.equal(svg.type, "svg");
  assert.equal(svg.props.dangerouslySetInnerHTML.__html, api.queuePassSvgContents(ticket));
  const exported = api.createQueuePassSvg(ticket);
  assert.ok(exported.includes(svg.props.dangerouslySetInnerHTML.__html));
  assert.match(exported, /cho_logo-transparent\.png/);
  for (const secret of ["Private", "CONFIDENTIAL-ID", "09123456789", "1960-01-01", "priority_score", "Priority Score"]) assert.ok(!exported.includes(secret));
  assert.match(svg.props["aria-label"], /OB-002.*Doctor 2/);
});

test("ticket text is escaped in SVG and print HTML and PNG filename excludes unsafe path characters", () => {
  const { api } = helpers();
  const ticket = api.createQueueTicket(patient({ queue_number: 'OB-002</text><script>alert(1)</script>' }));
  assert.ok(!api.createQueuePassSvg(ticket).includes("<script>"));
  assert.ok(!api.thermalTicketHtml(ticket).includes("<script>alert(1)</script>"));
  assert.equal(api.queueTicketFilename("OB-002"), "Queue-Ticket-OB-002.png");
  assert.ok(!api.queueTicketFilename("../../\\<patient>\n").includes("/"));
});

test("PNG generation captures only the ticket, embeds the official logo, and exports at 3x resolution", async () => {
  const objectBlobs = [], revoked = [], draws = [], fetches = [];
  let downloaded, canvas;
  const fakeUrl = class extends URL {};
  fakeUrl.createObjectURL = blob => { objectBlobs.push(blob); return `blob:ticket-${objectBlobs.length}`; };
  fakeUrl.revokeObjectURL = url => revoked.push(url);
  class Reader { readAsDataURL() { this.result = "data:image/png;base64,b2ZmaWNpYWwtbG9nbw=="; this.onload(); } }
  class Graphic { set src(value) { this._src = value; this.onload(); } }
  const globals = {
    URL: fakeUrl, FileReader: Reader, Image: Graphic,
    window: { location: { origin: "http://localhost:3000" }, setTimeout: callback => callback() },
    fetch: async (...args) => { fetches.push(args); return { ok: true, blob: async () => new Blob(["logo"], { type: "image/png" }) }; },
    document: { body: { appendChild() {} }, createElement(type) {
      if (type === "canvas") {
        canvas = { getContext: () => ({ fillRect() {}, drawImage: (...args) => draws.push(args) }), toBlob: callback => callback(new Blob(["png"], { type: "image/png" })) };
        return canvas;
      }
      if (type === "a") return { click() { downloaded = this.download; }, remove() {} };
      throw new Error(`Unexpected element ${type}`);
    } }
  };
  const { api } = helpers({ globals });
  await api.downloadQueueTicket(api.createQueueTicket(patient()));
  assert.equal(canvas.width, 2280);
  assert.equal(canvas.height, 2460);
  assert.equal(downloaded, "Queue-Ticket-OB-002.png");
  assert.equal(draws.length, 1);
  assert.equal(fetches[0][0], "http://localhost:3000/cho_logo-transparent.png");
  assert.equal(fetches[0][1].credentials, "same-origin");
  const imageContent = await objectBlobs[0].text();
  assert.match(imageContent, /data:image\/png;base64/);
  assert.match(imageContent, /OB-002/);
  assert.ok(!imageContent.includes("Private"));
  assert.deepEqual(revoked.sort(), ["blob:ticket-1", "blob:ticket-2"]);
});

test("thermal printing keeps the existing popup and Courier layout while using original record time and status", () => {
  const calls = [], written = [];
  const popup = { closed: false, document: { write: content => written.push(content), close: () => calls.push("close-document") } };
  const { api } = helpers({ globals: { window: { open: (...args) => { calls.push(args); return popup; } } } });
  api.printQueueTicket(api.createQueueTicket(patient({ status: "cancelled" })));
  assert.deepEqual(calls[0], ["", "_blank", "width=300,height=600"]);
  assert.match(written[0], /Courier New/);
  assert.match(written[0], /width:280px/);
  assert.match(written[0], /OB-002/);
  assert.match(written[0], /Oct 13, 2026/);
  assert.match(written[0], /8:15 AM PHT/);
  assert.match(written[0], /Cancelled/);
  assert.match(written[0], /INACTIVE TICKET/);
  for (const secret of ["Private", "CONFIDENTIAL-ID", "Priority Score"]) assert.ok(!written[0].includes(secret));
});

function actionsHarness(ticketApi, props = {}) {
  const state = [], jsx = (type, props) => ({ type, props: props || {} });
  let cursor = 0;
  const effects = [];
  const react = {
    useEffect(effect) { if (!effects.length) effects.push(effect()); },
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index]; }
  };
  const module = { exports: {} };
  vm.runInNewContext(actionsCode, { module, exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../lib/queueTicket") return ticketApi;
      throw new Error(name);
    }
  });
  const ticket = helpers().api.createQueueTicket(patient());
  return { render() { cursor = 0; return module.exports.default({ ticket, ...props }); }, unmount() { effects.forEach(cleanup => cleanup?.()); } };
}
function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(node => nodes(node, predicate, found));
  else if (tree && typeof tree === "object") { if (predicate(tree)) found.push(tree); nodes(tree.props?.children, predicate, found); }
  return found;
}
function nodeText(tree) {
  if (Array.isArray(tree)) return tree.map(nodeText).join("");
  if (tree && typeof tree === "object") return nodeText(tree.props?.children);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}

test("delivery revalidates status, prevents repeated clicks, and prints the refreshed record", async () => {
  let resolve, reads = 0, printed;
  const fresh = helpers().api.createQueueTicket(patient({ status: "completed" }));
  const popup = { closed: false, close() {} };
  const h = actionsHarness({
    openThermalTicketWindow: () => popup,
    fetchExistingQueueTicket: id => { assert.equal(id, 12); reads++; return new Promise(done => { resolve = done; }); },
    printQueueTicket: (ticket, window) => { printed = ticket; assert.equal(window, popup); }
  });
  const button = nodes(h.render(), node => node.type === "button" && nodeText(node) === "Print Thermal Ticket")[0];
  const pending = button.props.onClick();
  await button.props.onClick();
  assert.equal(reads, 1);
  assert.ok(nodes(h.render(), node => node.type === "button").every(node => node.props.disabled));
  resolve(fresh);
  await pending;
  assert.equal(printed.status, "completed");
  assert.ok(nodes(h.render(), node => node.type === "button").every(node => !node.props.disabled));
});

test("the emphasized delivery action comes first and defaults keep the dialog's existing buttons", () => {
  const labels = tree => nodes(tree, node => node.type === "button").map(node => [nodeText(node), node.props.className.includes("--primary")]);
  const api = { openThermalTicketWindow() {}, fetchExistingQueueTicket() {}, printQueueTicket() {} };
  assert.deepEqual(labels(actionsHarness(api).render()), [["Download Image", false], ["Print Thermal Ticket", false]]);
  assert.deepEqual(labels(actionsHarness(api, { onView() {} }).render()),
    [["View Digital Pass", true], ["Download Image", false], ["Print Thermal Ticket", false]]);
  assert.deepEqual(labels(actionsHarness(api, { onView() {}, primaryAction: "print" }).render()),
    [["Print Thermal Ticket", true], ["View Digital Pass", false], ["Download Image", false]]);
});

test("opening the print window is not reported as a finished printout", async () => {
  const h = actionsHarness({
    openThermalTicketWindow: () => ({ closed: false, close() {} }),
    fetchExistingQueueTicket: async () => helpers().api.createQueueTicket(patient()),
    printQueueTicket() {}
  });
  await nodes(h.render(), node => node.type === "button" && nodeText(node) === "Print Thermal Ticket")[0].props.onClick();
  const notice = nodeText(h.render());
  assert.match(notice, /Print window opened\. Check that the ticket printed/);
  assert.doesNotMatch(notice, /printed successfully|ticket printed\./i);
});

test("delivery refuses stale tickets after auth or retrieval failure and closes the blank print popup", async () => {
  let closed = false, printed = false;
  const h = actionsHarness({
    openThermalTicketWindow: () => ({ closed: false, close() { closed = true; } }),
    fetchExistingQueueTicket: async () => { throw new Error("Permission denied"); },
    printQueueTicket: () => { printed = true; }
  });
  await nodes(h.render(), node => node.type === "button" && nodeText(node) === "Print Thermal Ticket")[0].props.onClick();
  assert.equal(closed, true);
  assert.equal(printed, false);
  assert.match(nodeText(h.render()), /Permission denied/);
});

test("unmount cancels pending ticket delivery and closes its print popup", async () => {
  let resolve, closed = false, printed = false;
  const popup = { closed: false, close() { closed = true; this.closed = true; } };
  const h = actionsHarness({
    openThermalTicketWindow: () => popup,
    fetchExistingQueueTicket: () => new Promise(done => { resolve = done; }),
    printQueueTicket: () => { printed = true; }
  });
  const pending = nodes(h.render(), node => node.type === "button" && nodeText(node) === "Print Thermal Ticket")[0].props.onClick();
  h.unmount();
  resolve(helpers().api.createQueueTicket(patient()));
  await pending;
  assert.equal(closed, true);
  assert.equal(printed, false);
});

test("cancelled PNG exports stop before fetching or downloading a ticket", async () => {
  let fetched = false;
  const { api } = helpers({ globals: { fetch: () => { fetched = true; throw new Error("Must not fetch"); } } });
  const result = await api.downloadQueueTicket(api.createQueueTicket(patient()), { isCancelled: () => true });
  assert.equal(result, false);
  assert.equal(fetched, false);
});
