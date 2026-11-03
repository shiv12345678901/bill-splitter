const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const database = require("./database.cjs");
const library = require("./library.cjs");
const { calculateSettlement } = require("./settlement.cjs");
const { planPeriodRollover, sydneyDate } = require("./cycle-state.cjs");

const DEFAULT_POLL_MS = 5000;
const DEFAULT_LEASE_SECONDS = 15 * 60;
const DEFAULT_REQUESTED_BY = "netlify-app";
const LIVE_MODE = "live";
const DRY_RUN_MODE = "dry-run";
const SCHEMA_APPROVAL = "I_HAVE_CONFIRMED_SUPABASE_SCHEMA";
const WRITE_APPROVAL = "I_UNDERSTAND_SUPABASE_WORKER_WRITES";
const VALID_CATEGORIES = new Set([
  "Groceries",
  "Utilities",
  "Dining",
  "Household Supplies",
  "Other",
]);

// These are the columns consumed by the read-only frontend plus the additive
// lease columns in supabase/migrations/. No other database column is written.
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
    "worker_id",
    "lease_expires_at",
    "attempt_count",
    "claimed_at",
  ],
  periods: [
    "id",
    "start_date",
    "end_date",
    "status",
    "total_cents",
    "per_person_cents",
    "receipt_count",
    "whatsapp_cycle_status",
    "whatsapp_calculation_message",
    "whatsapp_clearance_message",
    "whatsapp_cycle_updated_at",
    "whatsapp_start_boundary",
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
    "payment_obligations_status",
  ],
};

const OPTIONAL_COLUMNS = { periods: ["last_scanned_at"] };

function encodeFilter(operator, value) {
  return `${operator}.${String(value)}`;
}

function dateOnly(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function centsFromAmount(value) {
  if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

function normaliseCategory(value) {
  return VALID_CATEGORIES.has(value) ? value : "Other";
}

function normalisePayer(value, aliases = {}) {
  const payer = String(value || "").trim();
  if (!payer) return "";
  const digits = payer.replace(/\D/g, "");
  return (
    aliases[payer] ||
    (digits && aliases[digits]) ||
    (digits && aliases[`+${digits}`]) ||
    payer
  );
}

function validateReceipt(expense, periodId, aliases = {}) {
  const id = String(expense?.id || "").trim();
  const merchant = String(expense?.merchant || "").trim();
  const payer = normalisePayer(expense?.paidBy, aliases);
  const capturedAt = isoDate(expense?.date);
  const date = capturedAt && dateOnly(capturedAt);
  const amountCents = centsFromAmount(expense?.amount);

  if (!id) throw new Error("Receipt is missing its stable WhatsApp message id.");
  if (!merchant) throw new Error(`Receipt ${id} is missing a merchant.`);
  if (!payer || (Object.keys(aliases).length && !Object.values(aliases).includes(payer)))
    throw new Error(`Receipt ${id} has an unmapped payer; confirm its alias before publishing.`);
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
    // Transfer proofs remain records but never enter the grocery split.
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

function supabaseAuthHeaders(key) {
  return {
    apikey: key,
    ...(String(key).startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
  };
}

function redactSupabaseKey(value, key) {
  return String(value || "").split(String(key)).join("[REDACTED]");
}

function resolveSupabaseServerKey(env = process.env) {
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
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
  const memberTotals = Object.fromEntries(names.map((name) => [name, 0]));
  for (const receipt of visible) {
    if (!Number.isSafeInteger(receipt.amount_cents) || receipt.amount_cents < 0 || !String(receipt.payer || "").trim())
      throw new Error(`Invalid saved receipt ${receipt.id}; refusing to replace settlement totals.`);
    memberTotals[receipt.payer] = (memberTotals[receipt.payer] || 0) + receipt.amount_cents;
  }
  const totalCents = Object.values(memberTotals).reduce((sum, cents) => sum + cents, 0);
  if (!Number.isSafeInteger(totalCents)) throw new Error("Settlement exceeds safe integer cents.");
  const perPersonCents = names.length ? Math.round(totalCents / names.length) : 0;
  return {
    totalCents,
    perPersonCents,
    memberTotals,
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
    this.authHeaders = supabaseAuthHeaders(key);
    this.fetch = fetchImpl;
    this.columns = {};
  }

  async send(target, options) {
    try {
      return await this.fetch(target, options);
    } catch (error) {
      throw new Error(redactSupabaseKey(error?.message || "Supabase request failed.", this.key));
    }
  }

  async request(base, route, { method = "GET", query = {}, body, headers = {} } = {}) {
    const target = new URL(`${this.url}/${base}/${route}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    const response = await this.send(target, {
      method,
      signal: AbortSignal.timeout(30000),
      headers: {
        ...this.authHeaders,
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
      throw new Error(redactSupabaseKey(`Supabase ${method} ${route} failed (${response.status}): ${detail}`, this.key));
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

  async rpc(name, body) {
    return this.request("rest/v1/rpc", name, { method: "POST", body });
  }

  async upload(pathname, buffer, mimetype) {
    const target = new URL(`${this.url}/storage/v1/object/bill-evidence/${pathname}`);
    const response = await this.send(target, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        ...this.authHeaders,
        "Content-Type": mimetype || "image/jpeg",
        "x-upsert": "false",
      },
      body: buffer,
    });
    const text = await response.text();
    // Stable object names make an already uploaded image a successful retry.
    if (!response.ok && response.status !== 409 && !/"(?:statusCode|code)"\s*:\s*"?409/.test(text))
      throw new Error(redactSupabaseKey(`Supabase evidence upload failed (${response.status}): ${text}`, this.key));
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
          // Optional fields are only used when the live schema exposes them.
        }
      }
    }
    const bucket = await this.request("storage/v1", "bucket/bill-evidence");
    if (!bucket || bucket.public !== false) throw new Error("bill-evidence must be a private Storage bucket.");
    const capabilities = await this.rpc("instabox_worker_capabilities", {});
    if (capabilities?.version !== 5) throw new Error("Automatic cycle rollover safeguards migration version 5 is required.");
    this.writeEnabled = capabilities.writes_enabled === true;
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
    "worker_id",
    "lease_expires_at",
  ]);
  return Object.fromEntries(
    Object.entries(changes).filter(
      ([key, value]) => allowed.has(key) && value !== undefined && columns.has(key),
    ),
  );
}

async function localImageForLibrary(expense) {
  const record = library.findById(expense.id);
  if (!record?.fileName) return null;
  const filename = library.imageFilePath(record);
  if (!fs.existsSync(filename)) return null;
  return { buffer: fs.readFileSync(filename), mimetype: record.mimetype || "image/jpeg", fileName: record.fileName };
}

function createSupabaseWorker({
  client,
  scanManager,
  scanEvents,
  getConnection,
  loadUserConfig,
  mode = process.env.SUPABASE_WORKER_MODE || DRY_RUN_MODE,
  schemaApproved = process.env.SUPABASE_WORKER_SCHEMA_APPROVED || "",
  writeApproval = process.env.SUPABASE_WORKER_WRITE_CONFIRM || "",
  workerId = process.env.SPLITMATE_WORKER_ID || `${os.hostname()}-${process.pid}-${crypto.randomUUID()}`,
  pollMs = Number(process.env.SPLITMATE_SUPABASE_POLL_MS) || DEFAULT_POLL_MS,
  leaseSeconds = Number(process.env.SPLITMATE_SYNC_LEASE_SECONDS) || DEFAULT_LEASE_SECONDS,
  requestedBy = process.env.SPLITMATE_SYNC_REQUESTED_BY || DEFAULT_REQUESTED_BY,
  groupId = process.env.SPLITMATE_WHATSAPP_GROUP_ID || "",
  groupName = process.env.SPLITMATE_WHATSAPP_GROUP_NAME || "",
  settlementIdMode = process.env.SUPABASE_SETTLEMENT_ID_MODE || "existing-only",
  // Explicit seam for a reviewed Muse schema/rule mapping. No extra columns
  // may be written without supplying and reviewing a replacement adapter.
  adapter = { validateReceipt, settlementForReceipts },
  localDatabase = database,
  imageLoader = localImageForLibrary,
  contract = { approved: false, reason: "Missing reviewed production contract." },
  transactionalWrites = true,
  logger = console,
} = {}) {
  leaseSeconds = Math.max(30, leaseSeconds);
  let timer = null;
  let ticking = false;
  let schemaVerified = false;
  let stopped = false;
  let guardLogged = false;

  const configured = () => Boolean(client);
  const liveWritesApproved =
    mode === LIVE_MODE && schemaApproved === SCHEMA_APPROVAL && writeApproval === WRITE_APPROVAL && contract.approved;
  let currentJob = null;
  let lastPollAt = null;
  let lastError = null;
  const schemaColumns = (table) => client.columns?.[table] || new Set(REQUIRED_COLUMNS[table] || []);

  async function updateJob(job, changes, { releaseLease = false } = {}) {
    if (currentJob && changes.stage) currentJob.stage = changes.stage;
    const leaseExpiresAt = releaseLease
      ? null
      : new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const payload = updatePayload(
      {
        ...changes,
        worker_id: workerId,
        lease_expires_at: leaseExpiresAt,
        stage_updated_at: changes.stage_updated_at || new Date().toISOString(),
      },
      schemaColumns("sync_requests"),
    );
    const rows = await client.update(
      "sync_requests",
      { id: encodeFilter("eq", job.id), worker_id: encodeFilter("eq", workerId), status: "eq.processing", lease_expires_at: `gt.${new Date().toISOString()}` },
      payload,
    );
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(`Lost the lease for sync request ${job.id}.`);
    }
    return rows[0];
  }

  function createLease(job) {
    let lostError = null;
    let renewing = false;
    let expiresAt = Date.parse(job.lease_expires_at);
    const intervalMs = Math.max(1000, Math.floor((leaseSeconds * 1000) / 3));
    const timerId = setInterval(() => {
      if (renewing || lostError) return;
      renewing = true;
      void updateJob(job, {}, { releaseLease: false }).then((row) => {
        expiresAt = Date.parse(row.lease_expires_at);
      }).catch((error) => { lostError ||= error; }).finally(() => { renewing = false; });
    }, intervalMs);
    return {
      assert() {
        if (lostError) throw lostError;
        if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) throw new Error("Sync lease expired.");
      },
      stop() {
        clearInterval(timerId);
      },
    };
  }

  async function currentPeriod(periodId = null) {
    const query = { select: "*", limit: 1, order: "start_date.desc" };
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
      // Supabase periods, not browser-supplied payload fields, own the cycle range.
      startDate: period.start_date,
      endDate: period.end_date || sydneyDate(Math.floor(Date.now() / 1000)),
      maxMessages: extra.max_messages || extra.maxMessages,
      useCheckpoint: extra.use_checkpoint ?? extra.useCheckpoint ?? false,
      sync: true,
      aliases: config.aliases || {},
      cycleId: extra.cycle_id || extra.cycleId,
    };
  }

  async function persistReceipt(expense, periodId, lease) {
    lease.assert();
    const config = loadUserConfig ? loadUserConfig() : {};
    const aliases = { ...(config.aliases || {}) };
    const row = adapter.validateReceipt(expense, periodId, aliases);
    if (contract.approved) {
      if (!contract.value.members.includes(row.payer)) throw new Error("Payer is not in reviewed household membership.");
      if (!row.amount_cents && contract.value.zeroAmountPolicy === "reject") throw new Error("Zero amount requires manual review.");
      if (contract.value.dateMode === "Australia/Sydney") {
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(row.captured_at));
        const part = (type) => parts.find((p) => p.type === type).value;
        row.date = `${part("year")}-${part("month")}-${part("day")}`;
      }
    }
    const existingRows = await client.select("receipts", {
      select: "id,image_url",
      id: encodeFilter("eq", row.id),
      limit: 1,
    });
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;

    let evidenceLocator = existing?.image_url || null;
    if (!evidenceLocator) {
      const image = await imageLoader(expense);
      if (!image && !existing) throw new Error(`Receipt ${row.id} has no cached evidence image; retry the scan before publishing.`);
      if (image) {
        const objectPath = buildEvidencePath(periodId, row.id, image.mimetype, image.fileName);
        await client.upload(objectPath, image.buffer, image.mimetype);
        evidenceLocator = `storage://bill-evidence/${objectPath}`;
      }
    }

    lease.assert();
    if (transactionalWrites) return { inserted: !existing, id: row.id, row: { ...row, image_url: evidenceLocator } };
    if (existing) {
      // Existing rows may contain manual corrections or exclusions. Only fill missing evidence.
      if (!existing.image_url && evidenceLocator) {
        await client.update("receipts", { id: encodeFilter("eq", row.id), image_url: "is.null" }, { image_url: evidenceLocator });
      }
      return { inserted: false, id: row.id };
    }

    row.image_url = evidenceLocator;
    const inserted = await client.insert("receipts", row, { ignoreDuplicates: true });
    return { inserted: Boolean(inserted?.length), id: row.id };
  }

  async function syncReceipts(expenses, periodId, lease) {
    const result = { inserted: 0, existing: 0, invalid: [], rows: [] };
    const seen = new Set();
    for (const expense of expenses || []) {
      const id = String(expense?.id || "");
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const config = loadUserConfig ? loadUserConfig() : {};
        adapter.validateReceipt(expense, periodId, config.aliases || {});
      } catch (error) {
        result.invalid.push({ id, error: error.message });
        continue;
      }
        const outcome = await persistReceipt(expense, periodId, lease);
        if (outcome.row) result.rows.push(outcome.row);
        if (outcome.inserted) result.inserted++;
        else result.existing++;
    }
    return result;
  }

  async function allPeriodReceipts(periodId) {
    const all = [];
    for (let offset = 0; ; ) {
      const rows = await client.select("receipts", {
      select: "id,period_id,amount_cents,payer,merchant,date,is_excluded",
      period_id: encodeFilter("eq", periodId),
      order: "id.asc",
      limit: 500,
      offset,
    });
      if (!Array.isArray(rows)) throw new Error("Invalid receipt response.");
      if (!rows.length) return all;
      all.push(...rows);
      offset += rows.length;
    }
  }

  async function persistSettlement(period, computed, lease) {
    lease.assert();
    const existingRows = await client.select("settlements", {
      select: "id",
      period_id: encodeFilter("eq", period.id),
      order: "calculated_at.desc",
      limit: 1,
    });
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    const row = {
      period_id: String(period.id),
      total_cents: computed.totalCents,
      per_person_cents: computed.perPersonCents,
      member_totals: computed.memberTotals,
      receipt_count: computed.receiptCount,
      calculated_at: new Date().toISOString(),
    };
    if (existing?.id) {
      await client.update("settlements", { id: encodeFilter("eq", existing.id) }, row);
    } else {
      if (!["text", "uuid"].includes(settlementIdMode))
        throw new Error("No existing settlement: confirm settlements.id type and select text or uuid ID adapter.");
      if (settlementIdMode === "text") row.id = `settlement-${safeObjectName(period.id)}`;
      if (settlementIdMode === "uuid") {
        const hex = crypto.createHash("sha256").update(`splitmate-settlement:${period.id}`).digest("hex");
        row.id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      }
      await client.insert("settlements", row, { ignoreDuplicates: true });
    }
  }

  async function persistPeriod(period, computed, lease) {
    lease.assert();
    const changes = {
      total_cents: computed.totalCents,
      per_person_cents: computed.perPersonCents,
      receipt_count: computed.receiptCount,
    };
    if (schemaColumns("periods").has("last_scanned_at")) changes.last_scanned_at = new Date().toISOString();
    await client.update("periods", { id: encodeFilter("eq", period.id) }, changes);
  }

  async function processClaimedJob(job, lease) {
    let period = await currentPeriod(job.period_id || job.periodId || null);
    if (!period) throw new Error("No current settlement period is available in Supabase.");
    if (period.status !== "CURRENT") {
      const recoveredCurrent = await currentPeriod();
      const closedBoundaryId = period.whatsapp_clearance_message?.id;
      if (!closedBoundaryId || recoveredCurrent?.whatsapp_start_boundary?.id !== closedBoundaryId) {
        throw new Error("The requested period is closed; refusing to move WhatsApp receipts into it.");
      }
      period = recoveredCurrent;
    }

    let context = requestContext(job, period);
    if (!context.groupId) throw new Error("No WhatsApp group is configured for the Supabase worker.");

    if (typeof scanManager.detectCycles === "function") {
      const cycles = await scanManager.detectCycles(context.groupId);
      const rollover = planPeriodRollover(cycles, period);
      if (rollover.action === "rollover") {
        if (!transactionalWrites || !contract.approved) {
          throw new Error("A verified cycle rollover requires the reviewed transactional production adapter.");
        }
        lease.assert();
        await updateJob(job, {
          stage: "rolling_over_period",
          stage_message: "Closing the cleared period and opening the next WhatsApp cycle…",
          error: null,
        });
        await client.rpc("rollover_settlement_period", {
          p_job_id: String(job.id),
          p_worker_id: workerId,
          p_old_period_id: String(period.id),
          p_old_end_date: rollover.closedCycle.endDate,
          p_clearance_message: rollover.closedCycle.clearanceMessage,
          p_new_period_id: rollover.newPeriodId,
          p_new_settlement_id: rollover.newSettlementId,
          p_new_start_date: rollover.nextCycle.startDate,
          p_start_boundary: rollover.nextCycle.startBoundary,
          p_new_cycle_status: rollover.nextCycle.status,
          p_calculation_message: rollover.nextCycle.calculationMessage,
          p_members: contract.value.members,
        });
        lease.assert();
        period = await currentPeriod(rollover.newPeriodId);
        if (!period || period.status !== "CURRENT") {
          throw new Error("The rollover did not produce the expected CURRENT period.");
        }
        context = requestContext(job, period);
        context.cycleId = rollover.nextCycle.id;
        context.cycleBoundaryId = rollover.nextCycle.startBoundary?.id;
      } else {
        context.cycleId = rollover.cycle.id;
        context.cycleBoundaryId = rollover.cycle.startBoundary?.id;
      }
    } else if (transactionalWrites) {
      throw new Error("The production scanner cannot verify WhatsApp cycle rollover state.");
    }

    lease.assert();
    await updateJob(job, {
      stage: "discovering",
      stage_message: "Loading receipt photos from WhatsApp…",
      error: null,
    });
    const prepared = await scanManager.prepare(context);
    if (!prepared) throw new Error("WhatsApp receipt discovery could not be prepared.");

    lease.assert();
    await updateJob(job, {
      stage: "scanning",
      stage_message: `${prepared.expectedImages || 0} receipt photo(s) found. Reading them…`,
    });
    let progressQueue = Promise.resolve();
    const progressHandler = (payload = {}) => {
      if (payload.runId !== prepared.jobId || !payload.message) return;
      progressQueue = progressQueue.then(() => updateJob(job, {
        stage: "scanning",
        stage_message: payload.message,
      })).catch((error) => logger.warn(`[Supabase] Could not report scan progress: ${error.message}`));
    };
    scanEvents?.on?.("scan:progress", progressHandler);
    try {
      await scanManager.runAndGet(prepared.jobId, { retryFailedOnly: ["partial", "failed"].includes(prepared.status) });
    } finally {
      scanEvents?.off?.("scan:progress", progressHandler);
      await progressQueue;
    }
    lease.assert();
    const localJob = localDatabase.getScanJob(prepared.jobId);
    if (!localJob) throw new Error("The local scan job disappeared before completion.");
    if (["failed", "cancelled"].includes(localJob.status)) {
      throw new Error(localJob.message || localJob.errorCode || "WhatsApp scan failed.");
    }

    const expenses = localJob.result?.expenses || [];
    await updateJob(job, {
      stage: "saving_receipts",
      stage_message: `Validating and saving ${expenses.length} receipt result(s)…`,
    });
    const saved = await syncReceipts(expenses, period.id, lease);
    if (transactionalWrites) {
      if (saved.invalid.length || localJob.status !== "complete") throw new Error("Scan is incomplete or failed validation; saved local results were retained for retry.");
      if (!contract.approved) throw new Error("Production writes require a reviewed contract.");
      lease.assert();
      const cycle = localJob.selectedCycleData;
      if (!cycle) throw new Error("The scan has no verified WhatsApp cycle mapping.");
      await client.rpc("record_period_cycle_state", {
        p_job_id: String(job.id),
        p_worker_id: workerId,
        p_period_id: String(period.id),
        p_cycle_status: cycle.status,
        p_calculation_message: cycle.calculationMessage,
        p_clearance_message: cycle.clearanceMessage,
      });
      lease.assert();
      const result = await client.rpc("finalize_sync_request", {
        p_job_id: String(job.id), p_worker_id: workerId, p_period_id: String(period.id),
        p_receipts: saved.rows, p_members: contract.value.members,
        p_rounding: contract.value.shareRounding, p_settlement_id_mode: contract.value.settlementIdMode,
      });
      return { finalized: true, resultSummary: result.result_summary };
    }
    const allReceipts = await allPeriodReceipts(period.id);
    const config = loadUserConfig ? loadUserConfig() : {};
    const members = [...new Set(Object.values(config.aliases || {}).filter(Boolean))];
    const computed = adapter.settlementForReceipts(allReceipts, members);

    await updateJob(job, {
      stage: "updating_settlement",
      stage_message: "Updating the period and settlement totals…",
    });
    await persistPeriod(period, computed, lease);
    await persistSettlement(period, computed, lease);

    const reviewText = computed.reviewCount ? ` ${computed.reviewCount} receipt(s) still need review.` : "";
    const invalidText = saved.invalid.length
      ? ` ${saved.invalid.length} result(s) were rejected by validation.`
      : "";
    if (saved.invalid.length || (localJob.reconciliation?.failed || 0) || (localJob.reconciliation?.queued || 0))
      throw new Error(`Some receipts require attention. ${saved.invalid.length} validation rejection(s), ${localJob.reconciliation?.failed || 0} failed image(s). Completed receipts were preserved.`);
    return {
      saved,
      computed,
      resultSummary: `Sync complete: ${saved.inserted} new receipt(s), ${computed.receiptCount} receipt(s) in the period.${reviewText}${invalidText}`,
    };
  }

  async function claimNext() {
    if (!liveWritesApproved || !schemaVerified || stopped) return null;
    const rows = await client.rpc("claim_sync_request", {
      p_worker_id: workerId,
      p_requested_by: requestedBy,
      p_lease_seconds: leaseSeconds,
    });
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  async function tick() {
    if (stopped || ticking || !schemaVerified || !liveWritesApproved || client.writeEnabled !== true) return null;
    const connection = getConnection?.();
    if (!connection?.client || connection.clientStatus !== "READY") return null;
    const activeKeys = connection.geminiApiKeys?.length
      ? connection.geminiApiKeys
      : connection.geminiApiKey
        ? [connection.geminiApiKey]
        : [];
    if (!activeKeys.length) return null;

    ticking = true;
    try {
      const job = await claimNext();
      if (!job) return null;
      currentJob = { id: job.id, attempt: job.attempt_count };
      const lease = createLease(job);
      try {
        const result = await processClaimedJob(job, lease);
        if (result.finalized) return result;
        lease.assert();
        await updateJob(
          job,
          {
            status: "done",
            stage: "complete",
            stage_message: "Sync complete",
            result_summary: result.resultSummary,
            error: null,
          },
          { releaseLease: true },
        );
        return result;
      } catch (error) {
        lastError = error.message;
        logger.error(`[Supabase] Sync request ${job.id} failed:`, error.message);
        try {
          if (transactionalWrites) await client.rpc("retry_sync_request", {
            p_job_id: String(job.id), p_worker_id: workerId, p_error: error.message || "Sync failed",
          });
          else await updateJob(
            job,
            {
              status: "failed",
              stage: "failed",
              stage_message: "Sync failed",
              result_summary: null,
              error: error.message || "The sync failed.",
            },
            { releaseLease: true },
          );
        } catch (leaseError) {
          logger.error(`[Supabase] Could not report failure for ${job.id}:`, leaseError.message);
        }
        return null;
      } finally {
        lease.stop();
        currentJob = null;
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
        logger.log("[Supabase] Required live columns verified; InstaBox worker is ready.");
      } catch (error) {
        lastError = error.message;
        logger.warn(`[Supabase] Worker paused until schema verification succeeds: ${error.message}`);
        return;
      }
    }
    if (mode === LIVE_MODE && schemaVerified && liveWritesApproved) {
      const capabilities = await client.rpc("instabox_worker_capabilities", {});
      client.writeEnabled = capabilities?.version === 5 && capabilities.writes_enabled === true;
    }
    if (mode !== LIVE_MODE) {
      if (!guardLogged) {
        logger.log(`[Supabase] Dry-run mode: verified schema only; no jobs will be claimed or written.`);
        guardLogged = true;
      }
      return;
    }
    if (!liveWritesApproved) {
      if (!guardLogged) {
        logger.error(
          `[Supabase] Live writes are locked. Set SUPABASE_WORKER_SCHEMA_APPROVED=${SCHEMA_APPROVAL} and SUPABASE_WORKER_WRITE_CONFIRM=${WRITE_APPROVAL}.`,
        );
        guardLogged = true;
      }
      return;
    }
    await tick();
  }

  async function safeTick() {
    lastPollAt = new Date().toISOString();
    try { lastError = null; return await verifyAndTick(); }
    catch (error) { lastError = error.message; logger.warn(`[Supabase] Poll failed; retrying next interval: ${error.message}`); }
  }

  function start() {
    if (!configured() || timer) return;
    stopped = false;
    timer = setInterval(() => void safeTick(), Math.max(1000, pollMs));
    void safeTick();
    logger.log(`[Supabase] InstaBox worker polling every ${Math.max(1000, pollMs)}ms in ${mode} mode.`);
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
    get diagnostics() { return { currentJob, lastPollAt, lastError, writesEnabled: client?.writeEnabled === true }; },
    get liveWritesApproved() {
      return liveWritesApproved;
    },
    get schemaVerified() {
      return schemaVerified;
    },
  };
}

function createConfiguredSupabaseWorker(options = {}) {
  const url = options.url || process.env.SUPABASE_URL;
  const key = options.key || resolveSupabaseServerKey(process.env);
  if (!url || !key) return null;
  const client = options.client || new SupabaseRestClient({ url, key, fetchImpl: options.fetchImpl });
  return createSupabaseWorker({ ...options, client });
}

module.exports = {
  DEFAULT_LEASE_SECONDS,
  DRY_RUN_MODE,
  LIVE_MODE,
  REQUIRED_COLUMNS,
  SCHEMA_APPROVAL,
  WRITE_APPROVAL,
  SupabaseRestClient,
  resolveSupabaseServerKey,
  createSupabaseWorker,
  createConfiguredSupabaseWorker,
  centsFromAmount,
  validateReceipt,
  settlementForReceipts,
};
