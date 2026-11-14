// Starts the Next.js frontend for isolated browser checks on 127.0.0.1:3100, pointed ONLY at the
// isolated test backend (backend/test/isolated/server.js on 127.0.0.1:4100). Refuses to start when
// the frontend folder has any .env file other than .env.example, since one could point elsewhere.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const frontendDir = path.resolve(__dirname, "../../../frontend");
const envFiles = fs.readdirSync(frontendDir).filter((name) => name.startsWith(".env") && name !== ".env.example");
if (envFiles.length) {
  console.error(`[isolated-frontend] REFUSED: ${envFiles.join(", ")} present in frontend/.`);
  process.exit(1);
}
const apiPort = Number(process.env.ISOLATED_PORT || 4100);
const child = spawn(process.execPath, [path.join(frontendDir, "node_modules/next/dist/bin/next"), "dev", "--webpack", "-p", "3100", "-H", "127.0.0.1"], {
  cwd: frontendDir,
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${apiPort}/api`, NEXT_TELEMETRY_DISABLED: "1" }
});
child.on("exit", (code) => process.exit(code ?? 0));
