// lib/queueView.js (the display, counter and filter rules shared by Front Desk Patient
// Management and Superadmin Queue Management) compiled the same way the tests compile pages,
// for the tests' dependency resolvers. It imports nothing.
// Call it after swc.loadBindings(), as every test's before() does.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");

let cached;

function loadQueueView() {
  if (cached) return cached;
  const filename = path.join(__dirname, "../lib/queueView.js");
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

const isQueueViewModule = (name) => name === "../lib/queueView";

module.exports = { loadQueueView, isQueueViewModule };
