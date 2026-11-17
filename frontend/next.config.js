const path = require("node:path");

// The build root is the repository folder that holds frontend/ and backend/ (kept unchanged
// when the Algorithm Simulation page, which imported backend/simulation, was removed).
const repositoryRoot = path.join(__dirname, "..");

module.exports = {
  turbopack: { root: repositoryRoot },
  outputFileTracingRoot: repositoryRoot,
  experimental: { agentUpgrade: "security" }
};
