const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isServicesModule, loadServices } = require("./services-module.cjs");

const compiled = {};
before(async () => {
  await swc.loadBindings();
  for (const name of ["pages/fill-up_form.js", "lib/queueTicket.js", "lib/navigation.js", "components/PatientRecordSearch.js"]) {
    const filename = path.join(__dirname, "..", name);
    compiled[name] = (await swc.transform(fs.readFileSync(filename, "utf8"), {
      filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    })).code;
  }
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
const jsx = (type, props) => ({ type, props: props || {} });
// Signed-in Front Desk registrations save or reuse a permanent patient record.
const REGISTRATION = "/patient-records/visits";
const savedPatient = {
  id: 55, queue_number: "OB-002", service_type: "prenatal", status: "waiting",
  priority_score: 3, created_at: "2026-10-13T03:04:00Z", counter_id: null,
  id_num: "Private Name", birthdate: "1980-01-01", residency: "Private Address", philhealth_id: "Private Identifier"
};

function harness(options = {}) {
  let cursor = 0;
  const hooks = [], calls = [];
  const user = "user" in options ? options.user : { id_num: "frontdesk", role: "admin" };
  const request = async (route, init = {}) => {
    calls.push({ route, method: init.method || "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (options.request) {
      const response = await options.request(route, init);
      if (response !== undefined) return response;
    }
    if (route === "/display") return { counters: [1, 2, 3].map(n => ({ id_num: `Doctor ${n}`, is_online: true })) };
    if (route === "/queue/website") return { success: true, queue_number: savedPatient.queue_number, priority_score: 3 };
    if (route === REGISTRATION) return { success: true, queue_number: savedPatient.queue_number, priority_score: 3, patient_record: { id: 1, patient_code: "PAT-0001" }, patient_record_created: true };
    if (route === "/queue") return { patients: [savedPatient] };
    return [];
  };
  const react = {
    useEffect() {},
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    }
  };
  const dependencies = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "next/link": "Link",
    "../lib/api": { request }, "./api": { request },
    "./branding": { SYSTEM_BRANDING: { logoSrc: "/cho_logo-transparent.png" } },
    "../context/AuthContext": { useAuth: () => ({ user }) }
  };
  const load = name => {
    const module = { exports: {} };
    vm.runInNewContext(compiled[name], {
      module, exports: module.exports, console, Date, Set, Map,
      require(dependency) {
        if (dependency in dependencies) return dependencies[dependency];
        if (dependency.startsWith("../components/")) return dependency.split("/").pop();
        if (isServicesModule(dependency)) return loadServices();
        throw new Error(`Unexpected dependency ${dependency}`);
      }
    });
    return module.exports;
  };
  dependencies["../lib/queueTicket"] = load("lib/queueTicket.js");
  // The search component renders as a named stub; its date formatter is the real one.
  dependencies["../components/PatientRecordSearch"] = {
    __esModule: true, default: "PatientRecordSearch", formatRecordBirthdate: load("components/PatientRecordSearch.js").formatRecordBirthdate
  };
  const page = load("pages/fill-up_form.js").default;
  const render = () => { cursor = 0; return page(); };
  const field = id => nodes(render(), node => node.props.id === id)[0];
  const change = (id, value) => field(id).props.onChange({ target: { value } });
  function fill() {
    change("patient-first-name", " Juan ");
    change("patient-middle-initial", "d");
    change("patient-last-name", " Dela Cruz ");
    change("patient-mobile", "9123456789");
    change("patient-philhealth", "Private Identifier");
    change("patient-sex", "Female");
    change("patient-birthdate", "1990-01-01");
    change("patient-residency", "Cabadbaran");
    change("patient-service", "prenatal");
    field("vuln-pregnant").props.onChange();
  }
  const submit = () => nodes(render(), node => node.type === "form")[0].props.onSubmit({ preventDefault() {} });
  return { render, calls, field, change, fill, submit, load };
}

test("registration sends the patient details, retrieves the actual saved record, and exposes safe delivery", async () => {
  const h = harness(); h.fill(); await h.submit();
  assert.equal(h.calls.some(call => call.route === "/queue/website"), false);
  const registration = h.calls.find(call => call.route === REGISTRATION);
  assert.deepEqual(registration.body, {
    firstName: "Juan", middleInitial: "D", lastName: "Dela Cruz", serviceType: "prenatal", mobileNumber: "9123456789",
    residency: "Cabadbaran", philhealthId: "Private Identifier", birthdate: "1990-01-01", sex: "Female", vulnerabilityFlags: ["pregnant"]
  });
  const pass = nodes(h.render(), node => node.type === "DigitalQueuePass")[0];
  assert.equal(pass.props.ticket.queueNumber, savedPatient.queue_number);
  assert.equal(pass.props.ticket.patientId, savedPatient.id);
  assert.equal(pass.props.ticket.doctorName, "Doctor 2");
  assert.equal(pass.props.ticket.registeredTime, "11:04 AM");
  assert.doesNotMatch(JSON.stringify(pass.props.ticket), /Private|birthdate|priority_score|residency|philhealth/i);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.calls.some(call => call.route === "/stats"), false);
});

test("two immediate submits create one registration and stale handlers cannot resubmit after save", async () => {
  let release;
  const h = harness({ request: route => route === REGISTRATION ? new Promise(resolve => { release = resolve; }) : undefined });
  h.fill();
  const submit = nodes(h.render(), node => node.type === "form")[0].props.onSubmit;
  const first = submit({ preventDefault() {} });
  await submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(h.field("patient-first-name").props.disabled, true);
  release({ success: true, queue_number: savedPatient.queue_number }); await first;
  await submit({ preventDefault() {} });
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
});

test("a failed ticket read preserves committed success and retry only reads the existing queue", async () => {
  let queueReads = 0;
  const h = harness({ request: route => route === "/queue" ? (++queueReads === 1 ? { error: "Temporary read outage" } : { patients: [savedPatient] }) : undefined });
  h.fill(); await h.submit();
  assert.match(text(h.render()), /Patient registered successfully\./);
  assert.match(text(h.render()), /Temporary read outage/);
  assert.match(text(h.render()), /Ticket actions appear once the saved ticket loads\./);
  assert.match(text(h.render()), /Saved queue number OB-002/);
  assert.equal(nodes(h.render(), node => node.type === "form").length, 0);
  const retry = nodes(h.render(), node => node.type === "button" && text(node) === "Retry Loading Ticket")[0];
  await retry.props.onClick();
  assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass")[0].props.ticket.queueNumber, "OB-002");
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.doesNotMatch(text(h.render()), /patients ahead/, "late retry does not pretend to be a registration-time snapshot");
});

test("missing or ambiguous saved queue numbers do not produce an invented ticket", async () => {
  for (const patients of [[], [savedPatient, { ...savedPatient, id: 56 }]]) {
    const h = harness({ request: route => route === "/queue" ? { patients } : undefined });
    h.fill(); await h.submit();
    assert.match(text(h.render()), /Patient registered successfully\./);
    assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass").length, 0);
    assert.match(text(h.render()), /do not register this patient again/);
  }
});

test("the snapshot counts only preceding waiting patients in the existing doctor's priority order", async () => {
  const rows = [
    { ...savedPatient, id: 3, queue_number: "OB-003", priority_score: 2, created_at: "2026-10-13T01:00:00Z" },
    { ...savedPatient, id: 1, queue_number: "OB-004", priority_score: 4 },
    { ...savedPatient, id: 2, queue_number: "OB-005", priority_score: 3, created_at: "2026-10-13T03:00:00Z" },
    { ...savedPatient, id: 4, queue_number: "GP-001", service_type: "consultation", priority_score: 99 },
    { ...savedPatient, id: 5, queue_number: "OB-001", status: "serving", counter_id: "Doctor 2", priority_score: 99 },
    savedPatient
  ];
  const h = harness({ request: route => route === "/queue" ? { patients: rows } : undefined });
  h.fill(); await h.submit();
  assert.match(text(h.render()), /2 waiting patients ahead/);
  assert.match(text(h.render()), /Registration snapshot/);
  assert.match(text(h.render()), /in Doctor 2's queue when this patient was registered/);
});

test("the success screen shows one message, prints first, and keeps the next patient apart from delivery", async () => {
  const h = harness(); h.fill(); await h.submit();
  const screen = h.render();
  const all = text(screen);
  assert.equal(all.split("Patient registered successfully.").length - 1, 1);
  assert.match(all, /Print the ticket, then register the next patient\./);
  assert.doesNotMatch(all, /Registration Complete|Registration Successful|queue number has been generated/);
  // Service and doctor appear on the ticket itself, not in a second summary.
  assert.doesNotMatch(all, /Prenatal/);
  assert.equal(all.split("Registration snapshot").length - 1, 1);
  const panel = nodes(screen, node => node.props.className === "registration-actions-panel")[0];
  const actions = nodes(panel, node => node.type === "QueueTicketActions")[0];
  assert.equal(actions.props.primaryAction, "print");
  const next = nodes(panel, node => node.props.className === "registration-next")[0];
  assert.ok(nodes(next, node => node.type === "button" && text(node).includes("Register Another Patient")).length);
  assert.deepEqual(nodes(next, node => node.type === "Link").map(link => link.props.href), ["/patient-management", "/queue-display"]);
  assert.equal(nodes(actions, node => text(node).includes("Register Another Patient")).length, 0);
});

test("Register Another Patient clears all fields and ticket state without mutating the saved record", async () => {
  const original = JSON.stringify(savedPatient);
  const h = harness(); h.fill(); await h.submit();
  const button = nodes(h.render(), node => node.type === "button" && text(node).includes("Register Another Patient"))[0];
  button.props.onClick();
  for (const id of ["patient-first-name", "patient-middle-initial", "patient-last-name", "patient-mobile", "patient-philhealth", "patient-sex", "patient-birthdate", "patient-residency", "patient-service"]) assert.equal(h.field(id).props.value, "");
  assert.equal(h.field("vuln-pregnant").props.checked, false);
  assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass").length, 0);
  assert.equal(JSON.stringify(savedPatient), original);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
});

test("completion and shared navigation use real routes with no patient-identifiable URL data", async () => {
  const h = harness(); h.fill(); await h.submit();
  const links = nodes(h.render(), node => node.type === "Link");
  assert.deepEqual(links.map(link => link.props.href), ["/patient-management", "/queue-display"]);
  // The Front Desk sidebar (shared shell) carries the same real routes.
  const navigation = h.load("lib/navigation.js");
  const groups = navigation.navigationFor(navigation.resolveAccount({ id_num: "frontdesk", role: "admin", doctor_name: null }));
  const navLinks = groups.flatMap(group => group.items).filter(item => item.href);
  assert.deepEqual(Array.from(navLinks, link => link.href), ["/fill-up_form", "/patient-management", "/queue-display"]);
  assert.ok(navLinks[0].isActive({ ready: true, path: "/fill-up_form" }));
  for (const link of navLinks) assert.ok(fs.existsSync(path.join(__dirname, "../pages", `${link.href.slice(1)}.js`)));
});

test("delayed delivery callbacks cannot restore the prior patient's ticket after registering another patient", async () => {
  const second = { ...savedPatient, id: 66, queue_number: "OB-003" };
  let registrations = 0;
  const h = harness({ request: route => {
    if (route === REGISTRATION) return { success: true, queue_number: (++registrations === 1 ? savedPatient : second).queue_number };
    if (route === "/queue") return { patients: [savedPatient, second] };
  } });
  h.fill(); await h.submit();
  const actions = nodes(h.render(), node => node.type === "QueueTicketActions")[0];
  nodes(h.render(), node => node.type === "button" && text(node).includes("Register Another Patient"))[0].props.onClick();
  h.fill(); await h.submit();
  actions.props.onTicketUpdate(actions.props.ticket);
  actions.props.onView(actions.props.ticket);
  const pass = nodes(h.render(), node => node.type === "DigitalQueuePass")[0];
  assert.equal(pass.props.ticket.patientId, second.id);
  assert.equal(pass.props.ticket.queueNumber, second.queue_number);
  assert.equal(nodes(h.render(), node => node.type === "QueueTicketDialog").length, 0);
  assert.equal(registrations, 2);
});

test("cached preview, snapshot, and delayed delivery disappear when the account loses ticket permission", async () => {
  const user = { id_num: "frontdesk", role: "admin" };
  const h = harness({ user }); h.fill(); await h.submit();
  const actions = nodes(h.render(), node => node.type === "QueueTicketActions")[0];
  user.id_num = "admin1";
  h.render();
  actions.props.onView(actions.props.ticket);
  actions.props.onTicketUpdate(actions.props.ticket);
  assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass").length, 0);
  assert.equal(nodes(h.render(), node => node.type === "QueueTicketDialog").length, 0);
  assert.equal(nodes(h.render(), node => node.type === "QueueTicketActions").length, 0);
  assert.doesNotMatch(text(h.render()), /patients ahead/);
});

test("existing required controls have associated labels and unavailable doctor still blocks registration", async () => {
  const h = harness({ request: route => route === "/display" ? { counters: [{ id_num: "Doctor 2", is_online: false }] } : undefined });
  const labels = nodes(h.render(), node => node.type === "label").map(node => node.props.htmlFor);
  for (const id of ["patient-first-name", "patient-last-name", "patient-sex", "patient-birthdate", "patient-residency", "patient-service"]) {
    assert.equal(h.field(id).props.required, true); assert.ok(labels.includes(id));
  }
  h.fill(); await h.submit();
  assert.equal(h.calls.filter(call => call.method === "POST").length, 0);
  assert.match(text(h.render()), /Doctor 2 is currently offline/);
});

test("D1 shared dispatch: the redesigned snapshot counts the whole shared queue and promises no doctor", async () => {
  const rows = [
    { ...savedPatient, id: 3, queue_number: "OB-003", priority_score: 2, created_at: "2026-10-13T01:00:00Z" },
    { ...savedPatient, id: 4, queue_number: "GP-001", service_type: "consultation", priority_score: 4 },
    { ...savedPatient, id: 6, queue_number: "FP-001", service_type: "family_planning", priority_score: 1, effective_priority: 3, created_at: "2026-10-13T02:00:00Z" },
    savedPatient
  ];
  const h = harness({ request: route => route === "/queue" ? { dispatch_mode: "shared", patients: rows }
    : route === "/display" ? { dispatch_mode: "shared", counters: [{ id_num: "Doctor 2", is_online: false }, { id_num: "Doctor 3", is_online: true }] } : undefined });
  h.fill(); await h.submit();
  const shown = text(h.render());
  assert.match(shown, /Patient registered successfully\./, "Doctor 2 offline does not block a prenatal registration");
  // Only the Senior consultation is ahead: the aged family-planning visit (1 + 2 = 3) ties with this
  // Pregnant patient (3), and the higher base priority wins the tie; the Indigenous visit (2) is behind.
  assert.match(shown, /1 waiting patient ahead/);
  assert.match(shown, /in the shared queue when this patient was registered/);
  assert.doesNotMatch(shown, /Doctor 2's queue/);
  assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass")[0].props.ticket.doctorName, "Next available doctor");
});

// Permanent patient records: Front Desk search, select, verify and register a returning visit.
const storedRecord = {
  id: 7, patient_code: "PAT-0007", full_name: "Maria L. Santos", first_name: "Maria", middle_initial: "L", last_name: "Santos",
  birthdate: "1950-03-15", sex: "Female", mobile_number: "9171112222", residency: "Barangay 2, Cabadbaran City", philhealth_id: "PH-7"
};
const recordRequests = (extra = () => undefined) => route => route === "/patient-records/7" ? { success: true, patient: storedRecord } : extra(route);
const searchProps = h => nodes(h.render(), node => node.type === "PatientRecordSearch")[0]?.props;
const button = (h, label) => nodes(h.render(), node => node.type === "button" && text(node).includes(label))[0];

test("only Front Desk and Super Admin see patient search; anyone else keeps the original registration", async () => {
  assert.ok(searchProps(harness()));
  assert.ok(searchProps(harness({ user: { id_num: "superadmin", role: "superadmin" } })));
  for (const user of [null, { id_num: "admin1", role: "admin", doctor_name: "Doctor 1" }]) {
    const h = harness({ user });
    assert.equal(searchProps(h), undefined);
    h.fill(); await h.submit();
    assert.equal(h.calls.some(call => call.route.startsWith("/patient-records")), false);
    assert.deepEqual(h.calls.find(call => call.route === "/queue/website").body, {
      fullName: "Juan D. Dela Cruz", serviceType: "prenatal", mobileNumber: "9123456789",
      residency: "Cabadbaran", philhealthId: "Private Identifier", birthdate: "1990-01-01", sex: "Female", vulnerabilityFlags: ["pregnant"]
    });
  }
});

test("selecting a patient reads the record by id and fills the form read-only, without registering", async () => {
  const h = harness({ request: recordRequests() });
  h.change("patient-service", "medical_consultation");
  await searchProps(h).onSelect({ id: 7, patient_code: "PAT-0007" });
  assert.deepEqual(h.calls.map(call => call.route), ["/patient-records/7"]);
  assert.equal(h.calls.some(call => call.method === "POST"), false, "retrieval never creates a queue entry");
  const expected = { "patient-first-name": "Maria", "patient-middle-initial": "L", "patient-last-name": "Santos", "patient-mobile": "9171112222",
    "patient-philhealth": "PH-7", "patient-sex": "Female", "patient-birthdate": "1950-03-15", "patient-residency": "Barangay 2, Cabadbaran City", "patient-service": "medical_consultation" };
  for (const [id, value] of Object.entries(expected)) assert.equal(h.field(id).props.value, value, id);
  for (const id of ["patient-first-name", "patient-middle-initial", "patient-last-name", "patient-mobile", "patient-philhealth", "patient-birthdate", "patient-residency"]) {
    assert.equal(h.field(id).props.readOnly, true, id);
  }
  assert.equal(h.field("patient-sex").props.disabled, true);
  assert.equal(h.field("patient-service").props.disabled, false, "visit fields stay editable");
  assert.equal(h.field("vuln-senior").props.checked, true, "Senior is computed from the stored birthdate");
  const shown = text(h.render());
  assert.match(shown, /Returning patient: Maria L\. Santos/);
  assert.match(shown, /Patient ID PAT-0007 · Born Mar 15, 1950 · Female/);
  assert.match(shown, /Maria L\. Santos \(PAT-0007\) · Medical consultation/);
  assert.equal(searchProps(h).selectedId, 7);
});

test("a returning patient's visit sends only the record id and visit fields, and reports the Patient ID", async () => {
  const h = harness({ request: recordRequests(route => route === REGISTRATION
    ? { success: true, queue_number: savedPatient.queue_number, priority_score: 4, patient_record: storedRecord, patient_record_created: false } : undefined) });
  await searchProps(h).onSelect({ id: 7 });
  h.change("patient-service", "prenatal");
  await h.submit();
  const posts = h.calls.filter(call => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { route: REGISTRATION, method: "POST", body: { patientRecordId: 7, serviceType: "prenatal", vulnerabilityFlags: ["senior"] } });
  assert.match(text(h.render()), /Patient registered successfully\./);
  assert.match(text(h.render()), /Patient ID PAT-0007 · returning patient/);
});

test("Change Patient returns to a blank new-patient form and keeps the visit choices", async () => {
  const h = harness({ request: recordRequests() });
  h.change("patient-service", "checkup");
  await searchProps(h).onSelect({ id: 7 });
  button(h, "Change Patient").props.onClick();
  for (const id of ["patient-first-name", "patient-last-name", "patient-birthdate", "patient-residency", "patient-sex"]) assert.equal(h.field(id).props.value, "", id);
  assert.equal(h.field("patient-first-name").props.readOnly, false);
  assert.equal(h.field("patient-sex").props.disabled, false);
  assert.equal(h.field("vuln-senior").props.checked, false);
  assert.equal(h.field("patient-service").props.value, "checkup");
  assert.doesNotMatch(text(h.render()), /Returning patient/);
  h.fill(); await h.submit();
  assert.equal(Object.hasOwn(h.calls.find(call => call.route === REGISTRATION).body, "patientRecordId"), false);
});

test("a possible duplicate record offers Select or an explicit different-person registration", async () => {
  const existing = { id: 7, patient_code: "PAT-0007", full_name: "Juan Dela Cruz", birthdate: "1990-01-01", sex: "Female" };
  let posts = 0;
  const h = harness({ request: recordRequests(route => route === REGISTRATION && ++posts === 1
    ? { error: "A patient record with the same name, sex and birthdate already exists.", status: 409, details: { possible_duplicates: [existing] } } : undefined) });
  h.fill(); await h.submit();
  const shown = text(h.render());
  assert.match(shown, /already exists/);
  assert.match(shown, /Juan Dela Cruz · PAT-0007 · Born Jan 1, 1990 · Female/);
  assert.equal(nodes(h.render(), node => node.props.role === "alert" && /alert-danger/.test(node.props.className || "")).length, 0);
  await button(h, "Register as a Different Person").props.onClick({ preventDefault() {} });
  const registrations = h.calls.filter(call => call.route === REGISTRATION);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].body.confirmNewRecord, undefined);
  assert.equal(registrations[1].body.confirmNewRecord, true);
  assert.match(text(h.render()), /Patient registered successfully\./);

  const again = harness({ request: recordRequests(route => route === REGISTRATION
    ? { error: "exists", status: 409, details: { possible_duplicates: [existing] } } : undefined) });
  again.fill(); await again.submit();
  await button(again, "Select PAT-0007").props.onClick();
  assert.equal(again.calls.at(-1).route, "/patient-records/7");
  assert.match(text(again.render()), /Returning patient: Maria L\. Santos/);
  assert.doesNotMatch(text(again.render()), /Register as a Different Person/);
});

test("a saved record whose visit failed is selected, so the retry reuses it", async () => {
  let posts = 0;
  const h = harness({ request: route => route === REGISTRATION && ++posts === 1
    ? { error: "The queue database is unavailable.", status: 503, details: { patient_record: storedRecord } } : undefined });
  h.fill(); await h.submit();
  assert.match(text(h.render()), /Patient record PAT-0007 was saved, but no queue number was generated: The queue database is unavailable\. Submit again/);
  assert.match(text(h.render()), /Returning patient: Maria L\. Santos/);
  await h.submit();
  const retry = h.calls.filter(call => call.route === REGISTRATION)[1];
  assert.equal(retry.body.patientRecordId, 7);
  assert.equal(retry.body.firstName, undefined);
});

test("a record that cannot be read shows the error and selects nothing", async () => {
  const h = harness({ request: route => route === "/patient-records/9" ? { error: "Patient record not found. Search again.", status: 404 } : undefined });
  await searchProps(h).onSelect({ id: 9 });
  assert.match(text(h.render()), /Patient record not found\. Search again\./);
  assert.doesNotMatch(text(h.render()), /Returning patient/);
  assert.equal(h.field("patient-first-name").props.readOnly, false);
});

// RR1 round-robin dispatch: the service never chooses the doctor; the backend assigns one.
const roundRobinDisplay = { dispatch_mode: "shared", dispatch_strategy: "round_robin",
  approved_services: ["consultation", "checkup", "prenatal", "maternity", "family_planning"],
  counters: [1, 2, 3].map(n => ({ id_num: `Doctor ${n}`, is_online: false })) };

test("RR1: the review names no doctor for the service, and unapproved services cannot be chosen", async () => {
  const h = harness({ request: route => route === "/display" ? roundRobinDisplay
    : route === REGISTRATION ? { error: "Temporary failure" } : undefined });
  h.fill(); h.change("patient-service", "family_planning"); await h.submit();
  const review = nodes(h.render(), node => node.type === "section" && node.props.className === "registration-review")[0];
  const shown = text(review);
  assert.match(shown, /Service: Family planning/);
  assert.match(shown, /Doctor assignment: Any available doctor — automatically assigned/);
  assert.match(shown, /Assignment method: Automatic round robin/);
  assert.doesNotMatch(shown, /Doctor [123]/);
  const options = nodes(nodes(h.render(), node => node.props.id === "patient-service")[0], node => node.type === "option" && node.props.value);
  const disabled = options.filter(node => node.props.disabled).map(node => node.props.value);
  // Of the 13 offered services only Family planning is on the approved shared-queue list.
  assert.deepEqual(options.filter(node => !node.props.disabled).map(node => node.props.value), ["family_planning"]);
  assert.equal(disabled.length, 12);
  assert.ok(disabled.every(value => /not yet approved for general doctors/.test(text(options.find(node => node.props.value === value))))); 
});

test("RR1: registration is not blocked while every doctor is offline, and the ticket promises no doctor", async () => {
  const waitingAssigned = { ...savedPatient, counter_id: "Doctor 2" };
  const h = harness({ request: route => route === "/display" ? roundRobinDisplay
    : route === "/queue" ? { dispatch_mode: "shared", dispatch_strategy: "round_robin", patients: [waitingAssigned] } : undefined });
  h.fill(); await h.submit();
  assert.match(text(h.render()), /Patient registered successfully\./);
  assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(nodes(h.render(), node => node.type === "DigitalQueuePass")[0].props.ticket.doctorName, "Next available doctor",
    "a provisional round-robin assignment is not printed: it can still change");
});

test("service dispatch keeps the existing routed-doctor review and offers every listed service", async () => {
  const h = harness({ request: route => route === REGISTRATION ? { error: "Temporary failure" } : undefined });
  h.fill(); h.change("patient-service", "family_planning"); await h.submit();
  const review = nodes(h.render(), node => node.type === "section" && node.props.className === "registration-review")[0];
  assert.match(text(review), /Family planning · Doctor 3/);
  const options = nodes(nodes(h.render(), node => node.props.id === "patient-service")[0], node => node.type === "option" && node.props.value);
  assert.equal(options.filter(node => node.props.disabled).length, 0);
  assert.deepEqual(options.map(node => node.props.value), ["medical_consultation", "maternal_healthcare", "family_planning", "child_healthcare", "dental_healthcare", "nutrition",
    "diagnostic_imaging", "womens_health", "mental_healthcare", "medical_documentation", "marriage_preparation", "environmental_health", "food_safety"]);
  assert.deepEqual(options.map(node => text(node)), ["Medical consultation", "Maternal healthcare", "Family planning",
    "Child healthcare", "Dental healthcare", "Nutrition", "Diagnostic imaging", "Women's health", "Mental healthcare",
    "Medical documentation", "Marriage preparation", "Environmental health", "Food safety"]);
});
