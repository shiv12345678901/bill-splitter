const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR =
  process.env.SPLITMATE_DATA_DIR || path.join(__dirname, "../../data");
const DB_FILE = path.join(DATA_DIR, "splitmate.sqlite");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const LEGACY_BACKUP_DIR = path.join(DATA_DIR, "json-backup-pre-sqlite");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");

function transaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (current < 1) {
    transaction(() => {
      db.exec(`
        CREATE TABLE receipt_records (
          message_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL DEFAULT '',
          file_name TEXT NOT NULL DEFAULT '',
          file_id TEXT NOT NULL DEFAULT '',
          file_group_id TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
          content_hash TEXT,
          captured_at TEXT,
          payer TEXT NOT NULL DEFAULT '',
          merchant TEXT NOT NULL DEFAULT '',
          amount_cents INTEGER NOT NULL DEFAULT 0 CHECK(amount_cents >= 0),
          category TEXT NOT NULL DEFAULT 'Other',
          confidence TEXT NOT NULL DEFAULT 'LOW',
          is_bank_transfer INTEGER NOT NULL DEFAULT 0 CHECK(is_bank_transfer IN (0,1)),
          is_blurry INTEGER NOT NULL DEFAULT 0 CHECK(is_blurry IN (0,1)),
          scanned_at TEXT,
          status TEXT NOT NULL DEFAULT 'processed' CHECK(status IN ('queued','processed','failed','excluded','superseded','archived')),
          payload_json TEXT NOT NULL
        );
        CREATE INDEX receipt_content_hash_idx ON receipt_records(content_hash) WHERE content_hash IS NOT NULL;
        CREATE INDEX receipt_group_date_idx ON receipt_records(group_id, captured_at);

        CREATE TABLE cycles (
          cycle_key TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          group_name TEXT NOT NULL DEFAULT '',
          detected_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('ACTIVE','SETTLED','LEGACY_CONFLICT','UNKNOWN')),
          start_date TEXT,
          end_date TEXT,
          start_boundary_id TEXT,
          end_boundary_id TEXT,
          provenance_status TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK(provenance_status IN ('RESOLVED','UNRESOLVED')),
          expected_media INTEGER NOT NULL DEFAULT 0 CHECK(expected_media >= 0),
          processed_media INTEGER NOT NULL DEFAULT 0 CHECK(processed_media >= 0),
          failed_media INTEGER NOT NULL DEFAULT 0 CHECK(failed_media >= 0),
          excluded_media INTEGER NOT NULL DEFAULT 0 CHECK(excluded_media >= 0),
          detected_at TEXT,
          scanned_at TEXT,
          payload_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX cycle_start_boundary_unique
          ON cycles(group_id, start_boundary_id)
          WHERE start_boundary_id IS NOT NULL;
        CREATE INDEX cycle_group_dates_idx ON cycles(group_id, start_date, end_date);

        CREATE TABLE cycle_receipts (
          cycle_key TEXT NOT NULL REFERENCES cycles(cycle_key) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES receipt_records(message_id) ON DELETE RESTRICT,
          position INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(cycle_key, message_id)
        );

        CREATE TABLE ocr_cache (
          message_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'processed' CHECK(status IN ('processed','failed')),
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE settlement_history (
          settlement_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL DEFAULT '',
          start_date TEXT,
          end_date TEXT,
          closed_at TEXT,
          saved_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE scan_jobs (
          job_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL DEFAULT '',
          cycle_key TEXT REFERENCES cycles(cycle_key) ON DELETE SET NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','partial','failed','cancelled','complete')),
          expected_images INTEGER NOT NULL DEFAULT 0 CHECK(expected_images >= 0),
          processed_images INTEGER NOT NULL DEFAULT 0 CHECK(processed_images >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE scan_outcomes (
          job_id TEXT NOT NULL REFERENCES scan_jobs(job_id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','processed','failed','excluded','skipped')),
          error_code TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(job_id, message_id)
        );
      `);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES(1, ?, ?)")
        .run("initial transactional storage", new Date().toISOString());
    });
  }
}

const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};
const readJsonFile = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw ? JSON.parse(raw) : fallback;
};
const cents = (amount) => Math.max(0, Math.round((Number(amount) || 0) * 100));

migrateSchema();

const receiptUpsert = db.prepare(`
  INSERT INTO receipt_records(
    message_id, group_id, file_name, file_id, file_group_id, mime_type,
    content_hash, captured_at, payer, merchant, amount_cents, category,
    confidence, is_bank_transfer, is_blurry, scanned_at, status, payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(message_id) DO UPDATE SET
    group_id=excluded.group_id, file_name=excluded.file_name,
    file_id=excluded.file_id, file_group_id=excluded.file_group_id,
    mime_type=excluded.mime_type, content_hash=excluded.content_hash,
    captured_at=excluded.captured_at, payer=excluded.payer,
    merchant=excluded.merchant, amount_cents=excluded.amount_cents,
    category=excluded.category, confidence=excluded.confidence,
    is_bank_transfer=excluded.is_bank_transfer, is_blurry=excluded.is_blurry,
    scanned_at=excluded.scanned_at, status=excluded.status,
    payload_json=excluded.payload_json
`);

function putReceipt(record) {
  const payload = { ...record, cycles: Array.isArray(record.cycles) ? record.cycles : [] };
  receiptUpsert.run(
    record.id,
    record.groupId || "",
    record.fileName || "",
    record.fileId || record.id,
    record.fileGroupId || record.groupId || "",
    record.mimetype || "image/jpeg",
    record.contentHash || null,
    record.date || null,
    record.paidBy || "",
    record.merchant || "",
    cents(record.amount),
    record.category || "Other",
    record.confidence || "LOW",
    record.isBankTransfer ? 1 : 0,
    record.isBlurry ? 1 : 0,
    record.scannedAt || null,
    record.status || (record.isExcluded ? "excluded" : "processed"),
    JSON.stringify(payload),
  );
}

function getReceipts() {
  const result = {};
  for (const row of db.prepare("SELECT payload_json FROM receipt_records ORDER BY captured_at").all()) {
    const record = parseJson(row.payload_json, null);
    if (record?.id) result[record.id] = record;
  }
  return result;
}

function getReceipt(id) {
  const row = db.prepare("SELECT payload_json FROM receipt_records WHERE message_id = ?").get(id);
  return row ? parseJson(row.payload_json, null) : null;
}

function findReceiptByHash(hash) {
  if (!hash) return null;
  const row = db.prepare("SELECT payload_json FROM receipt_records WHERE content_hash = ? LIMIT 1").get(hash);
  return row ? parseJson(row.payload_json, null) : null;
}

function rebuildCycleLinks() {
  db.exec("DELETE FROM cycle_receipts");
  const receiptExists = db.prepare("SELECT 1 FROM receipt_records WHERE message_id = ?");
  const link = db.prepare("INSERT OR IGNORE INTO cycle_receipts(cycle_key, message_id, position) VALUES(?,?,?)");
  for (const row of db.prepare("SELECT cycle_key, payload_json FROM cycles").all()) {
    const cycle = parseJson(row.payload_json, {});
    (cycle.images || []).forEach((image, index) => {
      if (image?.id && receiptExists.get(image.id)) link.run(row.cycle_key, image.id, index);
    });
  }
}

function replaceReceipts(records) {
  transaction(() => {
    db.exec("DELETE FROM cycle_receipts; DELETE FROM receipt_records;");
    for (const record of Object.values(records || {})) if (record?.id) putReceipt(record);
    rebuildCycleLinks();
  });
}

const cycleUpsert = db.prepare(`
  INSERT INTO cycles(
    cycle_key, group_id, group_name, detected_id, status, start_date, end_date,
    start_boundary_id, end_boundary_id, provenance_status, expected_media,
    processed_media, failed_media, excluded_media, detected_at, scanned_at,
    payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(cycle_key) DO UPDATE SET
    group_id=excluded.group_id, group_name=excluded.group_name,
    detected_id=excluded.detected_id, status=excluded.status,
    start_date=excluded.start_date, end_date=excluded.end_date,
    start_boundary_id=excluded.start_boundary_id,
    end_boundary_id=excluded.end_boundary_id,
    provenance_status=excluded.provenance_status,
    expected_media=excluded.expected_media,
    processed_media=excluded.processed_media, failed_media=excluded.failed_media,
    excluded_media=excluded.excluded_media, detected_at=excluded.detected_at,
    scanned_at=excluded.scanned_at, payload_json=excluded.payload_json
`);

function putCycle(cycle) {
  const completeness = cycle.completeness || {};
  cycleUpsert.run(
    cycle.cycleKey,
    cycle.groupId,
    cycle.groupName || "",
    cycle.detectedId || null,
    ["ACTIVE", "SETTLED", "LEGACY_CONFLICT"].includes(cycle.status)
      ? cycle.status
      : "UNKNOWN",
    cycle.startDate || null,
    cycle.endDate || null,
    cycle.startBoundaryId || null,
    cycle.endBoundaryId || null,
    cycle.provenance?.status === "RESOLVED" ? "RESOLVED" : "UNRESOLVED",
    Number(completeness.expected) || 0,
    Number(completeness.processed) || 0,
    Number(completeness.failed) || 0,
    Number(completeness.excluded) || 0,
    cycle.detectedAt || null,
    cycle.scannedAt || null,
    JSON.stringify(cycle),
  );
}

function getCycles() {
  return db
    .prepare("SELECT payload_json FROM cycles ORDER BY COALESCE(start_date, '')")
    .all()
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean);
}

function replaceCycles(cycles) {
  transaction(() => {
    db.exec("DELETE FROM cycle_receipts; DELETE FROM cycles;");
    for (const cycle of cycles || []) if (cycle?.cycleKey) putCycle(cycle);
    rebuildCycleLinks();
  });
}

function getOcrCache() {
  const result = {};
  for (const row of db.prepare("SELECT message_id, payload_json FROM ocr_cache").all())
    result[row.message_id] = parseJson(row.payload_json, {});
  return result;
}

const cacheUpsert = db.prepare(`
  INSERT INTO ocr_cache(message_id, status, updated_at, payload_json)
  VALUES(?,?,?,?)
  ON CONFLICT(message_id) DO UPDATE SET
    status=excluded.status, updated_at=excluded.updated_at,
    payload_json=excluded.payload_json
`);
function putOcrCache(messageId, payload) {
  cacheUpsert.run(
    messageId,
    payload?.error ? "failed" : "processed",
    payload?.cachedAt || new Date().toISOString(),
    JSON.stringify(payload || {}),
  );
}
function replaceOcrCache(cache) {
  transaction(() => {
    db.exec("DELETE FROM ocr_cache");
    for (const [id, payload] of Object.entries(cache || {})) putOcrCache(id, payload);
  });
}

function getHistory() {
  return db
    .prepare("SELECT payload_json FROM settlement_history ORDER BY saved_at DESC")
    .all()
    .map((row) => parseJson(row.payload_json, null))
    .filter(Boolean);
}
const historyUpsert = db.prepare(`
  INSERT INTO settlement_history(
    settlement_id, group_id, start_date, end_date, closed_at, saved_at, payload_json
  ) VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(settlement_id) DO UPDATE SET
    group_id=excluded.group_id, start_date=excluded.start_date,
    end_date=excluded.end_date, closed_at=excluded.closed_at,
    saved_at=excluded.saved_at, payload_json=excluded.payload_json
`);
function putHistory(record) {
  historyUpsert.run(
    record.id,
    record.groupId || "",
    record.startDate || null,
    record.endDate || null,
    record.closedAt || null,
    record.savedAt || new Date().toISOString(),
    JSON.stringify(record),
  );
}
function replaceHistory(history) {
  transaction(() => {
    db.exec("DELETE FROM settlement_history");
    for (const record of history || []) if (record?.id) putHistory(record);
  });
}

const SCAN_JOB_STATUSES = new Set([
  "queued",
  "running",
  "partial",
  "failed",
  "cancelled",
  "complete",
]);
const SCAN_OUTCOME_STATUSES = new Set([
  "queued",
  "processed",
  "failed",
  "excluded",
  "skipped",
]);

const scanJobInsert = db.prepare(`
  INSERT INTO scan_jobs(
    job_id, group_id, cycle_key, status, expected_images, processed_images,
    created_at, updated_at, payload_json
  ) VALUES(?,?,?,?,?,?,?,?,?)
`);
const scanJobUpdate = db.prepare(`
  UPDATE scan_jobs SET
    group_id=?, cycle_key=?, status=?, expected_images=?, processed_images=?,
    updated_at=?, payload_json=?
  WHERE job_id=?
`);
const scanOutcomeUpsert = db.prepare(`
  INSERT INTO scan_outcomes(job_id, message_id, status, error_code, payload_json)
  VALUES(?,?,?,?,?)
  ON CONFLICT(job_id, message_id) DO UPDATE SET
    status=excluded.status, error_code=excluded.error_code,
    payload_json=excluded.payload_json
`);

function scanJobFromRow(row) {
  if (!row) return null;
  return {
    ...parseJson(row.payload_json, {}),
    jobId: row.job_id,
    groupId: row.group_id,
    cycleKey: row.cycle_key,
    status: row.status,
    expectedImages: row.expected_images,
    completedImages: row.processed_images,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createScanJob(job) {
  if (!job?.jobId) throw new Error("A scan job id is required.");
  const status = job.status || "queued";
  if (!SCAN_JOB_STATUSES.has(status)) throw new Error("Invalid scan job status.");
  const now = new Date().toISOString();
  const payload = { ...job };
  scanJobInsert.run(
    job.jobId,
    job.groupId || "",
    job.cycleKey || null,
    status,
    Number(job.expectedImages) || 0,
    Number(job.completedImages) || 0,
    job.createdAt || now,
    job.updatedAt || now,
    JSON.stringify(payload),
  );
  return getScanJob(job.jobId);
}

function getScanJob(jobId) {
  return scanJobFromRow(
    db.prepare("SELECT * FROM scan_jobs WHERE job_id = ?").get(jobId),
  );
}

function listScanJobs({ statuses, limit = 20 } = {}) {
  const allowed = Array.isArray(statuses)
    ? statuses.filter((status) => SCAN_JOB_STATUSES.has(status))
    : [];
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const rows = allowed.length
    ? db
        .prepare(
          `SELECT * FROM scan_jobs WHERE status IN (${allowed.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(...allowed, safeLimit)
    : db
        .prepare("SELECT * FROM scan_jobs ORDER BY updated_at DESC LIMIT ?")
        .all(safeLimit);
  return rows.map(scanJobFromRow);
}

function updateScanJob(jobId, changes = {}) {
  const current = getScanJob(jobId);
  if (!current) throw new Error(`Unknown scan job: ${jobId}`);
  const next = { ...current, ...changes, jobId };
  if (!SCAN_JOB_STATUSES.has(next.status)) throw new Error("Invalid scan job status.");
  next.updatedAt = changes.updatedAt || new Date().toISOString();
  scanJobUpdate.run(
    next.groupId || "",
    next.cycleKey || null,
    next.status,
    Number(next.expectedImages) || 0,
    Number(next.completedImages) || 0,
    next.updatedAt,
    JSON.stringify(next),
    jobId,
  );
  return getScanJob(jobId);
}

function getScanOutcomes(jobId) {
  return db
    .prepare(
      "SELECT message_id, status, error_code, payload_json FROM scan_outcomes WHERE job_id = ? ORDER BY rowid",
    )
    .all(jobId)
    .map((row) => ({
      ...parseJson(row.payload_json, {}),
      messageId: row.message_id,
      status: row.status,
      errorCode: row.error_code,
    }));
}

function recordScanOutcome(jobId, outcome) {
  if (!getScanJob(jobId)) throw new Error(`Unknown scan job: ${jobId}`);
  if (!outcome?.messageId) throw new Error("A scan outcome message id is required.");
  if (!SCAN_OUTCOME_STATUSES.has(outcome.status))
    throw new Error("Invalid scan outcome status.");
  return transaction(() => {
    scanOutcomeUpsert.run(
      jobId,
      outcome.messageId,
      outcome.status,
      outcome.errorCode || null,
      JSON.stringify(outcome),
    );
    const completed = db
      .prepare(
        "SELECT COUNT(*) AS count FROM scan_outcomes WHERE job_id = ? AND status <> 'queued'",
      )
      .get(jobId).count;
    const current = getScanJob(jobId);
    scanJobUpdate.run(
      current.groupId || "",
      current.cycleKey || null,
      current.status,
      current.expectedImages,
      completed,
      new Date().toISOString(),
      JSON.stringify({ ...current, completedImages: completed }),
      jobId,
    );
    return outcome;
  });
}

function backupLegacyJson() {
  const files = [
    "receipt_library.json",
    "settlement_cycles.json",
    "receipts_cache.json",
    "settlement_history.json",
  ];
  fs.mkdirSync(LEGACY_BACKUP_DIR, { recursive: true });
  for (const name of files) {
    const source = path.join(DATA_DIR, name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(LEGACY_BACKUP_DIR, name);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    JSON.parse(fs.readFileSync(target, "utf8"));
  }
}

function importLegacyJsonOnce() {
  const count = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM receipt_records) +
      (SELECT COUNT(*) FROM cycles) +
      (SELECT COUNT(*) FROM ocr_cache) +
      (SELECT COUNT(*) FROM settlement_history) AS total
  `).get().total;
  if (count > 0) return false;
  const files = {
    receipts: path.join(DATA_DIR, "receipt_library.json"),
    cycles: path.join(DATA_DIR, "settlement_cycles.json"),
    cache: path.join(DATA_DIR, "receipts_cache.json"),
    history: path.join(DATA_DIR, "settlement_history.json"),
  };
  if (!Object.values(files).some((file) => fs.existsSync(file))) return false;
  const legacy = {
    receipts: readJsonFile(files.receipts, {}),
    cycles: readJsonFile(files.cycles, []),
    cache: readJsonFile(files.cache, {}),
    history: readJsonFile(files.history, []),
  };
  if (!Array.isArray(legacy.cycles) || !Array.isArray(legacy.history))
    throw new Error("Legacy cycle or history JSON has an invalid shape.");
  backupLegacyJson();
  transaction(() => {
    for (const receipt of Object.values(legacy.receipts)) if (receipt?.id) putReceipt(receipt);
    for (const cycle of legacy.cycles) if (cycle?.cycleKey) putCycle(cycle);
    rebuildCycleLinks();
    for (const [id, payload] of Object.entries(legacy.cache)) putOcrCache(id, payload);
    for (const record of legacy.history) if (record?.id) putHistory(record);
  });
  const imported = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM receipt_records) AS receipts,
      (SELECT COUNT(*) FROM cycles) AS cycles,
      (SELECT COUNT(*) FROM ocr_cache) AS cache,
      (SELECT COUNT(*) FROM settlement_history) AS history
  `).get();
  if (
    imported.receipts !== Object.keys(legacy.receipts).length ||
    imported.cycles !== legacy.cycles.length ||
    imported.cache !== Object.keys(legacy.cache).length ||
    imported.history !== legacy.history.length
  ) throw new Error("SQLite migration count verification failed.");
  return true;
}

function assertIntegrity(target = db) {
  const result = target.prepare("PRAGMA integrity_check").get();
  if (!result || Object.values(result)[0] !== "ok")
    throw new Error("SQLite integrity check failed.");
  const foreignKeys = target.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) throw new Error("SQLite foreign-key check failed.");
  return true;
}

function createVerifiedBackup({ force = false } = {}) {
  const existing = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => /^splitmate-\d{4}-\d{2}-\d{2}.*\.sqlite$/.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!force && existing[0] && Date.now() - existing[0].time < 24 * 60 * 60 * 1000)
    return path.join(BACKUP_DIR, existing[0].name);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUP_DIR, `splitmate-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    assertIntegrity(copy);
  } finally {
    copy.close();
  }
  for (const old of existing.slice(4)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
  return target;
}

function counts() {
  return db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM receipt_records) AS receipts,
      (SELECT COUNT(*) FROM cycles) AS cycles,
      (SELECT COUNT(*) FROM ocr_cache) AS cache,
      (SELECT COUNT(*) FROM settlement_history) AS history,
      (SELECT COUNT(*) FROM scan_jobs) AS scanJobs
  `).get();
}

const importedLegacy = importLegacyJsonOnce();
assertIntegrity();
const latestBackup = createVerifiedBackup({ force: importedLegacy });

module.exports = {
  DATA_DIR,
  DB_FILE,
  db,
  transaction,
  assertIntegrity,
  createVerifiedBackup,
  counts,
  getReceipts,
  getReceipt,
  findReceiptByHash,
  putReceipt,
  replaceReceipts,
  getCycles,
  replaceCycles,
  getOcrCache,
  putOcrCache,
  replaceOcrCache,
  getHistory,
  replaceHistory,
  createScanJob,
  getScanJob,
  listScanJobs,
  updateScanJob,
  getScanOutcomes,
  recordScanOutcome,
  latestBackup,
};
