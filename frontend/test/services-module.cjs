// lib/services.js (the Types of Services every screen reads) compiled the same way the
// tests compile pages, for the tests' dependency resolvers. It imports nothing.
// Call it after swc.loadBindings(), as every test's before() does.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

const SPECIFIERS = new Set(["./services", "../lib/services"]);
let cached;

function loadServices() {
  if (cached) return cached;
  const filename = path.join(__dirname, "../lib/services.js");
  const { code } = swc.transformSync(fs.readFileSync(filename, "utf8"), {
    filename,
    jsc: { parser: { syntax: "ecmascript" } },
    module: { type: "commonjs" }
  });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports });
  cached = module.exports;
  return cached;
}

const isServicesModule = (name) => SPECIFIERS.has(name);

module.exports = { loadServices, isServicesModule };
