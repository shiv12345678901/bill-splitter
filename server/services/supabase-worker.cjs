const fs = require("node:fs");

const database = require("./database.cjs");
const library = require("./library.cjs");
const { calculateSettlement } = require("./settlement.cjs");

const DEFAULT_POLL_MS = 5000;
const DEFAULT_REQUESTED_BY = "netlify-app";
const VALID_CATEGORIES = new Set([
  "Groceries",
  "Utilities",
  "Dining",
  "Household Supplies",
  "Other",
]);

const REQUIRED_COLUMNS = {
  sync_requests: [
    "id",
    "requested_by",
    "status",
    "stage",
    "stage_message",
    "stage_updated_at",
    "result_summary",
    "error",
    "created_at",
  ],
  periods: [
    "id",
    "start_date",
    "end_date",
    "status",
    "total_cents",
    "per_person_cents",
    "receipt_count",
  ],
  receipts: [
    "id",
    "period_id",
    "captured_at",
    "merchant",
    "amount_cents",
    "payer",
    "category",
    "date",
    "is_excluded",
    "image_url",
  ],
  settlements: [
    "id",
    "period_id",
    "total_cents",
    "per_person_cents",
    "member_totals",
    "receipt_count",
    "calculated_at",
  ],
};

const OPTIONAL_COLUMNS = {
  periods: ["last_scanned_at"],
};

function encodeFilter(operator, value) {
  return `${operator}.${String(value)}`;
}

function dateOnly(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function isoDate(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function centsFromAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function normaliseCategory(value) {
  return VALID_CATEGORIES.has(value) ? value : "Other";
}

function validateReceipt(expense, periodId) {
  const id = String(expense?.id || "").trim();
  const merchant = String(expense?.merchant || "").trim();
  const payer = String(expense?.paidBy || "").trim();
  const capturedAt = isoDate(expense?.date);
  const date = dateOnly(expense?.date);
  const amountCents = centsFromAmount(expense?.amount);

  if (!id) throw new Error("Receipt is missing its stable WhatsApp message id.");
  if (!merchant) throw new Error(`Receipt ${id} is missing a merchant.`);
  if (!payer) throw new Error(`Receipt ${id} is missing a payer.`);
  if (!capturedAt || !date) throw new Error(`Receipt ${id} has an invalid date.`);
  if (amountCents === null) throw new Error(`Receipt ${id} has an invalid amount.`);

  return {
    id,
    period_id: String(periodId),
    captured_at: capturedAt,
    merchant,
    amount_cents: amountCents,
    payer,
    category: normaliseCategory(expense.category),
    date,
    // Transfer proofs are retained as evidence but excluded from the grocery split.
    is_excluded: Boolean(expense.isExcluded || expense.isBankTransfer),
    image_url: null,
  };
}

function safeObjectName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function extensionFor(mimetype, fileName = "") {
  const source = `${mimetype || ""} ${fileName}`.toLowerCase();
  if (source.includes("png")) return "png";
  if (source.includes("webp")) return "webp";
  return "jpg";
}

function buildEvidencePath(periodId, receiptId, mimetype, fileName) {
  return `${safeObjectName(periodId)}/${safeObjectName(receiptId)}.${extensionFor(mimetype, fileName)}`;
}

function settlementForReceipts(receipts, members = []) {
  const visible = receipts.filter((receipt) => !receipt.is_excluded);
  const expenses = visible.map((receipt) => ({
    id: receipt.id,
    amount: Number(receipt.amount_cents || 0) / 100,
    paidBy: String(receipt.payer || ""),
    merchant: String(receipt.merchant || ""),
    date: receipt.date,
    isExcluded: false,
  }));
  const settlement = calculateSettlement(expenses, {}, members);
  const names = Object.keys(settlement.memberTotals || {}).sort((a, b) => a.localeCompare(b));
  const totalCents = names.reduce(
    (sum, name) => sum + Math.round(Number(settlement.memberTotals[name] || 0) * 100),
    0,
  );
  const perPersonCents = names.length ? Math.floor(totalCents / names.length) : 0;
  return {
    totalCents,
    perPersonCents,
    memberTotals: Object.fromEntries(
      names.map((name) => [name, Math.round(Number(settlement.memberTotals[name] || 0) * 100)]),
    ),
    receiptCount: visible.length,
    reviewCount: visible.filter((receipt) => Number(receipt.amount_cents) <= 0).length,
  };
}

class SupabaseRestClient {
  constructor({ url, key, fetchImpl = globalThis.fetch }) {
    if (!url || !key) throw new Error("SUPABASE_URL and a server-only Supabase key are required.");
    if (typeof fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch.");
    this.url = String(url).replace(/\/$/, "");
    this.key = key;
    this.fetch = fetchImpl;
    this.columns = {};
  }

  async request(base, route, { method = "GET", query = {}, body, headers = {} } = {}) {
    const target = new URL(`${this.url}/${base}/${route}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    const response = await this.fetch(target, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      const detail = payload?.message || payload?.error_description || payload?.error || text;
      throw new Error(`Supabase ${method} ${route} failed (${response.status}): ${detail}`);
    }
    return payload;
  }

  async select(table, query = {}) {
    return this.request("rest/v1", table, { query });
  }

  async update(table, filters, body) {
    return this.request("rest/v1", table, {
      method: "PATCH",
      query: filters,
      body,
      headers: { Prefer: "return=representation" },
    });
  }

  async insert(table, body, { ignoreDuplicates = false } = {}) {
    return this.request("rest/v1", table, {
      method: "POST",
      body,
      headers: {
        Prefer: `return=representation${ignoreDuplicates ? ",resolution=ignore-duplicates" : ""}`,
      },
    });
  }

  async upload(pathname, buffer, mimetype) {
    const target = new URL(`${this.url}/storage/v1/object/bill-evidence/${pathname}`);
    const response = await this.fetch(target, {
      method: "POST",
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": mimetype || "image/jpeg",
        "x-upsert": "true",
      },
      body: buffer,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Supabase evidence upload failed (${response.status}): ${text}`);
  }

  async verifySchema() {
    const verified = {};
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      await this.select(table, { select: columns.join(","), limit: 0 });
      verified[table] = new Set(columns);
      for (const optional of OPTIONAL_COLUMNS[table] || []) {
        try {
          await this.select(table, { select: optional, limit: 0 });
          verified[table].add(optional);
        } catch {
          // Optional columns are used only when the live schema exposes them.
        }
      }
    }
    this.columns = verified;
    return verified;
  }
}

function updatePayload(changes, columns) {
  const allowed = new Set([
    "status",
    "stage",
    "stage_message",
    "stage_updated_at",
    "result_summary",
    "error",
  ]);
  return Object.fromEntries(
    Object.entries(changes).filter(([key, value]) => allowed.has(key) && value !== undefined && columns.has(key)),
  );
}

function createSupabaseWorker({
  client,
  scanManager,
  getConnection,
  loadUserConfig,
  pollMs = Number(process.env.SPLITMATE_SUPABASE_POLL_MS) || DEFAULT_POLL_MS,
  requestedBy = process.env.SPLITMATE_SYNC_REQUESTED_BY || DEFAULT_REQUESTED_BY,
  groupId = process.env.SPLITMATE_WHATSAPP_GROUP_ID || "",
  groupName = process.env.SPLITMATE_WHATSAPP_GROUP_NAME || "",
  logger = console,
} = {}) {
  let timer = null;
  let ticking = false;
  let schemaVerified = false;
  let stopped = false;

  const configured = () => Boolean(client && scanManager && typeof getConnection === "function");
  const schemaColumns = (table) => client.columns?.[table] || new Set(REQUIRED_COLUMNS[table] || []);

  async function updateJob(id, changes) {
    const payload = updatePayload(
      { ...changes, stage_updated_at: changes.stage_updated_at || new Date().toISOString() },
      schemaColumns("sync_requests"),
    );
    const rows = await client.update("sync_requests", { id: encodeFilter("eq", id) }, payload);
    return Array.isArray(rows) ? rows[0] || null : rows;
  }

  async function currentPeriod(periodId = null) {
    const query = {
      select: "*",
      limit: 1,
      order: "start_date.desc",
    };
    if (periodId) query.id = encodeFilter("eq", periodId);
    else query.status = encodeFilter("eq", "CURRENT");
    const rows = await client.select("periods", query);
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  function requestContext(job, period) {
    const extra = job.request || job.payload || job.params || {};
    const config = loadUserConfig ? loadUserConfig() : {};
    return {
      runId: `supabase-${job.id}`,
      groupId: extra.group_id || extra.groupId || job.group_id || groupId || config.defaultGroupId,
      groupName: extra.group_name || extra.groupName || job.group_name || groupName || config.defaultGroupName,
      startDate: extra.start_date || extra.startDate || period.start_date,
      endDate: extra.end_date || extra.endDate || period.end_date || new Date().toISOString().slice(0, 10),
      maxMessages: extra.max_messages || extra.maxMessages,
      useCheckpoint: extra.use_checkpoint ?? extra.useCheckpoint ?? true,
      sync: true,
      cycleId: extra.cycle_id || extra.cycleId,
    };
  }

  async function localImageFor(expense) {
    const record = library.findById(expense.id);
    if (!record?.fileName) return null;
    const filename = library.imageFilePath(record);
    if (!fs.existsSync(filename)) return null;
    return {
      buffer: fs.readFileSync(filename),
      mimetype: record.mimetype || "image/jpeg",
      fileName: record.fileName,
    };
  }

  async function persistReceipt(expense, periodId) {
    const row = validateReceipt(expense, periodId);
    const existingRows = await client.select("receipts", {
      select: "id,image_url",
      id: encodeFilter("eq", row.id),
      limit: 1,
    });
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;

    let evidenceLocator = existing?.image_url || null;
    if (!evidenceLocator) {
      const image = await localImageFor(expense);
      if (image) {
        const objectPath = buildEvidencePath(periodId, row.id, image.mimetype, image.fileName);
        await client.upload(objectPath, image.buffer, image.mimetype);
        evidenceLocator = `storage://bill-evidence/${objectPath}`;
      }
    }

    if (existing) {
      // Existing rows may contain user corrections or exclusions. Only fill a missing evidence locator.
      if (!existing.image_url && evidenceLocator) {
        await client.update(
          "receipts",
          { id: encodeFilter("eq", row.id) },
          { image_url: evidenceLocator },
        );
      }
      return { inserted: false, id: row.id };
    }

    row.image_url = evidenceLocator;
    await client.insert("receipts", row, { ignoreDuplicates: true });
    return { inserted: true, id: row.id };
  }

  async function syncReceipts(expenses, periodId) {
    const result = { inserted: 0, existing: 0, invalid: [] };
    const seen = new Set();
    for (const expense of expenses || []) {
      const id = String(expense?.id || "");
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const outcome = await persistReceipt(expense, periodId);
        if (outcome.inserted) result.inserted++;
        else result.existing++;
      } catch (error) {
        result.invalid.push({ id, error: error.message });
        logger.warn(`[Supabase] Skipped invalid receipt ${id}: ${error.message}`);
      }
    }
    return result;
  }

  async function allPeriodReceipts(periodId) {
    const rows = await client.select("receipts", {
      select: "id,period_id,amount_cents,payer,merchant,date,is_excluded",
      period_id: encodeFilter("eq", periodId),
      order: "date.asc",
      limit: 10000,
    });
    return Array.isArray(rows) ? rows : [];
  }

  async function persistSettlement(period, computed) {
    const existingRows = await client.select("settlements", {
      select: "id",
      period_id: encodeFilter("eq", period.id),
      order: "calculated_at.desc",
      limit: 1,
    });
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    const row = {
      // Stable for retries where the period has no settlement yet.
      id: `settlement-${safeObjectName(period.id)}`,
      period_id: String(period.id),
      total_cents: computed.totalCents,
      per_person_cents: computed.perPersonCents,
      member_totals: computed.memberTotals,
      receipt_count: computed.receiptCount,
      calculated_at: new Date().toISOString(),
    };
    if (existing?.id) {
      delete row.id;
      await client.update("settlements", { id: encodeFilter("eq", existing.id) }, row);
    } else {
      await client.insert("settlements", row, { ignoreDuplicates: true });
    }
  }

  async function persistPeriod(period, computed) {
    const changes = {
      total_cents: computed.totalCents,
      per_person_cents: computed.perPersonCents,
      receipt_count: computed.receiptCount,
    };
    if (schemaColumns("periods").has("last_scanned_at")) changes.last_scanned_at = new Date().toISOString();
    await client.update("periods", { id: encodeFilter("eq", period.id) }, changes);
  }

  async function processClaimedJob(job) {
    const period = await currentPeriod(job.period_id || job.periodId || null);
    if (!period) throw new Error("No current settlement period is available in Supabase.");

    const context = requestContext(job, period);
    if (!context.groupId) throw new Error("No WhatsApp group is configured for the Supabase worker.");

    await updateJob(job.id, {
      stage: "discovering",
      stage_message: "Loading receipt photos from WhatsApp…",
      error: null,
    });
    const prepared = await scanManager.prepare(context);
    if (!prepared) throw new Error("WhatsApp receipt discovery could not be prepared.");

    await updateJob(job.id, {
      stage: "scanning",
      stage_message: `${prepared.expectedImages || 0} receipt photo(s) found. Reading them…`,
    });
    await scanManager.runAndGet(prepared.jobId);
    const localJob = database.getScanJob(prepared.jobId);
    if (!localJob) throw new Error("The local scan job disappeared before completion.");
    if (["failed", "cancelled"].includes(localJob.status)) {
      throw new Error(localJob.message || localJob.errorCode || "WhatsApp scan failed.");
    }

    const expenses = localJob.result?.expenses || [];
    await updateJob(job.id, {
      stage: "saving_receipts",
      stage_message: `Validating and saving ${expenses.length} receipt result(s)…`,
    });
    const saved = await syncReceipts(expenses, period.id);
    const allReceipts = await allPeriodReceipts(period.id);
    const computed = settlementForReceipts(allReceipts);

    await updateJob(job.id, {
      stage: "updating_settlement",
      stage_message: "Updating the period and settlement totals…",
    });
    await persistPeriod(period, computed);
    await persistSettlement(period, computed);

    const reviewText = computed.reviewCount
      ? ` ${computed.reviewCount} receipt(s) still need review.`
      : "";
    const invalidText = saved.invalid.length
      ? ` ${saved.invalid.length} result(s) were rejected by validation.`
      : "";
    return {
      saved,
      computed,
      resultSummary: `Sync complete: ${saved.inserted} new receipt(s), ${computed.receiptCount} receipt(s) in the period.${reviewText}${invalidText}`,
    };
  }

  async function claimNext() {
    const query = {
      select: "*",
      status: encodeFilter("eq", "pending"),
      requested_by: encodeFilter("eq", requestedBy),
      order: "created_at.asc",
      limit: 1,
    };
    const pending = await client.select("sync_requests", query);
    const candidate = Array.isArray(pending) ? pending[0] : null;
    if (!candidate?.id) return null;

    // The status predicate makes this compare-and-swap atomic in PostgREST.
    const claimed = await client.update(
      "sync_requests",
      { id: encodeFilter("eq", candidate.id), status: encodeFilter("eq", "pending") },
      {
        status: "processing",
        stage: "claimed",
        stage_message: "Sync request claimed by InstaBox…",
        error: null,
      },
    );
    return Array.isArray(claimed) ? claimed[0] || null : null;
  }

  async function tick() {
    if (stopped || ticking || !schemaVerified) return;
    const connection = getConnection();
    if (!connection?.client || connection.clientStatus !== "READY") return;
    const activeKeys = connection.geminiApiKeys?.length
      ? connection.geminiApiKeys
      : connection.geminiApiKey
        ? [connection.geminiApiKey]
        : [];
    if (!activeKeys.length) return;

    ticking = true;
    try {
      const job = await claimNext();
      if (!job) return;
      try {
        const result = await processClaimedJob(job);
        await updateJob(job.id, {
          status: "done",
          stage: "complete",
          stage_message: "Sync complete",
          result_summary: result.resultSummary,
          error: null,
        });
      } catch (error) {
        logger.error(`[Supabase] Sync request ${job.id} failed:`, error.message);
        await updateJob(job.id, {
          status: "failed",
          stage: "failed",
          stage_message: "Sync failed",
          result_summary: null,
          error: error.message || "The sync failed.",
        });
      }
    } finally {
      ticking = false;
    }
  }

  async function verifyAndTick() {
    if (stopped || !configured()) return;
    if (!schemaVerified) {
      try {
        await client.verifySchema();
        schemaVerified = true;
        logger.log("[Supabase] Live schema verified; InstaBox worker is ready.");
      } catch (error) {
        logger.warn(`[Supabase] Worker paused until schema verification succeeds: ${error.message}`);
        return;
      }
    }
    await tick();
  }

  function start() {
    if (!configured() || timer) return;
    stopped = false;
    timer = setInterval(() => void verifyAndTick(), Math.max(1000, pollMs));
    void verifyAndTick();
    logger.log(`[Supabase] InstaBox worker polling every ${Math.max(1000, pollMs)}ms.`);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick: verifyAndTick,
    processClaimedJob,
    get schemaVerified() {
      return schemaVerified;
    },
  };
}

function createConfiguredSupabaseWorker(options = {}) {
  const url = options.url || process.env.SUPABASE_URL;
  const key = options.key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const client = options.client || new SupabaseRestClient({ url, key, fetchImpl: options.fetchImpl });
  return createSupabaseWorker({
    ...options,
    client,
    scanManager: options.scanManager,
    getConnection: options.getConnection,
    loadUserConfig: options.loadUserConfig,
  });
}

module.exports = {
  REQUIRED_COLUMNS,
  SupabaseRestClient,
  createSupabaseWorker,
  createConfiguredSupabaseWorker,
  centsFromAmount,
  validateReceipt,
  settlementForReceipts,
};
