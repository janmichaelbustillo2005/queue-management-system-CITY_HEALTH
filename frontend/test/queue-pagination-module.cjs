// components/QueuePagination.js (the page footer shared by Front Desk Patient Management and
// Superadmin Queue Management) compiled the same way the tests compile pages, for the tests'
// dependency resolvers. `jsxRuntime` is the calling harness's react/jsx-runtime stand-in, so the
// footer's elements have the same shape as the rest of that harness's tree.
// Call it after swc.loadBindings(), as every test's before() does.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const swc = require("next/dist/build/swc");
const { isQueueViewModule, loadQueueView } = require("./queue-view-module.cjs");

let compiled;

function loadQueuePagination(jsxRuntime) {
  if (!compiled) {
    const filename = path.join(__dirname, "../components/QueuePagination.js");
    compiled = swc.transformSync(fs.readFileSync(filename, "utf8"), {
      filename,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" }
    }).code;
  }
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name) {
      if (name === "react/jsx-runtime") return jsxRuntime;
      if (isQueueViewModule(name)) return loadQueueView();
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return module.exports;
}

const isQueuePaginationModule = (name) => name === "../components/QueuePagination" || name === "./QueuePagination";

module.exports = { loadQueuePagination, isQueuePaginationModule };
