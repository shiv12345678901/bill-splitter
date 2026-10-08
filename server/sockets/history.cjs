const {
  loadReceiptCache,
  saveReceiptCache,
  loadSettlementHistory,
  saveSettlementHistory,
  MEDIA_CACHE_DIR,
} = require("../services/storage.cjs");
const library = require("../services/library.cjs");
const fs = require("node:fs");
const path = require("node:path");

function folderStats(dir) {
  let files = 0;
  let bytes = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) {
          files += 1;
          bytes += stat.size;
        }
      } catch (e) {}
    }
  }
  return { files, bytes };
}
module.exports = function registerHistory(socket, io) {
  const handle = (event, callback) =>
    socket.on(event, (...args) => {
      try {
        callback(...args);
      } catch (error) {
        socket.emit("history:error", {
          message: "Could not update local history: " + error.message,
        });
      }
    });
  // Past Settlement History Handlers
  handle("history:get", () => {
    const history = loadSettlementHistory();
    socket.emit("history:list", { history });
  });

  // Receipt library: every saved image with its scanned JSON data
  handle("library:get", () => {
    const images = Object.values(library.loadLibrary()).sort((a, b) =>
      (b.date || "").localeCompare(a.date || ""),
    );
    socket.emit("library:list", { images });
  });

  // Scanned settlement cycles: dates, image names and totals, saved locally
  handle("cycles:get", () => {
    socket.emit("cycles:list", { cycles: library.loadSettlementCycles() });
  });

  socket.on("cycles:repair", async (request = {}) => {
    try {
      const cycles = await library.repairSettlementCycles(request);
      io.emit("cycles:list", { cycles });
      socket.emit("cycles:repaired", { action: request.action });
    } catch (error) {
      socket.emit("cycles:repair_error", { message: error.message });
    }
  });

  // Local storage overview so the owner can inspect and clear data
  handle("data:stats", () => {
    const images = folderStats(MEDIA_CACHE_DIR);
    socket.emit("data:stats", {
      images,
      libraryRecords: Object.keys(library.loadLibrary()).length,
      cycles: library.loadSettlementCycles().length,
      ocrCache: Object.keys(loadReceiptCache()).length,
      history: loadSettlementHistory().length,
    });
  });

  handle("data:clear", ({ scopes } = {}) => {
    const cleared = [];
    const wanted = Array.isArray(scopes) ? scopes : [];
    for (const scope of wanted) {
      if (scope === "ocrCache") {
        saveReceiptCache({});
        cleared.push(scope);
      } else if (scope === "cycles") {
        library.saveSettlementCycles([]);
        cleared.push(scope);
      } else if (scope === "library") {
        library.clearLibrary();
        cleared.push(scope);
      } else if (scope === "images") {
        if (fs.existsSync(MEDIA_CACHE_DIR)) {
          for (const name of fs.readdirSync(MEDIA_CACHE_DIR)) {
            try {
              fs.unlinkSync(path.join(MEDIA_CACHE_DIR, name));
            } catch (e) {}
          }
        }
        cleared.push(scope);
      } else if (scope === "history") {
        saveSettlementHistory([]);
        cleared.push(scope);
      }
    }
    console.log("[Data] Cleared:", cleared.join(", ") || "nothing");
    socket.emit("data:cleared", { cleared });
    socket.emit("data:stats", {
      images: folderStats(MEDIA_CACHE_DIR),
      libraryRecords: Object.keys(library.loadLibrary()).length,
      cycles: library.loadSettlementCycles().length,
      ocrCache: Object.keys(loadReceiptCache()).length,
      history: loadSettlementHistory().length,
    });
    if (wanted.includes("cycles")) socket.emit("cycles:list", { cycles: [] });
    if (wanted.includes("library"))
      socket.emit("library:list", { images: [] });
    if (wanted.includes("history"))
      socket.emit("history:list", { history: [] });
  });

  handle("history:save", (record) => {
    if (!record || !Array.isArray(record.expenses))
      throw new Error("Invalid settlement record.");
    const history = loadSettlementHistory();
    const id = record.id || `settle_${Date.now()}`;
    const newRecord = {
      ...record,
      id,
      savedAt: record.savedAt || new Date().toISOString(),
    };
    // Prepend new record so newest is first
    const existingIndex = history.findIndex((h) => h.id === id);
    if (existingIndex >= 0) {
      history[existingIndex] = newRecord;
    } else {
      history.unshift(newRecord);
    }
    saveSettlementHistory(history);
    console.log(
      `[History] Saved settlement record "${newRecord.groupName || "Settlement"}" (${newRecord.id}) - Total: $${newRecord.totalPool}`,
    );
    io.emit("history:saved", { record: newRecord });
    io.emit("history:list", { history });
  });

  handle("history:delete", ({ id }) => {
    let history = loadSettlementHistory();
    history = history.filter((h) => h.id !== id);
    saveSettlementHistory(history);
    console.log(`[History] Deleted settlement archive ${id}`);
    io.emit("history:list", { history });
  });

  // Local OCR Cache Handlers
  handle("cache:clear", () => {
    saveReceiptCache({});
    console.log("[Cache] Local receipt OCR cache cleared.");
    io.emit("cache:cleared", { count: 0 });
  });

  handle("cache:get_stats", () => {
    const cache = loadReceiptCache();
    socket.emit("cache:stats", { count: Object.keys(cache).length });
  });
};
