// RES1/RES2: the one Residency search bar (components/ResidencySearch.js) and its Cabadbaran City
// search (lib/residency.js), rendered with a minimal hook harness and driven by key, mouse and
// typing events. The backend's map search is a fake request function; timers are manual.
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { loadResidency } = require("./services-module.cjs");

let compiled;
let residency;
before(async () => {
  await swc.loadBindings();
  const filename = path.join(__dirname, "../components/ResidencySearch.js");
  compiled = (await swc.transform(fs.readFileSync(filename, "utf8"), {
    filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" }
  })).code;
  residency = loadResidency();
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
const key = (name, tagName = "INPUT") => ({ key: name, target: { tagName }, prevented: false, preventDefault() { this.prevented = true; } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const CHOSEN = { chosen: true, place: null };

function harness(initial = "", extra = {}, { request: respond = () => ({ available: false, suggestions: [] }) } = {}) {
  let value = initial;
  let selection = extra.selection ?? null;
  const changes = [];
  const requests = [];
  const timers = new Map();
  let nextTimer = 1;
  let uuid = 0;
  const hooks = [];
  let cursor = 0;
  let effects = [];
  const react = {
    useState(start) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = start;
      return [hooks[index], next => { hooks[index] = typeof next === "function" ? next(hooks[index]) : next; }];
    },
    useRef(start) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: start };
      return hooks[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || deps.some((dep, at) => !Object.is(dep, previous.deps[at]))) {
        effects.push(() => {
          previous?.cleanup?.();
          hooks[index] = { deps, cleanup: effect() };
        });
        hooks[index] = { deps, cleanup: previous?.cleanup };
      }
    }
  };
  // Function components (the option text, the icon, the barangay select) render in place.
  const jsx = (type, props) => (typeof type === "function" ? type(props || {}) : { type, props: props || {} });
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, console, encodeURIComponent,
    setTimeout: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (name === "../lib/residency") return residency;
      if (name === "../lib/api") return { request: async route => { requests.push(route); return respond(route); } };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  const Component = module.exports.default;
  const props = () => ({
    id: "res", value, selection,
    // Copied into this realm, so assertions compare values, not the vm's object prototypes.
    onChange: (next, chosen) => { value = next; selection = chosen == null ? chosen : JSON.parse(JSON.stringify(chosen)); changes.push([next, selection]); },
    ...extra, ...(Object.hasOwn(extra, "selection") ? { selection } : {})
  });
  const render = () => {
    let tree;
    for (let round = 0; round < 6; round += 1) {
      cursor = 0;
      effects = [];
      tree = Component(props());
      if (!effects.length) break;
      effects.forEach(run => run());
    }
    return tree;
  };
  const find = id => nodes(render(), node => node.props?.id === id)[0];
  const input = () => find("res");
  const options = () => nodes(render(), node => node.props?.role === "option");
  const button = label => nodes(render(), node => node.type === "button" && text(node).includes(label))[0];
  return {
    render, find, input, options, button, changes, requests, timers,
    get value() { return value; },
    get selection() { return selection; },
    type(next) { input().props.onChange({ target: { value: next } }); render(); },
    press(name) { const event = key(name); input().props.onKeyDown(event); return event; },
    click() { input().props.onClick(); },
    // Run the pending debounce timers, then let the fake request answer.
    async flush() {
      render();
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) await callback();
      await tick();
      render();
    },
    status() { return text(find("res-status")); }
  };
}

test("the bar is one labelled, required combobox with the search placeholder and no separate address fields", () => {
  const h = harness();
  const input = h.input();
  assert.equal(input.props.role, "combobox");
  assert.equal(input.props["aria-autocomplete"], "list");
  assert.equal(input.props["aria-required"], "true");
  assert.equal(input.props["aria-expanded"], "false");
  assert.equal(input.props.placeholder, "Search barangay, purok, street, or address in Cabadbaran City...");
  const label = nodes(h.render(), node => node.type === "label")[0];
  assert.equal(label.props.htmlFor, "res");
  assert.match(text(label), /^Residency \*$/);
  assert.equal(nodes(h.render(), node => node.type === "svg").length, 1, "search icon");
  assert.equal(nodes(h.render(), node => node.type === "select").length, 0);
  assert.equal(nodes(h.render(), node => node.type === "input").length, 1);
  assert.equal(h.button("Clear"), undefined, "no clear button while empty");
  assert.match(h.status(), /Cabadbaran City, Agusan del Norte is added automatically/);
});

test("clicking the bar lists every barangay of Cabadbaran City, and offers manual entry", () => {
  const h = harness();
  h.click();
  const labels = h.options().map(option => text(option));
  assert.equal(labels.length, 31);
  assert.ok(labels.every(label => label.endsWith("Cabadbaran City, Agusan del Norte")));
  assert.match(text(h.render()), /Barangays of Cabadbaran City/);
  assert.equal(h.find("res-listbox").props.role, "listbox");
  assert.ok(h.button("Enter address manually"));
});

test("typing marks the address as not chosen; a barangay chosen with Enter offers the inline Purok / Street entry", () => {
  const h = harness();
  h.type("calib");
  assert.deepEqual(h.selection, { chosen: false, place: null }, "typed text is never a selection");
  assert.equal(h.input().props["aria-expanded"], "true");
  const [option] = h.options();
  assert.equal(h.options().length, 1);
  assert.equal(text(nodes(option, node => node.type === "mark")[0]), "Calib");
  assert.ok(h.button("×") || nodes(h.render(), node => node.props?.["aria-label"] === "Clear residency").length);

  assert.equal(h.press("Enter").prevented, true, "Enter chooses instead of submitting the form");
  assert.equal(h.value, "Brgy. Calibunan, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, CHOSEN);
  assert.match(text(h.render()), /Brgy\. Calibunan selected/);

  const detail = () => h.find("res-detail");
  assert.equal(detail().props.maxLength, 45);
  detail().props.onChange({ target: { value: "Purok 3, Rizal St." } });
  const enter = key("Enter");
  detail().props.onKeyDown(enter);
  assert.equal(enter.prevented, true);
  assert.equal(h.value, "Purok 3, Rizal St., Brgy. Calibunan, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, CHOSEN);
  assert.equal(h.find("res-detail"), undefined, "the panel closes once the address is complete");
  assert.match(h.status(), /Entered manually from the official barangay list\. Not checked on a map\./);
});

test("the inline Purok / Street entry refuses a second barangay, city or province", () => {
  const h = harness("Brgy. Mabini, Cabadbaran City, Agusan del Norte", { selection: CHOSEN });
  h.click();
  h.find("res-detail").props.onChange({ target: { value: "Purok 1, Bayabas" } });
  assert.match(text(h.find("res-detail-error")), /cannot name a barangay, city or province again/);
  assert.equal(h.button("Add").props.disabled, true);
  h.find("res-detail").props.onKeyDown(key("Enter"));
  assert.equal(h.value, "Brgy. Mabini, Cabadbaran City, Agusan del Norte", "nothing is added");
  h.find("res-detail").props.onChange({ target: { value: "City Proper" } });
  assert.equal(h.find("res-detail-error"), undefined, "a purok named City Proper is allowed");
});

test("a typed purok or street is kept with the barangay; arrow keys move, wrap and Enter chooses the active address", () => {
  const h = harness();
  h.type("Purok 3, ca");
  const labels = h.options().map(option => text(option).replace("Cabadbaran City, Agusan del Norte", ""));
  assert.deepEqual(labels, ["Purok 3, Brgy. Caasinan", "Purok 3, Brgy. Cabinet", "Purok 3, Brgy. Calamba", "Purok 3, Brgy. Calibunan"]);
  assert.equal(h.press("ArrowDown").prevented, true);
  assert.equal(h.input().props["aria-activedescendant"], "res-option-0");
  assert.equal(h.options()[0].props["aria-selected"], "true");
  h.press("ArrowUp");
  assert.equal(h.input().props["aria-activedescendant"], "res-option-3", "Up from the first wraps to the last");
  h.press("ArrowDown");
  assert.equal(h.input().props["aria-activedescendant"], "res-option-0", "Down from the last wraps to the first");
  h.press("ArrowDown");
  h.press("ArrowDown");
  h.press("Enter");
  assert.equal(h.value, "Purok 3, Brgy. Calamba, Cabadbaran City, Agusan del Norte");
  assert.equal(h.options().length, 0, "a complete address closes the list");
  h.click();
  assert.equal(h.options().length, 0, "clicking a chosen, complete address shows no stale list");
  assert.doesNotMatch(text(h.render()), /No address in Cabadbaran City matches/);
});

test("Escape closes the list, and Enter submits the form only while the list is closed", () => {
  const h = harness();
  h.type("Tolosa");
  assert.equal(h.options().length, 1);
  assert.equal(h.press("Escape").prevented, true);
  assert.equal(h.options().length, 0);
  assert.equal(h.press("Enter").prevented, false, "Enter is left to the form");
  assert.equal(h.value, "Tolosa", "nothing is chosen by a closed list");
  h.press("ArrowDown");
  assert.equal(h.options().length, 1, "ArrowDown reopens the list");
});

test("no purok, street or other place is invented: unmatched text shows a no-results message and manual entry", () => {
  for (const typed of ["Purok 3", "Butuan City", "Libertad"]) {
    const h = harness();
    h.type(typed);
    assert.equal(h.options().length, 0, typed);
    assert.match(text(h.render()), new RegExp(`No address in Cabadbaran City matches “${typed}”`), typed);
    assert.ok(h.button("Enter address manually"), typed);
  }
});

test("pointer and touch: pressing an option keeps focus in the bar, and the tap chooses it", () => {
  const h = harness();
  h.type("Purok 7 Mahaba");
  const [option] = h.options();
  const down = key("mousedown");
  option.props.onMouseDown(down);
  assert.equal(down.prevented, true);
  option.props.onClick();
  assert.equal(h.value, "Purok 7, Brgy. Mahaba, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, CHOSEN);
});

test("the clear button empties the bar, forgets the selection and reopens the barangay list", () => {
  const h = harness("Purok 1, Brgy. Sanghan, Cabadbaran City, Agusan del Norte", { selection: CHOSEN });
  nodes(h.render(), node => node.props?.["aria-label"] === "Clear residency")[0].props.onClick();
  assert.equal(h.value, "");
  assert.deepEqual(h.selection, { chosen: false, place: null });
  assert.equal(h.options().length, 31);
});

test("leaving the control closes the panel", () => {
  const h = harness();
  h.type("Soriano");
  const root = nodes(h.render(), node => node.props?.className === "residency-search")[0];
  root.props.onBlur({ relatedTarget: null });
  assert.equal(h.options().length, 0);
});

test("an error is shown directly below the bar and announced", () => {
  const h = harness("Purok 3 Calibunan", { error: "Please select a valid address within Cabadbaran City, Agusan del Norte." });
  const input = h.input();
  assert.equal(input.props["aria-invalid"], "true");
  assert.equal(input.props["aria-describedby"], "res-error");
  const error = h.find("res-error");
  assert.equal(error.props.role, "alert");
  assert.equal(text(error), "Please select a valid address within Cabadbaran City, Agusan del Norte.");
  assert.match(nodes(h.render(), node => /residency-search-bar/.test(node.props?.className || ""))[0].props.className, /is-invalid/);
  assert.equal(h.find("res-status"), undefined);
});

test("a returning patient's saved address is shown read-only, with its review notice", () => {
  const saved = "Libertad, Butuan City, Agusan del Norte";
  const h = harness(saved, { readOnly: true, mapSearch: true, notice: { type: "p", props: { children: "Report for review" } } });
  assert.equal(h.input().props.value, saved);
  assert.equal(h.input().props.readOnly, true);
  assert.equal(h.input().props["aria-describedby"], "res-status res-notice");
  h.click();
  h.press("ArrowDown");
  assert.equal(h.options().length, 0, "a saved address cannot be searched or changed here");
  assert.equal(h.requests.length, 0, "and the map is never searched for it");
  assert.equal(nodes(h.render(), node => node.props?.["aria-label"] === "Clear residency").length, 0);
  assert.equal(text(h.find("res-notice")), "Report for review");
});

test("while saving, the bar is disabled and does not open", () => {
  const h = harness("", { disabled: true });
  assert.equal(h.input().props.disabled, true);
  h.click();
  assert.equal(h.options().length, 0);
});

// Manual entry: the fallback for addresses the map does not have.
test("manual entry starts from what was typed, requires a barangay, and saves a manually entered address", () => {
  const h = harness();
  h.type("Purok 9 Ilaya St");
  h.button("Enter address manually").props.onClick();
  assert.match(text(h.render()), /Enter address manually/);
  assert.match(text(h.render()), /Cabadbaran City, Agusan del Norte, Philippines is added automatically; the address is saved as manually entered/);
  assert.equal(h.find("res-manual-detail").props.value, "Purok 9 Ilaya St");
  assert.equal(h.find("res-manual-barangay").props.value, "");
  assert.equal(nodes(h.find("res-manual-barangay"), node => node.type === "option").length, 32);

  h.button("Use this address").props.onClick();
  assert.equal(text(h.find("res-manual-error")), "Choose the barangay.");
  assert.equal(h.changes.filter(([, chosen]) => chosen?.chosen).length, 0, "nothing is saved without a barangay");

  h.find("res-manual-barangay").props.onChange({ target: { value: "Katugasan" } });
  // Enter on the Cancel button keeps the button's own meaning; it never saves.
  const group = nodes(h.render(), node => node.props?.["aria-labelledby"] === "res-manual-title")[0];
  group.props.onKeyDown(key("Enter", "BUTTON"));
  assert.equal(h.changes.filter(([, chosen]) => chosen?.chosen).length, 0);
  group.props.onKeyDown(key("Enter", "INPUT"));
  assert.equal(h.value, "Purok 9 Ilaya St, Brgy. Katugasan, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, CHOSEN);
  assert.match(h.status(), /Entered manually/);
});

test("manual entry picks up a barangay named in the typed text, and refuses a detail naming another place", () => {
  const h = harness();
  h.type("Purok 2 Comagascas");
  h.button("Enter address manually").props.onClick();
  assert.equal(h.find("res-manual-barangay").props.value, "Comagascas");
  assert.equal(h.find("res-manual-detail").props.value, "Purok 2");
  h.find("res-manual-detail").props.onChange({ target: { value: "Purok 2, Butuan City" } });
  h.button("Use this address").props.onClick();
  assert.match(text(h.find("res-manual-error")), /cannot name a barangay, city or province again/);
  assert.equal(h.value, "Purok 2 Comagascas", "the typed text is kept until a valid address is saved");
});

// Google Maps search through the backend.
const MAP_RESULT = { placeId: "ChIJrizal0000001", mainText: "Rizal St", secondaryText: "Cabadbaran City, Agusan del Norte, Philippines", text: "Rizal St, Cabadbaran City" };

test("map search waits for a pause in typing and at least 3 characters, and sends one request per pause", async () => {
  const h = harness("", { mapSearch: true }, { request: () => ({ available: true, suggestions: [MAP_RESULT] }) });
  h.type("ri");
  await h.flush();
  assert.equal(h.requests.length, 0, "two characters never reach the map");
  h.type("riz");
  h.type("riza");
  h.type("rizal");
  assert.match(text(h.render()), /Searching Google Maps…/);
  assert.equal(h.input().props["aria-busy"], "true");
  await h.flush();
  assert.deepEqual(h.requests, ["/address-search?q=rizal&session=00000000-0000-4000-8000-000000000001"], "earlier keystrokes were cancelled");
  const shown = text(h.render());
  assert.match(shown, /Google Maps results/);
  assert.match(shown, /Map results by Google/);
  assert.equal(text(h.options()[0]), "Rizal StCabadbaran City, Agusan del Norte, Philippines");
  assert.doesNotMatch(shown, /Searching Google Maps…/);
});

test("a map result with an official barangay becomes the address, marked as selected from Google Maps", async () => {
  const place = { placeId: "ChIJrizal0000001", barangay: "Poblacion 3", detail: "Rizal St", formattedAddress: "Rizal St, Cabadbaran", token: "signed.place" };
  const h = harness("", { mapSearch: true }, {
    request: route => route.startsWith("/address-search/place") ? { success: true, address: place } : { available: true, suggestions: [MAP_RESULT] }
  });
  h.type("Rizal");
  await h.flush();
  h.options()[0].props.onClick();
  await tick();
  h.render();
  assert.equal(h.requests[1], "/address-search/place?id=ChIJrizal0000001&session=00000000-0000-4000-8000-000000000001",
    "the details call ends the same search session");
  assert.equal(h.value, "Rizal St, Brgy. Poblacion 3, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, { chosen: true, place });
  assert.match(h.status(), /Selected from Google Maps\. The map confirmed the barangay; the house itself is not checked\./);

  // A new search starts a new session.
  h.type("Rizal St Pob");
  await h.flush();
  assert.match(h.requests.at(-1), /session=00000000-0000-4000-8000-000000000002$/);
  assert.deepEqual(h.selection, { chosen: false, place: null }, "editing the text clears the map selection");
});

test("a map place without an official barangay asks the Front Desk for it, and is not called map-verified", async () => {
  const place = { placeId: "ChIJplaza0000001", barangay: null, detail: "", formattedAddress: "City Plaza, Cabadbaran City", token: "signed.place" };
  const h = harness("", { mapSearch: true }, {
    request: route => route.startsWith("/address-search/place") ? { success: true, address: place }
      : { available: true, suggestions: [{ ...MAP_RESULT, placeId: "ChIJplaza0000001", mainText: "City Plaza" }] }
  });
  h.type("plaza");
  await h.flush();
  h.options()[0].props.onClick();
  await tick();
  assert.match(text(h.render()), /Google Maps found this place in Cabadbaran City but not its barangay/);
  assert.equal(h.button("Use address").props.disabled, true);
  h.find("res-pick").props.onChange({ target: { value: "Poblacion 5" } });
  h.button("Use address").props.onClick();
  assert.equal(h.value, "Brgy. Poblacion 5, Cabadbaran City, Agusan del Norte");
  assert.deepEqual(h.selection, { chosen: true, place });
  h.render();
  assert.ok(h.find("res-detail"), "the Purok / Street entry follows");
  h.find("res-detail").props.onKeyDown(key("Escape"));
  assert.match(h.status(), /Found on Google Maps; the barangay or details were entered by the Front Desk\./);
});

test("a place outside the city, or a map failure, is reported without losing the text or the barangay list", async () => {
  const h = harness("", { mapSearch: true }, {
    request: route => route.startsWith("/address-search/place")
      ? { error: "That place is not in Cabadbaran City, Agusan del Norte. Choose an address within Cabadbaran City, or enter it manually.", status: 422 }
      : { available: true, suggestions: [MAP_RESULT] }
  });
  h.type("Rizal Calamba");
  await h.flush();
  h.options()[0].props.onClick();
  await tick();
  const shown = text(h.render());
  assert.match(shown, /That place is not in Cabadbaran City/);
  assert.equal(h.value, "Rizal Calamba", "the typed text stays");
  assert.deepEqual(h.selection, { chosen: false, place: null });

  const down = harness("", { mapSearch: true }, { request: () => ({ error: "Map search is busy right now.", status: 429 }) });
  down.type("Rizal Calamba");
  await down.flush();
  const text2 = text(down.render());
  assert.match(text2, /Map search is unavailable right now\. Use the barangay list below, or enter the address manually\./);
  assert.equal(down.options().length, 1, "the verified barangay suggestion is still offered");
  assert.equal(text(down.options()[0]), "Rizal, Brgy. CalambaCabadbaran City, Agusan del Norte");
  assert.ok(down.button("Enter address manually"));
});

test("without a key on the server the map is not asked again for the rest of the form", async () => {
  const h = harness("", { mapSearch: true }, { request: () => ({ success: true, available: false, suggestions: [] }) });
  h.type("Calibunan");
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.type("Calibunan purok 2");
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(text(h.render()), /Google Maps/);
  assert.equal(h.options().length, 1, "the verified barangay search works on its own");
});

test("results for earlier text are never offered while a new search runs", async () => {
  let answer = { available: true, suggestions: [MAP_RESULT] };
  const h = harness("", { mapSearch: true }, { request: () => answer });
  h.type("Rizal");
  await h.flush();
  assert.equal(nodes(h.render(), node => node.props?.className?.includes?.("is-map")).length, 1);
  answer = { available: true, suggestions: [] };
  h.type("Rizal X");
  assert.equal(nodes(h.render(), node => /residency-search-option.*is-map/.test(node.props?.className || "")).length, 0);
});

test("callers without map search never call the map", async () => {
  const h = harness("", { mapSearch: false }, { request: () => { throw new Error("must not be called"); } });
  h.type("Rizal Calamba");
  await h.flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.options().length, 1);
});

// The search itself (lib/residency.js).
test("search: barangay names, partial names and words inside names find only verified barangays", () => {
  const labels = query => Array.from(residency.suggestResidencies(query), item => item.label);
  assert.deepEqual(labels("Calibunan"), ["Brgy. Calibunan, Cabadbaran City, Agusan del Norte"]);
  assert.deepEqual(labels("luna"), ["Brgy. Antonio Luna, Cabadbaran City, Agusan del Norte"]);
  assert.deepEqual(labels("pob 1"), [1, 10, 11, 12].map(n => `Brgy. Poblacion ${n}, Cabadbaran City, Agusan del Norte`));
  assert.deepEqual(labels("#12 Rizal St., Purok 3, Brgy. Calibunan, Cabadbaran City"), ["#12 Rizal St., Purok 3, Brgy. Calibunan, Cabadbaran City, Agusan del Norte"]);
  // An address names the barangay last, so a street named after another barangay stays the street.
  assert.deepEqual(labels("Mabini St. Calibunan"), ["Mabini St., Brgy. Calibunan, Cabadbaran City, Agusan del Norte"]);
  assert.deepEqual(labels("Brgy.Tolosa"), ["Brgy. Tolosa, Cabadbaran City, Agusan del Norte"]);
  assert.deepEqual(labels("Purok 3"), []);
  assert.deepEqual(labels("Butuan"), []);
  assert.equal(residency.suggestResidencies("").length, 31);
  for (const query of ["a", "ca", "bay", "Purok 2 p"]) {
    for (const item of residency.suggestResidencies(query)) assert.ok(residency.CABADBARAN_BARANGAYS.includes(item.barangay), query);
  }
});

test("search: an address already in the bar is kept, and every suggestion is a valid address", () => {
  const typed = "purok 3, brgy. calibunan, cabadbaran city, agusan del norte";
  assert.deepEqual(Array.from(residency.suggestResidencies(typed), item => item.label), ["purok 3, Brgy. Calibunan, Cabadbaran City, Agusan del Norte"]);
  for (const query of ["Calibunan", "Purok 3 Calibunan", "Purok 3, Cali", "Del Pilar St, Mabini", "Sitio Ilaya pob 12", "Cabadbaran City Hall, Poblacion 3"]) {
    for (const item of residency.suggestResidencies(query)) assert.equal(residency.residencyProblem(item.label), "", item.label);
  }
});
