const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const swc = require("next/dist/build/swc");
const { loadServices } = require("./services-module.cjs");

// The Types of Services exactly as City Health lists them (spelling, capitals, punctuation).
const REQUESTED = ["Medical consultation", "Maternal healthcare", "Family planning", "Child healthcare", "Dental healthcare",
  "Nutrition", "Diagnostic imaging", "Women's health", "Mental healthcare", "Medical documentation", "Marriage preparation",
  "Environmental health", "Food safety"];
const FORMER = ["consultation", "checkup", "prenatal", "maternity"];
const plain = (value) => JSON.parse(JSON.stringify(value));

let services;
before(async () => {
  await swc.loadBindings();
  services = loadServices();
});

test("registration offers exactly the 13 requested services, in order, with no duplicates", () => {
  assert.deepEqual(plain(services.OFFERED_SERVICES.map((service) => service.label)), REQUESTED);
  const values = services.OFFERED_SERVICES.map((service) => service.value);
  assert.equal(new Set(values).size, 13);
  assert.equal(new Set(services.OFFERED_SERVICES.map((service) => service.label.toLowerCase())).size, 13);
  assert.ok(values.every((value) => !FORMER.includes(value)), "former services are not offered");
});

test("earlier visits keep a readable service name, and history filters still reach them", () => {
  assert.equal(services.serviceName("consultation"), "General Consultation");
  assert.equal(services.serviceName("family_planning"), "Family planning");
  assert.equal(services.serviceName("obgyne"), "Obstetrics and Gynecology");
  assert.equal(services.serviceName("vaccination"), "vaccination", "an unlabelled stored key is shown as stored");
  const filters = services.SERVICE_FILTER_OPTIONS;
  assert.deepEqual(plain(filters.slice(0, 13)), plain(services.OFFERED_SERVICES));
  assert.deepEqual(plain(filters.slice(13).map((option) => option.value)), FORMER);
  assert.ok(filters.slice(13).every((option) => option.label.endsWith(" (former)")));
});

test("the backend recognises the same offered and former service keys", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../backend/src/services/queueService.js"), "utf8");
  const list = (name) => JSON.parse(source.match(new RegExp(`const ${name} = Object\\.freeze\\((\\[[^\\]]*\\])\\)`))[1]);
  assert.deepEqual(list("OFFERED_SERVICES"), plain(services.OFFERED_SERVICES.map((service) => service.value)));
  assert.deepEqual(list("FORMER_SERVICES"), FORMER);
});
