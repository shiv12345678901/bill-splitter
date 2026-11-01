const fs = require("node:fs");
const path = require("node:path");
const { healthy } = require("../server/services/worker-runtime.cjs");
try {
  const state = JSON.parse(fs.readFileSync(path.join(process.env.SPLITMATE_RUNTIME_DIR || "/state/run", "health.json"), "utf8"));
  if (process.argv.includes("--show")) console.log(JSON.stringify(state, null, 2));
  process.exitCode = healthy(state, { ready: process.argv.includes("--ready") }) ? 0 : 1;
} catch { process.exitCode = 1; }
