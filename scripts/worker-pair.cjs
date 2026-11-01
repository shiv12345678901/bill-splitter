// Invoke only through an authenticated SSH + Docker exec session.
const fs = require("node:fs");
const path = require("node:path");
try {
  const directory = process.env.SPLITMATE_RUNTIME_DIR || "/state/run";
  const health = JSON.parse(fs.readFileSync(path.join(directory, "health.json"), "utf8"));
  const qr = path.join(directory, "pairing-qr.txt");
  if (health.mode !== "pair" || Date.now() - fs.statSync(qr).mtimeMs > 60000) throw new Error("No current pairing QR. Wait a few seconds and retry.");
  process.stdout.write(fs.readFileSync(qr, "utf8"));
} catch (error) { console.error(error.message); process.exitCode = 1; }
