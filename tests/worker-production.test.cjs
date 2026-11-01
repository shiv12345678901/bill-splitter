const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const { loadContract, healthy, createDiagnostics } = require("../server/services/worker-runtime.cjs");

test("deployment configuration keeps state, drops privileges and publishes no admin ports", () => {
  const compose = YAML.parse(fs.readFileSync("docker-compose.yml", "utf8"));
  const worker = compose.services.worker;
  assert.equal(worker.ports, undefined);
  assert.equal(worker.restart, "unless-stopped");
  assert.equal(worker.read_only, true);
  assert.deepEqual(worker.cap_drop, ["ALL"]);
  assert.ok(worker.volumes.includes("worker_state:/state"));
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /chromium/);
  assert.match(dockerfile, /COPY package\.json package-lock\.json \.npmrc/);
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional/);
  assert.match(fs.readFileSync(".npmrc", "utf8"), /^omit=optional$/m);
  assert.match(fs.readFileSync(".dockerignore", "utf8"), /^\*\*/);
});

test("missing or incomplete production contracts cannot enable writes", () => {
  assert.equal(loadContract().approved, false);
  assert.equal(loadContract("config/worker-contract.example.json").approved, false);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worker-contract-"));
  const filename = path.join(folder, "contract.json");
  const value = { verified: true, schemaReviewed: true, museRulesReviewed: true, legacySourceIdsReviewed: true,
    legacyWorkerStopped: true, dependencyAuditReviewed: true, reviewReference: "fixture review", sourceIdMode: "receipt-id", dateMode: "UTC",
    shareRounding: "floor", zeroAmountPolicy: "preserve", members: ["Alex", "Jamie", "Morgan", "Taylor"], aliases: { sender: "Alex" }, settlementIdMode: "existing-only" };
  fs.writeFileSync(filename, JSON.stringify(value));
  assert.equal(loadContract(filename).approved, true);
  fs.writeFileSync(filename, JSON.stringify({ ...value, aliases: { sender: "Unknown" } }));
  assert.equal(loadContract(filename).approved, false);
});

test("private diagnostics distinguish liveness from readiness and expire stale state", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "worker-health-"));
  const diagnostics = createDiagnostics(folder, () => ({ ready: false, stopping: false }));
  diagnostics.stop();
  const state = JSON.parse(fs.readFileSync(path.join(folder, "health.json"), "utf8"));
  assert.equal(healthy(state), true);
  assert.equal(healthy(state, { ready: true }), false);
  assert.equal(healthy(state, { now: Date.now() + 60000 }), false);
});

test("pairing QR is never sent to logs or an HTTP listener", () => {
  const source = fs.readFileSync("server/worker-sync.cjs", "utf8");
  assert.match(source, /fs.writeFileSync\(qrFile/);
  assert.doesNotMatch(source, /console\.log\(await QRCode|Raw QR|\.listen\(/);
  assert.match(source, /mode !== "pair"/);
});
