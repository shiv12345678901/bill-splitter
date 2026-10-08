const fs = require("node:fs");
const path = require("node:path");
const database = require("./database.cjs");

const MEDIA_CACHE_DIR = path.join(database.DATA_DIR, "media_cache");
fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });

const loadReceiptCache = () => database.getOcrCache();
function saveReceiptCache(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("OCR cache must be an object.");
  database.replaceOcrCache(data);
}
function upsertReceiptCacheEntry(messageId, data) {
  if (!messageId) throw new Error("OCR cache message ID is required.");
  database.putOcrCache(messageId, data);
}

const loadSettlementHistory = () => database.getHistory();
function saveSettlementHistory(data) {
  if (!Array.isArray(data))
    throw new Error("Settlement history must be a list.");
  database.replaceHistory(data);
}
module.exports = {
  MEDIA_CACHE_DIR,
  loadReceiptCache,
  saveReceiptCache,
  upsertReceiptCacheEntry,
  loadSettlementHistory,
  saveSettlementHistory,
};
