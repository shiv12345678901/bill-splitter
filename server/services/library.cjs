const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const database = require("./database.cjs");
const {
  configuredStartBoundary,
  normaliseBoundary,
  cycleKeyFor,
  completenessFor,
  migrateCycle,
  validateCycles,
} = require("./cycle-integrity.cjs");
const DATA_DIR = database.DATA_DIR;
const IMAGES_DIR = path.join(DATA_DIR, "media_cache");
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Parallel OCR workers update the library concurrently; serialising every
// read-modify-write keeps records from silently overwriting each other.
let writeQueue = Promise.resolve();
const serialized = (fn) => {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
};
const loadLibrary = () => database.getReceipts();
const saveLibrary = (library) => database.replaceReceipts(library);
const loadSettlementCycles = () => validateCycles(database.getCycles());
const saveSettlementCycles = (cycles) => database.replaceCycles(cycles);

function mergeCycleRecords(existing, incoming) {
  if (!existing) return { ...incoming };
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  if (!incoming.images && existing.images) merged.images = existing.images;
  if (!incoming.totals && existing.totals) merged.totals = existing.totals;
  return merged;
}

function normaliseCycles(cycles) {
  return validateCycles(cycles);
}

const safeName = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
const extFor = (mimetype) => {
  if (!mimetype) return "jpg";
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  if (mimetype.includes("pdf")) return "pdf";
  return "jpg";
};

const hashBuffer = (buffer) =>
  crypto.createHash("sha256").update(buffer).digest("hex");

function imageFilePath(entry) {
  return path.join(IMAGES_DIR, entry.fileName);
}

// Stores one receipt image (skipped when the exact file already exists on
// disk) and its scanned JSON data. Returns the stored record. When
// `dedupOf` is provided the record points at the existing file instead of
// saving a second copy of identical content.
function recordImage(args) {
  return serialized(() => {
    const { id, groupId, buffer, mimetype, contentHash, ocr, senderName, timestamp, dedupOf } = args;
    const existing = database.getReceipt(id);
    const fileName =
      dedupOf?.fileName ||
      existing?.fileName ||
      `${safeName(id)}.${extFor(mimetype)}`;
    if (
      buffer &&
      !dedupOf &&
      !fs.existsSync(imageFilePath({ fileName }))
    ) {
      try {
        const target = path.join(IMAGES_DIR, fileName);
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, buffer);
        fs.renameSync(temporary, target);
      } catch (err) {
        console.warn("[Library] Could not write image file:", err.message);
      }
    }
  const record = {
    id,
    groupId: groupId || existing?.groupId || "",
    fileName,
    // The message id whose cached file actually holds the image bytes
    // (differs from `id` when identical content was deduplicated).
    fileId: dedupOf?.id || existing?.fileId || id,
    fileGroupId: dedupOf?.groupId || existing?.fileGroupId || groupId || "",
    mimetype: mimetype || existing?.mimetype || "image/jpeg",
    contentHash: contentHash || existing?.contentHash || null,
    date: timestamp
      ? new Date(timestamp * 1000).toISOString()
      : existing?.date || null,
    paidBy: senderName || existing?.paidBy || "",
    merchant: ocr?.merchant ?? existing?.merchant ?? "",
    amount: ocr?.amount ?? existing?.amount ?? 0,
    category: ocr?.category ?? existing?.category ?? "Other",
    confidence: ocr?.confidence ?? existing?.confidence ?? "LOW",
    isBankTransfer: Boolean(ocr?.isBankTransfer ?? existing?.isBankTransfer),
    isBlurry: Boolean(ocr?.isBlurry ?? existing?.isBlurry),
    scannedAt: existing?.scannedAt || new Date().toISOString(),
    cycles: existing?.cycles || [],
  };
    database.putReceipt(record);
    return record;
  });
}

// Finds an already-scanned image by content so an identical photo (re-sent
// in a later cycle) reuses its result instead of paying for OCR again.
function findByContentHash(contentHash) {
  return database.findReceiptByHash(contentHash);
}

const findById = (id) => database.getReceipt(id);

// Saves the cycles found by a full group scan (detected from the chat's
// "clear up to date" markers). Scan results — images, totals, dates — are
// preserved when a cycle has already been scanned.
function upsertDetectedCycles(groupId, groupName, cycles) {
  return serialized(() => {
    const saved = normaliseCycles(loadSettlementCycles());
    const now = new Date().toISOString();
    const detectedKeys = new Set();
    for (const c of cycles) {
      const startBoundary =
        normaliseBoundary(c.startBoundary || c.startCheckpoint) ||
        (!c.startBoundary && !c.startCheckpoint
          ? configuredStartBoundary(groupId, c.startDate)
          : null);
      const endBoundary = normaliseBoundary(c.endBoundary || c.endCheckpoint);
      const cycleKey = cycleKeyFor(groupId, startBoundary);
      if (!cycleKey) continue;
      detectedKeys.add(cycleKey);
      const legacyDate = c.startCheckpoint?.dateStr || c.startDate;
      const matches = saved.filter(
        (record) =>
          record.groupId === groupId &&
          (record.cycleKey === cycleKey ||
            ((!record.startBoundaryId || record.startBoundaryId === "[object Object]") &&
              (record.startDate === c.startDate ||
                record.checkpoint?.dateStr === legacyDate ||
                record.cycleKey?.endsWith(`|${legacyDate}`)))),
      );
      const existing =
        matches.find((record) => record.scannedAt) || matches[0] || null;
      const record = {
        ...(existing || {}),
        schemaVersion: 2,
        cycleKey,
        groupId,
        groupName: groupName || existing?.groupName || "",
        detectedId: c.id,
        status: c.status || "SETTLED",
        startDate: c.startDate,
        endDate: c.endDate,
        startBoundary,
        endBoundary,
        startBoundaryId: startBoundary.id,
        endBoundaryId: endBoundary?.id || null,
        checkpoint: startBoundary.source === "configured" ? null : startBoundary,
        groceryCount: c.groceryCount ?? 0,
        paymentCount: c.paymentCount ?? 0,
        detectedAt: now,
        // Scanned details survive re-detection.
        imageCount: existing?.imageCount ?? null,
        images: existing?.images || [],
        totals: existing?.totals || null,
        scannedAt: existing?.scannedAt || null,
      };
      record.completeness = completenessFor(record);
      const index = existing ? saved.indexOf(existing) : -1;
      if (index >= 0) saved[index] = record;
      else saved.unshift(record);
      for (const duplicate of matches) {
        if (duplicate !== existing && !duplicate.scannedAt) {
          const duplicateIndex = saved.indexOf(duplicate);
          if (duplicateIndex >= 0) saved.splice(duplicateIndex, 1);
        }
      }
    }
    const canonicalKeys = new Set(
      saved
        .filter((cycle) => cycle.groupId === groupId && cycle.startBoundaryId)
        .map((cycle) => cycle.cycleKey),
    );
    for (const key of canonicalKeys) {
      const duplicates = saved.filter(
        (cycle) => cycle.groupId === groupId && cycle.cycleKey === key,
      );
      if (duplicates.length < 2) continue;
      const keeper =
        duplicates.find((cycle) => cycle.scannedAt) ||
        duplicates.find((cycle) => cycle.status === "ACTIVE") ||
        duplicates[0];
      for (const duplicate of duplicates) {
        if (duplicate === keeper || duplicate.scannedAt) continue;
        saved.splice(saved.indexOf(duplicate), 1);
      }
    }
    // Old unscanned detections are replaceable. Scanned records without
    // immutable boundaries are retained and explicitly surfaced for repair.
    const retained = saved.filter(
      (cycle) =>
        cycle.groupId !== groupId ||
        cycle.scannedAt ||
        !cycle.detectedId ||
        detectedKeys.has(cycle.cycleKey),
    );
    const validated = validateCycles(retained);
    saveSettlementCycles(validated);
    return validated;
  });
}

function recordSettlementCycle(args) {
  return serialized(() => {
    const {
      groupId,
      groupName,
      startDate,
      endDate,
      checkpoint,
      startBoundary: suppliedStart,
      endBoundary: suppliedEnd,
      images,
      totals,
      expectedMedia,
    } = args;
    const cycles = normaliseCycles(loadSettlementCycles());
    const startBoundary = normaliseBoundary(suppliedStart || checkpoint);
    const endBoundary = normaliseBoundary(suppliedEnd);
    const cycleKey = cycleKeyFor(groupId, startBoundary);
    if (!cycleKey)
      throw new Error(
        "This scan has no immutable cycle boundary. Detect or repair the cycle before saving it.",
      );
    const index = cycles.findIndex((c) => c.cycleKey === cycleKey);
    const existing = index >= 0 ? cycles[index] : null;
    const scanDetails = {
      schemaVersion: 2,
      cycleKey,
      groupId,
      groupName: groupName || existing?.groupName || "",
      startDate,
      endDate,
      startBoundary,
      endBoundary,
      startBoundaryId: startBoundary.id,
      endBoundaryId: endBoundary?.id || null,
      checkpoint: startBoundary.source === "configured" ? null : startBoundary,
      imageCount: images.length,
      images: images.map((image) => ({
        id: image.id,
        fileName: image.fileName,
        merchant: image.merchant,
        amount: image.amount,
        paidBy: image.paidBy,
        status:
          image.status ||
          (image.merchant === "Receipt could not be read" ? "failed" : "processed"),
        isExcluded: Boolean(image.isExcluded),
      })),
      totals: {
        totalPool: totals?.totalPool ?? null,
        fairShare: totals?.fairShare ?? null,
        memberTotals: totals?.memberTotals ?? {},
      },
    };
    scanDetails.completeness = completenessFor({
      ...scanDetails,
      expectedMedia: expectedMedia ?? existing?.completeness?.expected,
    });
    const comparable = (cycle) =>
      JSON.stringify({
        startDate: cycle?.startDate,
        endDate: cycle?.endDate,
        checkpoint: cycle?.checkpoint || null,
        imageCount: cycle?.imageCount,
        images: cycle?.images || [],
        totals: cycle?.totals || null,
      });
    const changed = comparable(existing) !== comparable(scanDetails);
    const record = mergeCycleRecords(existing, {
      ...scanDetails,
      scannedAt: changed
        ? new Date().toISOString()
        : existing?.scannedAt || new Date().toISOString(),
    });
    if (index >= 0) cycles[index] = record;
    else cycles.unshift(record);
    const validated = validateCycles(cycles);
    saveSettlementCycles(validated);
    // Keep receipt-to-cycle links exact when a later scan adds or removes
    // images from the same logical cycle.
    const library = loadLibrary();
    let libraryChanged = false;
    const includedIds = new Set(images.map((image) => image.id));
    for (const entry of Object.values(library)) {
      const links = Array.isArray(entry.cycles) ? entry.cycles : [];
      const shouldLink = includedIds.has(entry.id);
      const linked = links.includes(cycleKey);
      if (shouldLink && !linked) {
        entry.cycles = [...links, cycleKey];
        libraryChanged = true;
      } else if (!shouldLink && linked) {
        entry.cycles = links.filter((key) => key !== cycleKey);
        libraryChanged = true;
      }
    }
    if (libraryChanged) {
      database.transaction(() => {
        for (const entry of Object.values(library)) database.putReceipt(entry);
      });
    }
    return validated.find((cycle) => cycle.cycleKey === cycleKey) || record;
  });
}

function migrateSettlementCycles({ groupStartDates = {} } = {}) {
  const raw = database.getCycles();
  if (!raw.length) return [];
  const migrated = validateCycles(
    raw.map((cycle) => migrateCycle(cycle, { groupStartDates })),
  );
  if (JSON.stringify(raw) !== JSON.stringify(migrated))
    saveSettlementCycles(migrated);
  return migrated;
}

function manualBoundary(input) {
  const boundary = normaliseBoundary({
    ...input,
    source: "manual",
    confidence: "HIGH",
  });
  if (!boundary || !boundary.dateStr)
    throw new Error("Enter the WhatsApp boundary message ID and its date.");
  if (!boundary.timestamp)
    boundary.timestamp = Math.floor(
      new Date(`${boundary.dateStr}T12:00:00Z`).getTime() / 1000,
    );
  return boundary;
}

function cycleTimestamp(cycle, side) {
  const boundary = side === "end" ? cycle.endBoundary : cycle.startBoundary;
  if (boundary?.timestamp) return boundary.timestamp;
  const date = side === "end" ? cycle.endDate : cycle.startDate;
  return Date.parse(`${date}T${side === "end" ? "23:59:59" : "00:00:00"}Z`) / 1000;
}

function invalidateCycle(cycle) {
  return {
    ...cycle,
    totals: null,
    scannedAt: null,
    scanStale: true,
    imageCount: cycle.images?.length || 0,
    completeness: completenessFor(cycle),
  };
}

function repairSettlementCycles({ action, cycleKey, boundary }) {
  return serialized(() => {
    const cycles = normaliseCycles(loadSettlementCycles());
    const selected = cycles.find((cycle) => cycle.cycleKey === cycleKey);
    if (!selected) throw new Error("That cycle no longer exists. Refresh and try again.");
    const group = cycles
      .filter((cycle) => cycle.groupId === selected.groupId)
      .sort((a, b) => cycleTimestamp(a, "start") - cycleTimestamp(b, "start"));
    const position = group.indexOf(selected);
    const next = group[position + 1];

    if (action === "split") {
      const split = manualBoundary(boundary);
      if (
        split.timestamp <= cycleTimestamp(selected, "start") ||
        split.timestamp >= cycleTimestamp(selected, "end")
      ) throw new Error("The split boundary must fall inside the selected cycle.");
      const receiptLibrary = loadLibrary();
      const leftImages = [];
      const rightImages = [];
      for (const image of selected.images || []) {
        const timestamp = Date.parse(receiptLibrary[image.id]?.date || "") / 1000;
        (Number.isFinite(timestamp) && timestamp > split.timestamp
          ? rightImages
          : leftImages
        ).push(image);
      }
      const left = invalidateCycle({
        ...selected,
        endBoundary: split,
        endBoundaryId: split.id,
        endDate: split.dateStr,
        status: "SETTLED",
        images: leftImages,
      });
      const right = invalidateCycle({
        ...selected,
        cycleKey: cycleKeyFor(selected.groupId, split),
        detectedId: `manual_${crypto.randomUUID()}`,
        startBoundary: split,
        startBoundaryId: split.id,
        checkpoint: split,
        startDate: split.dateStr,
        images: rightImages,
      });
      cycles.splice(cycles.indexOf(selected), 1, left, right);
    } else if (action === "merge") {
      if (!next) throw new Error("There is no following cycle to merge.");
      const images = [...(selected.images || []), ...(next.images || [])].filter(
        (image, index, all) => all.findIndex((item) => item.id === image.id) === index,
      );
      const merged = invalidateCycle({
        ...selected,
        endBoundary: next.endBoundary,
        endBoundaryId: next.endBoundaryId,
        endDate: next.endDate,
        status: next.status,
        images,
        groceryCount:
          (Number(selected.groceryCount) || 0) + (Number(next.groceryCount) || 0),
        paymentCount:
          (Number(selected.paymentCount) || 0) + (Number(next.paymentCount) || 0),
      });
      cycles.splice(cycles.indexOf(selected), 1, merged);
      cycles.splice(cycles.indexOf(next), 1);
    } else if (action === "correct") {
      if (!next) throw new Error("The active cycle has no following boundary to correct.");
      const corrected = manualBoundary(boundary);
      selected.endBoundary = corrected;
      selected.endBoundaryId = corrected.id;
      selected.endDate = corrected.dateStr;
      Object.assign(selected, invalidateCycle(selected));
      next.startBoundary = corrected;
      next.startBoundaryId = corrected.id;
      next.checkpoint = corrected;
      next.startDate = corrected.dateStr;
      next.cycleKey = cycleKeyFor(next.groupId, corrected);
      Object.assign(next, invalidateCycle(next));
    } else {
      throw new Error("Unknown cycle repair action.");
    }

    const validated = validateCycles(cycles);
    saveSettlementCycles(validated);
    return validated;
  });
}

function clearLibrary() {
  saveLibrary({});
}

module.exports = {
  IMAGES_DIR,
  loadLibrary,
  saveLibrary,
  loadSettlementCycles,
  saveSettlementCycles,
  recordImage,
  findByContentHash,
  findById,
  recordSettlementCycle,
  upsertDetectedCycles,
  migrateSettlementCycles,
  repairSettlementCycles,
  clearLibrary,
  hashBuffer,
  imageFilePath,
};
