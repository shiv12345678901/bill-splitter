const crypto = require("node:crypto");

const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
const cleanId = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.trim() !== "[object Object]"
    ? value.trim()
    : null;

function configuredStartBoundary(groupId, date) {
  if (!validDate(date)) return null;
  return {
    id: `configured-start:${groupId}:${date}`,
    dateStr: date,
    timestamp: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000),
    text: "Configured group start",
    source: "configured",
    confidence: "HIGH",
  };
}

function normaliseBoundary(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanId(value.id);
  if (!id) return null;
  return {
    id,
    dateStr: validDate(value.dateStr) ? value.dateStr : null,
    timestamp: Number.isFinite(Number(value.timestamp))
      ? Number(value.timestamp)
      : null,
    text: typeof value.text === "string" ? value.text.slice(0, 300) : "",
    source: value.source || "manual",
    confidence: value.confidence || "HIGH",
  };
}

function cycleKeyFor(groupId, startBoundary) {
  const boundary = normaliseBoundary(startBoundary);
  return boundary ? `${groupId}|boundary:${boundary.id}` : null;
}

function completenessFor(cycle) {
  const images = Array.isArray(cycle.images) ? cycle.images : [];
  const expected = Math.max(
    0,
    Number(cycle.completeness?.expected ?? cycle.expectedMedia ??
      (Number(cycle.groceryCount) || 0) + (Number(cycle.paymentCount) || 0)),
  );
  const processed = Math.max(
    0,
    Number(cycle.completeness?.processed ?? cycle.imageCount ?? images.length),
  );
  const failed = Math.max(
    0,
    Number(cycle.completeness?.failed ?? images.filter((image) => image.status === "failed").length),
  );
  const excluded = Math.max(
    0,
    Number(cycle.completeness?.excluded ?? images.filter((image) => image.isExcluded).length),
  );
  return { expected, processed, failed, excluded };
}

function migrateCycle(cycle, { groupStartDates = {} } = {}) {
  const groupId = cleanId(cycle?.groupId) || "unknown-group";
  let startBoundary = normaliseBoundary(cycle.startBoundary);
  if (!startBoundary) startBoundary = normaliseBoundary(cycle.checkpoint);
  if (!startBoundary && cycle.startBoundaryId) {
    startBoundary = normaliseBoundary({
      id: cycle.startBoundaryId,
      dateStr: cycle.startDate,
      source: cycle.boundarySource,
      confidence: cycle.boundaryConfidence,
    });
  }
  if (!startBoundary && cycle.startDate === groupStartDates[groupId]) {
    startBoundary = configuredStartBoundary(groupId, cycle.startDate);
  }
  let endBoundary = normaliseBoundary(cycle.endBoundary);
  if (!endBoundary && cycle.endBoundaryId) {
    endBoundary = normaliseBoundary({
      id: cycle.endBoundaryId,
      dateStr: cycle.endDate,
      source: cycle.endBoundarySource,
      confidence: cycle.endBoundaryConfidence,
    });
  }
  const active = cycle.status === "ACTIVE";
  const issues = [];
  if (!startBoundary) issues.push("Missing immutable start boundary message ID");
  if (!active && !endBoundary)
    issues.push("Missing immutable end boundary message ID");
  if (startBoundary?.confidence === "LOW" || endBoundary?.confidence === "LOW")
    issues.push("A boundary was inferred from a settlement calculation");
  const cycleKey =
    cycleKeyFor(groupId, startBoundary) ||
    cycle.cycleKey ||
    `${groupId}|legacy:${crypto.randomUUID()}`;
  return {
    ...cycle,
    schemaVersion: 2,
    cycleKey,
    legacyCycleKey:
      cycle.cycleKey && cycle.cycleKey !== cycleKey
        ? cycle.cycleKey
        : cycle.legacyCycleKey,
    startBoundary,
    endBoundary,
    startBoundaryId: startBoundary?.id || null,
    endBoundaryId: endBoundary?.id || null,
    checkpoint: startBoundary?.source === "configured" ? null : startBoundary,
    completeness: completenessFor(cycle),
    provenance: {
      status: issues.length ? "UNRESOLVED" : "RESOLVED",
      issues,
      reviewedAt: cycle.provenance?.reviewedAt || null,
    },
  };
}

function validateCycles(cycles) {
  const migrated = cycles.map((cycle) => migrateCycle(cycle));
  const byGroup = new Map();
  for (const cycle of migrated) {
    if (!byGroup.has(cycle.groupId)) byGroup.set(cycle.groupId, []);
    byGroup.get(cycle.groupId).push(cycle);
  }
  for (const group of byGroup.values()) {
    group.sort((a, b) =>
      (a.startBoundary?.timestamp || 0) - (b.startBoundary?.timestamp || 0),
    );
    const starts = new Set();
    for (let index = 0; index < group.length; index++) {
      const cycle = group[index];
      const issues = new Set(cycle.provenance?.issues || []);
      if (cycle.startBoundaryId && starts.has(cycle.startBoundaryId))
        issues.add("Conflicting cycle uses the same start boundary");
      if (cycle.startBoundaryId) starts.add(cycle.startBoundaryId);
      if (
        cycle.endBoundary?.timestamp &&
        cycle.startBoundary?.timestamp &&
        cycle.endBoundary.timestamp <= cycle.startBoundary.timestamp
      ) issues.add("End boundary is not after the start boundary");
      const next = group[index + 1];
      if (next && cycle.status !== "ACTIVE") {
        if (!cycle.endBoundaryId || !next.startBoundaryId) {
          issues.add("Cannot prove that this period meets the next period");
        } else if (cycle.endBoundaryId !== next.startBoundaryId) {
          issues.add("Gap or overlap exists at the next cycle boundary");
          next.provenance.issues = [
            ...new Set([
              ...(next.provenance.issues || []),
              "Gap or overlap exists at the previous cycle boundary",
            ]),
          ];
          next.provenance.status = "UNRESOLVED";
        }
      }
      cycle.provenance = {
        ...cycle.provenance,
        status: issues.size ? "UNRESOLVED" : "RESOLVED",
        issues: [...issues],
      };
    }
  }
  return migrated;
}

module.exports = {
  configuredStartBoundary,
  normaliseBoundary,
  cycleKeyFor,
  completenessFor,
  migrateCycle,
  validateCycles,
};
