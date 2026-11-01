const fs = require("node:fs");
const path = require("node:path");

function loadContract(filename) {
  if (!filename) return { approved: false, reason: "Missing reviewed worker contract." };
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8"));
    const flags = ["verified", "schemaReviewed", "museRulesReviewed", "legacySourceIdsReviewed", "legacyWorkerStopped", "dependencyAuditReviewed"];
    if (flags.some((key) => value[key] !== true)) throw new Error("Schema, Muse rules, legacy handover and dependency audit require explicit review.");
    if (!value.reviewReference || value.reviewReference.startsWith("REPLACE")) throw new Error("Missing review reference.");
    if (value.sourceIdMode !== "receipt-id") throw new Error("Legacy source-ID mapping requires a custom adapter.");
    if (!["UTC", "Australia/Sydney"].includes(value.dateMode)) throw new Error("Unconfirmed date convention.");
    if (!["floor", "round"].includes(value.shareRounding)) throw new Error("Unconfirmed share rounding.");
    if (!["preserve", "reject"].includes(value.zeroAmountPolicy)) throw new Error("Unconfirmed zero-amount policy.");
    if (value.settlementIdMode !== "existing-only") throw new Error("Production settlement creation is disabled; use existing-only.");
    if (!Array.isArray(value.members) || value.members.length !== 4 || value.members.some((m) => typeof m !== "string" || !m.trim() || m !== m.trim()) || new Set(value.members).size !== value.members.length)
      throw new Error("Supply the four distinct canonical household member names.");
    if (!value.aliases || typeof value.aliases !== "object" || Object.values(value.aliases).some((m) => !value.members.includes(m))) throw new Error("Aliases must map to reviewed members.");
    return { approved: true, value };
  } catch (error) { return { approved: false, reason: error.message }; }
}

function createDiagnostics(directory, getState) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "health.json");
  const publish = () => {
    const state = getState();
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), pid: process.pid, ...state }), { mode: 0o600 });
    fs.renameSync(temporary, filename);
  };
  publish();
  const timer = setInterval(publish, 10000);
  return { stop() { clearInterval(timer); } };
}

function healthy(state, { ready = false, now = Date.now() } = {}) {
  return now - Date.parse(state.updatedAt) < 45000 && now >= Date.parse(state.updatedAt) && !state.stopping && (!ready || state.ready === true);
}

module.exports = { loadContract, createDiagnostics, healthy };
