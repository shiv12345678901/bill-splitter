const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.SPLITMATE_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "splitmate-tests-"),
);
const storage = require("../server/services/storage.cjs");
const registerHistory = require("../server/sockets/history.cjs");
const registerScan = require("../server/sockets/scan.cjs");
const { cleanAndParseJson } = require("../server/services/ocr.cjs");
const processReceipts = require("../server/services/receipt-workers.cjs");
const { loadChatHistory } = require("../server/services/message-discovery.cjs");
const library = require("../server/services/library.cjs");
const { parseApiKeys } = require("../server/services/api-keys.cjs");

test("API key parser accepts numbered env-file lines", () => {
  assert.deepEqual(
    parseApiKeys(`
# Gemini rotation keys
GEMINI_API_KEY_1=fake-key-one
GEMINI_API_KEY_2="fake-key-two"
export GEMINI_API_KEY3='fake-key-three'
OTHER_SECRET=ignored-value
`),
    ["fake-key-one", "fake-key-two", "fake-key-three"],
  );
});

test("API key parser accepts plain lists and removes duplicates", () => {
  assert.deepEqual(
    parseApiKeys(["fake-key-one, fake-key-two", "fake-key-one"]),
    ["fake-key-one", "fake-key-two"],
  );
  assert.deepEqual(
    parseApiKeys("GEMINI_API_KEYS=fake-key-one;fake-key-two"),
    ["fake-key-one", "fake-key-two"],
  );
});

function historyClient({ stalled = false } = {}) {
  let loads = 0;
  const messages = [{ t: 500 }, { t: 450 }, { t: 400 }];
  const chat = { msgs: { getModelsArray: () => [...messages] } };
  const window = {
    require: (name) => {
      if (name === "WAWebCollections") return { Chat: { get: () => chat } };
      if (name === "WAWebChatLoadMessages")
        return {
          loadEarlierMsgs: async () => {
            loads++;
            if (stalled) return undefined;
            const added = { t: 400 - loads * 100 };
            messages.unshift(added);
            return [added];
          },
        };
      return {};
    },
  };
  return {
    loads: () => loads,
    pupPage: {
      evaluate: (fn, ...args) =>
        require("node:vm").runInNewContext(`(${fn.toString()})(...args)`, {
          window,
          args,
          setTimeout,
        }),
    },
  };
}
test("sync loads back to settlement date even when message count limit is reached", async () => {
  const client = historyClient();
  await loadChatHistory(client, "group", 2, 100);
  assert.equal(client.loads(), 3);
});
test("sync surfaces stalled loading instead of declaring an incomplete scan successful", async () => {
  await assert.rejects(
    loadChatHistory(historyClient({ stalled: true }), "group", 2, 100),
    /stopped loading/,
  );
});
function socket() {
  return {
    handlers: {},
    sent: [],
    on(event, fn) {
      this.handlers[event] = fn;
    },
    emit(event, data) {
      this.sent.push({ event, data });
    },
  };
}
test("history retries update one record and persistence preserves payment confirmations", () => {
  const s = socket();
  registerHistory(s, s);
  const record = {
    id: "stable-id",
    expenses: [],
    payments: { transfer: "2026-09-10" },
    closedAt: "2026-09-10",
  };
  s.handlers["history:save"](record);
  s.handlers["history:save"]({ ...record, totalPool: 20 });
  const history = storage.loadSettlementHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].totalPool, 20);
  assert.equal(history[0].payments.transfer, "2026-09-10");
  const { execFileSync } = require("node:child_process");
  const reloaded = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(JSON.stringify(require(${JSON.stringify(require.resolve("../server/services/storage.cjs"))}).loadSettlementHistory()))`,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(
    reloaded,
    history,
    "A fresh process reads the same JSON database",
  );
});
test("invalid history replacement is rejected without changing durable rows", () => {
  const before = storage.loadSettlementHistory();
  assert.throws(
    () => storage.saveSettlementHistory({ broken: true }),
    /must be a list/,
  );
  assert.deepEqual(storage.loadSettlementHistory(), before);
  assert.equal(require("../server/services/database.cjs").assertIntegrity(), true);
});

test("parallel OCR cache entries cannot overwrite one another", async () => {
  const { upsertReceiptCacheEntry, loadReceiptCache } = storage;
  await Promise.all([
    Promise.resolve().then(() =>
      upsertReceiptCacheEntry("cache-a", { merchant: "A", amount: 1 }),
    ),
    Promise.resolve().then(() =>
      upsertReceiptCacheEntry("cache-b", { merchant: "B", amount: 2 }),
    ),
  ]);
  const cache = loadReceiptCache();
  assert.equal(cache["cache-a"].merchant, "A");
  assert.equal(cache["cache-b"].merchant, "B");
});

test("SQLite enforces unique cycle boundaries and rolls back the failed write", () => {
  const before = library.loadSettlementCycles();
  const groupId = "unique-cycle-group";
  const boundary = { id: "one-start", dateStr: "2026-01-01", timestamp: 1 };
  assert.throws(
    () =>
      library.saveSettlementCycles([
        {
          cycleKey: `${groupId}|one`,
          groupId,
          status: "ACTIVE",
          startBoundary: boundary,
          startBoundaryId: boundary.id,
        },
        {
          cycleKey: `${groupId}|two`,
          groupId,
          status: "ACTIVE",
          startBoundary: boundary,
          startBoundaryId: boundary.id,
        },
      ]),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(library.loadSettlementCycles(), before);
});

test("database backup is created and verified", () => {
  const database = require("../server/services/database.cjs");
  const backup = database.createVerifiedBackup({ force: true });
  assert.equal(fs.existsSync(backup), true);
  assert.ok(fs.statSync(backup).size > 0);
});
test("scan jobs and per-image outcomes are durable", () => {
  const database = require("../server/services/database.cjs");
  const jobId = `durable-${Date.now()}`;
  database.createScanJob({
    jobId,
    groupId: "group",
    status: "queued",
    expectedImages: 2,
    candidates: [{ id: "image-a" }, { id: "image-b" }],
    request: { startDate: "2026-09-01", endDate: "2026-09-02" },
  });
  database.recordScanOutcome(jobId, {
    messageId: "image-a",
    status: "processed",
    receipt: { id: "image-a", amount: 4 },
  });
  database.recordScanOutcome(jobId, {
    messageId: "image-b",
    status: "failed",
    errorCode: "quota",
  });
  const saved = database.updateScanJob(jobId, {
    status: "partial",
    finishedAt: new Date().toISOString(),
  });
  assert.equal(saved.completedImages, 2);
  assert.equal(database.getScanOutcomes(jobId)[1].errorCode, "quota");
  assert.ok(
    database
      .listScanJobs({ statuses: ["partial"] })
      .some((job) => job.jobId === jobId),
  );
});
test("OCR retries quota failures with backoff and records the final outcome", async () => {
  const s = socket();
  const outcomes = [];
  let calls = 0;
  const id = `retry-${Date.now()}`;
  const expenses = await processReceipts({
    client: { getContactById: async () => ({ name: "Alex" }) },
    groupId: "retry-group",
    candidateMessages: [{ id, timestamp: 1700000000, author: "alex" }],
    activeKeys: ["fixture-a", "fixture-b"],
    concurrency: 1,
    effectiveAliases: {},
    filterMember: "all",
    socket: s,
    isAborted: () => false,
    retryBaseMs: 0,
    downloadMediaBuffer: async () => ({
      data: Buffer.from(id).toString("base64"),
      mimetype: "image/jpeg",
    }),
    parseReceiptWithGemini: async () => {
      calls++;
      if (calls < 3) throw new Error("429 quota exhausted");
      return {
        merchant: "Retry Market",
        amount: 12,
        category: "Groceries",
        confidence: "HIGH",
      };
    },
    onOutcome: async (outcome) => outcomes.push(outcome),
  });
  assert.equal(calls, 3);
  assert.equal(expenses[0].merchant, "Retry Market");
  assert.equal(outcomes[0].status, "processed");
  assert.equal(outcomes[0].apiCalls, 3);
  assert.equal(processReceipts.classifyScanError(new Error("429 quota")), "quota");
});
test("scan reports missing WhatsApp with matching request id", async () => {
  const s = socket();
  registerScan(s, () => ({ client: null, clientStatus: "DISCONNECTED" }), {});
  await s.handlers["scan:start"]({ runId: "one" });
  assert.equal(s.sent[0].event, "scan:error");
  assert.equal(s.sent[0].data.runId, "one");
});
test("empty scan finishes through extracted services without external calls", async () => {
  const s = socket();
  registerScan(
    s,
    () => ({ client: {}, clientStatus: "READY", geminiApiKeys: ["test-key"] }),
    {},
  );
  await s.handlers["scan:start"]({
    runId: "two",
    startDate: "2026-09-01",
    endDate: "2026-09-10",
  });
  const done = s.sent.find((e) => e.event === "scan:complete");
  assert.ok(done);
  assert.deepEqual(done.data.expenses, []);
  assert.equal(done.data.runId, "two");
});
test("retry failed images only leaves successful outcomes untouched", async () => {
  const database = require("../server/services/database.cjs");
  const jobId = `retry-job-${Date.now()}`;
  const firstId = `${jobId}-ok`;
  const failedId = `${jobId}-failed`;
  database.createScanJob({
    jobId,
    groupId: "retry-only-group",
    status: "partial",
    expectedImages: 2,
    startedAt: new Date().toISOString(),
    request: { startDate: "2026-09-01", endDate: "2026-09-02", aliases: {} },
    candidates: [
      { id: firstId, timestamp: 1700000000, author: "alex" },
      { id: failedId, timestamp: 1700000001, author: "alex" },
    ],
  });
  database.recordScanOutcome(jobId, {
    messageId: firstId,
    status: "processed",
    receipt: { id: firstId, date: "2026-09-01", paidBy: "Alex", merchant: "Kept", amount: 5 },
  });
  database.recordScanOutcome(jobId, {
    messageId: failedId,
    status: "failed",
    errorCode: "timeout",
  });
  const downloaded = [];
  const s = socket();
  const manager = registerScan.createScanManager(
    s,
    () => ({ client: { getContactById: async () => ({ name: "Alex" }) }, clientStatus: "READY", geminiApiKeys: ["key"] }),
    {
      downloadMediaBuffer: async (_client, id) => {
        downloaded.push(id);
        return { data: Buffer.from(id).toString("base64"), mimetype: "image/jpeg" };
      },
      parseReceiptWithGemini: async () => ({
        merchant: "Recovered",
        amount: 7,
        category: "Groceries",
        confidence: "HIGH",
      }),
    },
  );
  await manager.run(jobId, { retryFailedOnly: true });
  assert.deepEqual(downloaded, [failedId]);
  assert.equal(database.getScanJob(jobId).status, "complete");
  assert.equal(
    database.getScanOutcomes(jobId).find((outcome) => outcome.messageId === firstId).receipt.merchant,
    "Kept",
  );
});
test("cancelling a running job keeps completed work and marks untouched images skipped", async () => {
  const database = require("../server/services/database.cjs");
  const jobId = `cancel-job-${Date.now()}`;
  const candidates = [1, 2].map((number) => ({
    id: `${jobId}-${number}`,
    timestamp: 1700000000 + number,
    author: "alex",
  }));
  database.createScanJob({
    jobId,
    groupId: "cancel-group",
    status: "queued",
    expectedImages: 2,
    request: { startDate: "2026-09-01", endDate: "2026-09-02", aliases: {} },
    candidates,
  });
  for (const candidate of candidates)
    database.recordScanOutcome(jobId, { messageId: candidate.id, status: "queued" });
  let releaseOcr;
  let signalOcr;
  const ocrStarted = new Promise((resolve) => (signalOcr = resolve));
  const s = socket();
  const manager = registerScan.createScanManager(
    s,
    () => ({ client: { getContactById: async () => ({ name: "Alex" }) }, clientStatus: "READY", geminiApiKeys: ["key"] }),
    {
      downloadMediaBuffer: async (_client, id) => ({
        data: Buffer.from(id).toString("base64"),
        mimetype: "image/jpeg",
      }),
      parseReceiptWithGemini: async () => {
        signalOcr();
        await new Promise((resolve) => (releaseOcr = resolve));
        return { merchant: "First", amount: 3, category: "Groceries", confidence: "HIGH" };
      },
    },
  );
  const running = manager.run(jobId);
  await ocrStarted;
  manager.cancel(jobId);
  releaseOcr();
  await running;
  const saved = database.getScanJob(jobId);
  const outcomes = database.getScanOutcomes(jobId);
  assert.equal(saved.status, "cancelled");
  assert.equal(outcomes[0].status, "processed");
  assert.equal(outcomes[1].status, "skipped");
  assert.equal(outcomes[1].reason, "Cancelled before processing");
});
test("a running durable job resumes from its queued outcomes", async () => {
  const database = require("../server/services/database.cjs");
  const jobId = `resume-job-${Date.now()}`;
  const messageId = `${jobId}-image`;
  database.createScanJob({
    jobId,
    groupId: "resume-group",
    status: "running",
    expectedImages: 1,
    startedAt: new Date().toISOString(),
    request: { startDate: "2026-09-01", endDate: "2026-09-02", aliases: {} },
    candidates: [{ id: messageId, timestamp: 1700000000, author: "alex" }],
  });
  database.recordScanOutcome(jobId, { messageId, status: "queued" });
  const manager = registerScan.createScanManager(
    socket(),
    () => ({ client: { getContactById: async () => ({ name: "Alex" }) }, clientStatus: "READY", geminiApiKeys: ["key"] }),
    {
      downloadMediaBuffer: async () => ({
        data: Buffer.from(messageId).toString("base64"),
        mimetype: "image/jpeg",
      }),
      parseReceiptWithGemini: async () => ({
        merchant: "Resumed",
        amount: 9,
        category: "Groceries",
        confidence: "HIGH",
      }),
    },
  );
  await manager.resumePending();
  assert.equal(database.getScanJob(jobId).status, "complete");
  assert.equal(database.getScanOutcomes(jobId)[0].receipt.merchant, "Resumed");
});
test("a reconciled partial job does not restart automatically", async () => {
  const database = require("../server/services/database.cjs");
  const jobId = `finished-partial-${Date.now()}`;
  database.createScanJob({
    jobId,
    groupId: "partial-group",
    status: "partial",
    expectedImages: 1,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    request: { startDate: "2026-09-01", endDate: "2026-09-02", aliases: {} },
    candidates: [{ id: `${jobId}-image`, timestamp: 1700000000, author: "alex" }],
  });
  database.recordScanOutcome(jobId, {
    messageId: `${jobId}-image`,
    status: "failed",
    errorCode: "quota",
  });
  let apiCalls = 0;
  const manager = registerScan.createScanManager(
    socket(),
    () => ({ client: {}, clientStatus: "READY", geminiApiKeys: ["key"] }),
    {
      downloadMediaBuffer: async () => {
        apiCalls++;
        return null;
      },
      parseReceiptWithGemini: async () => null,
    },
  );
  await manager.resumePending();
  assert.equal(apiCalls, 0);
  assert.equal(database.getScanJob(jobId).status, "partial");
});
test("OCR parsing excludes bank transfers and marks unreadable totals", () => {
  assert.equal(
    cleanAndParseJson('{"amount":100,"isBankTransfer":true}').amount,
    0,
  );
  assert.equal(
    cleanAndParseJson('```json\n{"amount":0}\n```').confidence,
    "LOW",
  );
});
test("a failed image download remains visible for review instead of disappearing", async () => {
  const s = socket();
  const expenses = await processReceipts({
    client: { getContactById: async () => ({ name: "Alex" }) },
    groupId: "test",
    candidateMessages: [
      { id: "failed-image", timestamp: 1700000000, author: "alex" },
    ],
    activeKeys: ["fixture"],
    concurrency: 1,
    effectiveAliases: {},
    filterMember: "all",
    socket: s,
    isAborted: () => false,
    downloadMediaBuffer: async () => null,
    parseReceiptWithGemini: async () => {
      throw new Error("Must not run");
    },
  });
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].needsReview, true);
  assert.equal(expenses[0].amount, 0);
  assert.equal(
    s.sent.filter((e) => e.event === "scan:receipt_found").length,
    1,
  );
});

test("a stalled OCR request times out and remains visible for review", async () => {
  const previousTimeout = process.env.SPLITMATE_OCR_TIMEOUT_MS;
  process.env.SPLITMATE_OCR_TIMEOUT_MS = "10";
  try {
    const s = socket();
    const expenses = await processReceipts({
      client: { getContactById: async () => ({ name: "Alex" }) },
      groupId: "test",
      candidateMessages: [
        { id: "stalled-ocr", timestamp: 1700000000, author: "alex" },
      ],
      activeKeys: ["fixture"],
      concurrency: 1,
      effectiveAliases: {},
      filterMember: "all",
      socket: s,
      isAborted: () => false,
      downloadMediaBuffer: async () => ({
        data: Buffer.from("image").toString("base64"),
        mimetype: "image/jpeg",
      }),
      parseReceiptWithGemini: async () => new Promise(() => {}),
    });
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].merchant, "Receipt could not be read");
    assert.equal(expenses[0].needsReview, true);
  } finally {
    if (previousTimeout === undefined)
      delete process.env.SPLITMATE_OCR_TIMEOUT_MS;
    else process.env.SPLITMATE_OCR_TIMEOUT_MS = previousTimeout;
  }
});
test("cancelling aborts the active recognition request", async () => {
  let cancelled = false;
  let requestAborted = false;
  const outcomes = [];
  setTimeout(() => {
    cancelled = true;
  }, 20);
  await processReceipts({
    client: { getContactById: async () => ({ name: "Alex" }) },
    groupId: "cancel-request",
    candidateMessages: [
      { id: `abort-${Date.now()}`, timestamp: 1700000000, author: "alex" },
    ],
    activeKeys: ["fixture"],
    concurrency: 1,
    effectiveAliases: {},
    filterMember: "all",
    socket: socket(),
    isAborted: () => cancelled,
    retryBaseMs: 0,
    downloadMediaBuffer: async () => ({
      data: Buffer.from("abort-image").toString("base64"),
      mimetype: "image/jpeg",
    }),
    parseReceiptWithGemini: async (_data, _mime, _key, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          requestAborted = true;
          reject(new Error("aborted"));
        });
      }),
    onOutcome: async (outcome) => outcomes.push(outcome),
  });
  assert.equal(requestAborted, true);
  assert.equal(outcomes[0].status, "skipped");
  assert.equal(outcomes[0].errorCode, "cancelled");
});

test("rescanning one cycle updates its record instead of creating another", async () => {
  const groupId = "cycle-dedupe-group";
  await library.upsertDetectedCycles(groupId, "Test household", [
    {
      id: "cycle_current",
      status: "ACTIVE",
      startDate: "2026-09-20",
      endDate: "2026-10-07",
      startCheckpoint: {
        id: "marker",
        text: "Clear up to date",
        dateStr: "2026-09-19",
        timestamp: 1,
      },
      groceryCount: 2,
      paymentCount: 0,
    },
  ]);
  const scan = {
    groupId,
    groupName: "Test household",
    startDate: "2026-09-20",
    endDate: "2026-10-07",
    checkpoint: {
      id: "marker",
      text: "Clear up to date",
      dateStr: "2026-09-19",
      timestamp: 1,
    },
    images: [{ id: "one", merchant: "Shop", amount: 10, paidBy: "Alex" }],
    totals: { totalPool: 10, fairShare: 5, memberTotals: { Alex: 10 } },
  };
  const first = await library.recordSettlementCycle(scan);
  const second = await library.recordSettlementCycle(scan);
  let saved = library
    .loadSettlementCycles()
    .filter((cycle) => cycle.groupId === groupId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].detectedId, "cycle_current");
  assert.equal(second.scannedAt, first.scannedAt);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const updated = await library.recordSettlementCycle({
    ...scan,
    images: [...scan.images, { id: "two", merchant: "Market", amount: 4, paidBy: "Sam" }],
    totals: { totalPool: 14, fairShare: 7, memberTotals: { Alex: 10, Sam: 4 } },
  });
  saved = library
    .loadSettlementCycles()
    .filter((cycle) => cycle.groupId === groupId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].imageCount, 2);
  assert.equal(saved[0].detectedId, "cycle_current");
  assert.notEqual(updated.scannedAt, first.scannedAt);
});

test("legacy cycle keys merge by group and checkpoint date", async () => {
  const groupId = "legacy-cycle-group";
  library.saveSettlementCycles([
    {
      cycleKey: `${groupId}|2026-09-19`,
      groupId,
      startDate: "2026-09-19",
      imageCount: 1,
      images: [{ id: "one" }],
      scannedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      cycleKey: `${groupId}|malformed-message-id`,
      groupId,
      startDate: "2026-09-20",
      checkpoint: { dateStr: "2026-09-19", text: "Clear up to date" },
      detectedId: "cycle_current",
      status: "ACTIVE",
    },
  ]);
  await library.upsertDetectedCycles(groupId, "Test household", [
    {
      id: "cycle_current",
      status: "ACTIVE",
      startDate: "2026-09-20",
      endDate: "2026-10-07",
      startCheckpoint: { id: "marker-19", dateStr: "2026-09-19", text: "Clear up to date" },
      groceryCount: 1,
      paymentCount: 0,
    },
  ]);
  const saved = library
    .loadSettlementCycles()
    .filter((cycle) => cycle.groupId === groupId);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].cycleKey, `${groupId}|boundary:marker-19`);
  assert.equal(saved[0].startBoundaryId, "marker-19");
  assert.equal(saved[0].imageCount, 1);
  assert.equal(saved[0].detectedId, "cycle_current");
});

test("first-cycle redetection replaces an unscanned timezone placeholder", async () => {
  const groupId = "first-cycle-group";
  library.saveSettlementCycles([
    {
      cycleKey: `${groupId}|2026-04-19`,
      groupId,
      startDate: "2026-04-19",
      endDate: "2026-06-01",
      detectedId: "old-first",
      scannedAt: null,
    },
  ]);
  await library.upsertDetectedCycles(groupId, "Test household", [
    {
      id: "cycle_hist_1",
      status: "SETTLED",
      startDate: "2026-04-20",
      endDate: "2026-06-01",
      startCheckpoint: null,
      groceryCount: 3,
      paymentCount: 1,
    },
  ]);
  const saved = library.loadSettlementCycles();
  assert.equal(saved.length, 1);
  assert.equal(
    saved[0].cycleKey,
    `${groupId}|boundary:configured-start:${groupId}:2026-04-20`,
  );
});

test("cycle validation flags gaps instead of silently accepting them", () => {
  const { validateCycles, normaliseBoundary } = require("../server/services/cycle-integrity.cjs");
  assert.equal(normaliseBoundary({ id: "[object Object]" }), null);
  const groupId = "gap-group";
  const cycles = validateCycles([
    {
      groupId,
      status: "SETTLED",
      startDate: "2026-04-20",
      endDate: "2026-05-01",
      startBoundary: { id: "start", dateStr: "2026-04-20", timestamp: 10 },
      endBoundary: { id: "end-a", dateStr: "2026-05-01", timestamp: 20 },
    },
    {
      groupId,
      status: "ACTIVE",
      startDate: "2026-05-02",
      endDate: "2026-05-10",
      startBoundary: { id: "start-b", dateStr: "2026-05-02", timestamp: 30 },
    },
  ]);
  assert.equal(cycles[0].provenance.status, "UNRESOLVED");
  assert.match(cycles[0].provenance.issues.join(" "), /Gap or overlap/);
  assert.equal(cycles[1].provenance.status, "UNRESOLVED");
});

test("redetection removes an unscanned duplicate with the same immutable boundary", async () => {
  const groupId = "duplicate-boundary-group";
  const boundary = {
    id: "same-marker",
    dateStr: "2026-09-19",
    timestamp: 100,
    source: "marker",
  };
  library.saveSettlementCycles([
    {
      schemaVersion: 2,
      cycleKey: `${groupId}|boundary:same-marker`,
      groupId,
      detectedId: "bad-empty-cycle",
      status: "SETTLED",
      startDate: "2026-09-19",
      endDate: "2026-09-19",
      startBoundary: boundary,
      endBoundary: boundary,
      startBoundaryId: boundary.id,
      endBoundaryId: boundary.id,
    },
    {
      schemaVersion: 2,
      cycleKey: `${groupId}|boundary:same-marker`,
      groupId,
      detectedId: "cycle_current",
      status: "ACTIVE",
      startDate: "2026-09-19",
      endDate: "2026-10-08",
      startBoundary: boundary,
      startBoundaryId: boundary.id,
      scannedAt: "2026-10-08T00:00:00.000Z",
      images: [{ id: "kept" }],
    },
  ]);
  await library.upsertDetectedCycles(groupId, "Duplicate household", [
    {
      id: "cycle_current",
      status: "ACTIVE",
      startDate: "2026-09-19",
      endDate: "2026-10-08",
      startBoundary: boundary,
      startCheckpoint: boundary,
      groceryCount: 1,
      paymentCount: 0,
    },
  ]);
  const group = library
    .loadSettlementCycles()
    .filter((cycle) => cycle.groupId === groupId);
  assert.equal(group.length, 1);
  assert.equal(group[0].images[0].id, "kept");
  assert.equal(group[0].status, "ACTIVE");
});

test("cycle completeness records processed, failed and excluded media", async () => {
  const groupId = "completeness-group";
  const record = await library.recordSettlementCycle({
    groupId,
    groupName: "Completeness household",
    startDate: "2026-09-20",
    endDate: "2026-10-08",
    startBoundary: {
      id: "complete-start",
      dateStr: "2026-09-19",
      timestamp: 100,
      source: "marker",
    },
    images: [
      { id: "ok", merchant: "Shop", amount: 10, paidBy: "Alex" },
      {
        id: "failed",
        merchant: "Receipt could not be read",
        amount: 0,
        paidBy: "Alex",
        isExcluded: true,
      },
    ],
    expectedMedia: 3,
    totals: { totalPool: 10, fairShare: 5, memberTotals: { Alex: 10 } },
  });
  assert.deepEqual(record.completeness, {
    expected: 3,
    processed: 2,
    failed: 1,
    excluded: 1,
  });
});

test("manual cycle split keeps images but invalidates unsafe totals", async () => {
  const groupId = "repair-group";
  library.saveSettlementCycles([
    {
      schemaVersion: 2,
      cycleKey: `${groupId}|boundary:start`,
      groupId,
      status: "ACTIVE",
      startDate: "2026-04-20",
      endDate: "2026-06-01",
      startBoundary: { id: "start", dateStr: "2026-04-20", timestamp: 10 },
      startBoundaryId: "start",
      images: [{ id: "preserved" }],
      imageCount: 1,
      scannedAt: "2026-06-02T00:00:00.000Z",
      totals: { totalPool: 20 },
    },
  ]);
  const repaired = await library.repairSettlementCycles({
    action: "split",
    cycleKey: `${groupId}|boundary:start`,
    boundary: { id: "middle", dateStr: "2026-05-01", timestamp: 20 },
  });
  const group = repaired.filter((cycle) => cycle.groupId === groupId);
  assert.equal(group.length, 2);
  assert.equal(group.reduce((sum, cycle) => sum + cycle.images.length, 0), 1);
  assert.ok(group.every((cycle) => cycle.totals === null));
  assert.ok(group.every((cycle) => cycle.scanStale));
  assert.equal(group[0].endBoundaryId, group[1].startBoundaryId);
});
