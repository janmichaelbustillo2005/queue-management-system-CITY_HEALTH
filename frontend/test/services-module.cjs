// lib/services.js (the Types of Services every screen reads) compiled the same way the
// tests compile pages, for the tests' dependency resolvers. It imports nothing.
// lib/residency.js (RES1, the Cabadbaran City address list) is served the same way.
// Call these after swc.loadBindings(), as every test's before() does.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const SPECIFIERS = new Set(["./services", "../lib/services"]);
const RESIDENCY_SPECIFIERS = new Set(["./residency", "../lib/residency"]);
const cache = new Map();

function loadLib(file) {
  if (cache.has(file)) return cache.get(file);
  const filename = path.join(__dirname, "../lib", file);
  const { code } = swc.transformSync(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript" } },
    module: { type: "commonjs" }
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports });
  cache.set(file, module.exports);
  return module.exports;
}

const loadServices = () => loadLib("services.js");
const isServicesModule = (name) => SPECIFIERS.has(name);
const loadResidency = () => loadLib("residency.js");
const isResidencyModule = (name) => RESIDENCY_SPECIFIERS.has(name);

module.exports = { loadServices, isServicesModule, loadResidency, isResidencyModule };
