const path = require("node:path");

// The Algorithm Simulation page runs the research simulator from backend/simulation in the
// browser, so the build root is the repository folder that holds frontend/ and backend/.
const repositoryRoot = path.join(__dirname, "..");

module.exports = {
  turbopack: { root: repositoryRoot },
  outputFileTracingRoot: repositoryRoot
};
