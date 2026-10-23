const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

test("backend configuration loads backend/.env regardless of the launch directory", () => {
  // A7: the configuration requires a generated secret, so the test supplies one.
  const isolatedSecret = crypto.randomBytes(48).toString("base64url");
  const filename = path.resolve(__dirname, "../src/config/env.js");
  const expectedPath = path.resolve(__dirname, "../.env");
  for (const launchDirectory of [path.resolve(__dirname, "../.."), path.resolve(__dirname, ".."), path.resolve(__dirname, "../../frontend")]) {
    const processState = { cwd: () => launchDirectory, env: {} };
    let requestedPath;
    const dotenv = {
      config({ path: configPath }) {
        requestedPath = configPath;
        // Isolate configuration loading from actual credentials on disk.
        if (configPath === expectedPath) processState.env.JWT_SECRET = isolatedSecret;
      }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      __dirname: path.dirname(filename), module, process: processState,
      require: (name) => name === "path" ? path : dotenv
    }, { filename });
    assert.equal(requestedPath, expectedPath, launchDirectory);
    assert.equal(module.exports.jwtSecret, isolatedSecret, launchDirectory);
  }
});
