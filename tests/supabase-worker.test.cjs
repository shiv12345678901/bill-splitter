const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const workerTestData = fs.mkdtempSync(path.join(os.tmpdir(), "splitmate-worker-tests-"));
process.env.SPLITMATE_DATA_DIR = workerTestData;

const {
  centsFromAmount,
  validateReceipt,
  settlementForReceipts,
  SupabaseRestClient,
  resolveSupabaseServerKey,
  REQUIRED_COLUMNS,
  createSupabaseWorker,
  SCHEMA_APPROVAL,
  WRITE_APPROVAL,
} = require("../server/services/supabase-worker.cjs");
const { WhatsAppSessionLock } = require("../server/services/whatsapp-session-lock.cjs");

test("Supabase receipt validation follows the available SplitMate cent and category rules", () => {
  assert.equal(centsFromAmount(12.345), 1235);
  assert.equal(centsFromAmount(-1), null);
  assert.equal(centsFromAmount("not money"), null);

  const receipt = validateReceipt(
    {
      id: "whatsapp-message-1",
      date: "2026-10-31T10:00:00.000Z",
      paidBy: "Alex",
      merchant: "Market",
      amount: 12.34,
      category: "Not a frontend category",
      isBankTransfer: false,
    },
    "period-current",
  );

  assert.deepEqual(receipt, {
    id: "whatsapp-message-1",
    period_id: "period-current",
    captured_at: "2026-10-31T10:00:00.000Z",
    merchant: "Market",
    amount_cents: 1234,
    payer: "Alex",
    category: "Other",
    date: "2026-10-31",
    is_excluded: false,
    image_url: null,
  });
});

test("validation rejects impossible calendar dates, absent amounts and unknown payer mappings", () => {
  const receipt = { id: "a", date: "2026-02-28", paidBy: "Alex", merchant: "Market", amount: 10 };
  for (const amount of [null, undefined, "", false, Infinity, -1])
    assert.equal(centsFromAmount(amount), null);
  assert.throws(() => validateReceipt({ ...receipt, date: "2026-02-30" }, "p"), /invalid date/);
  assert.throws(() => validateReceipt(receipt, "p", { sender: "Jamie" }), /unmapped payer/);
  assert.equal(validateReceipt({ ...receipt, paidBy: "sender" }, "p", { sender: "Jamie" }).payer, "Jamie");
});

function fakeIntegration({ failInsert = false, periodStatus = "CURRENT" } = {}) {
  const receipts = new Map([["edited", { id: "edited", period_id: "p", merchant: "Manual edit", payer: "Alex", amount_cents: 999, date: "2026-10-01", is_excluded: true, image_url: "storage://bill-evidence/manual.jpg" }]]);
  const settlements = [];
  const uploads = [];
  const jobs = [];
  const expenses = ["edited", "new", "new"].map((id) => ({ id, date: "2026-10-01", paidBy: "Alex", merchant: "OCR merchant", amount: 10, category: "Groceries" }));
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: false,
    workerId: "test-worker",
    settlementIdMode: "text",
    loadUserConfig: () => ({ defaultGroupId: "fixture-group", aliases: { sender: "Alex" } }),
    localDatabase: { getScanJob: () => ({ status: "complete", result: { expenses } }) },
    imageLoader: async () => ({ buffer: Buffer.from("fixture-image"), mimetype: "image/jpeg" }),
    scanManager: { prepare: async () => ({ jobId: "local", expectedImages: 3 }), runAndGet: async () => {} },
    client: {
      select: async (table, query) => {
        if (table === "periods") return [{ id: "p", status: periodStatus, start_date: "2026-10-01", end_date: "2026-10-31" }];
        if (table === "settlements") return settlements;
        if (query.id) return receipts.has(query.id.slice(3)) ? [receipts.get(query.id.slice(3))] : [];
        return [...receipts.values()].slice(query.offset || 0, (query.offset || 0) + query.limit);
      },
      update: async (table, filters, body) => {
        if (table === "sync_requests") jobs.push(body);
        if (table === "receipts") Object.assign(receipts.get(filters.id.slice(3)), body);
        if (table === "settlements") Object.assign(settlements[0], body);
        return [{ id: "job", ...body }];
      },
      insert: async (table, row) => {
        if (failInsert) throw new Error("Supabase unavailable");
        if (table === "receipts") receipts.set(row.id, { ...row });
        else settlements.push({ ...row });
        return [row];
      },
      upload: async (objectPath) => uploads.push(objectPath),
    },
  });
  return { worker, receipts, settlements, uploads, jobs };
}

test("replaying a scan preserves manual edits and exclusions, uploads private evidence and avoids duplicate records", async () => {
  const fixture = fakeIntegration();
  const lease = { assert() {} };
  await fixture.worker.processClaimedJob({ id: "job" }, lease);
  await fixture.worker.processClaimedJob({ id: "job" }, lease);
  assert.equal(fixture.receipts.size, 2);
  assert.equal(fixture.receipts.get("edited").merchant, "Manual edit");
  assert.equal(fixture.receipts.get("edited").is_excluded, true);
  assert.match(fixture.receipts.get("new").image_url, /^storage:\/\/bill-evidence\//);
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.settlements.length, 1);
  assert.equal(fixture.settlements[0].total_cents, 1000);
  assert.equal(fixture.settlements[0].member_totals.Alex, 1000);
});

test("persistence failure fails the job instead of being swallowed as a validation warning", async () => {
  const { worker } = fakeIntegration({ failInsert: true });
  await assert.rejects(() => worker.processClaimedJob({ id: "job" }, { assert() {} }), /Supabase unavailable/);
});

test("the worker refuses to place receipts into a closed Supabase period", async () => {
  const { worker } = fakeIntegration({ periodStatus: "CLOSED" });
  await assert.rejects(
    () => worker.processClaimedJob({ id: "job", period_id: "p" }, { assert() {} }),
    /period is closed/i,
  );
});

test("a retry follows an already committed rollover only when boundary IDs match", async () => {
  let preparedContext = null;
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: false,
    settlementIdMode: "text",
    groupId: "fixture-group",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      prepare: async (context) => {
        preparedContext = context;
        return { jobId: "recovered-rollover", expectedImages: 0, status: "queued" };
      },
      runAndGet: async () => {},
    },
    localDatabase: {
      getScanJob: () => ({ status: "complete", result: { expenses: [] }, reconciliation: { failed: 0, queued: 0 } }),
    },
    client: {
      select: async (table, query = {}) => {
        if (table === "periods" && query.id) return [{
          id: "old", status: "CLOSED", start_date: "2026-10-10", end_date: "2026-10-31",
          whatsapp_clearance_message: { id: "clearance-31-oct" },
        }];
        if (table === "periods") return [{
          id: "period_2026-10-31", status: "CURRENT", start_date: "2026-10-31", end_date: null,
          whatsapp_start_boundary: { id: "clearance-31-oct" },
        }];
        return [];
      },
      update: async (table, filters, body) => table === "sync_requests" ? [{ id: "job", ...body }] : [],
      insert: async (table, row) => [row],
    },
  });
  await worker.processClaimedJob({
    id: "job", period_id: "old",
    request: { start_date: "1999-01-01", end_date: "2099-12-31" },
  }, { assert() {} });
  assert.equal(preparedContext.startDate, "2026-10-31");
  assert.notEqual(preparedContext.endDate, "2099-12-31");
});

test("transactional publishing records pending-cycle metadata before finalizing receipts", async () => {
  const rpcCalls = [];
  const calculationMessage = { id: "calc-1", text: "Total = 40", timestamp: 1793500000 };
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: true,
    workerId: "test-worker",
    contract: {
      approved: true,
      value: {
        members: ["Alex", "Jamie", "Morgan", "Taylor"],
        aliases: {},
        shareRounding: "floor",
        settlementIdMode: "existing-only",
        zeroAmountPolicy: "preserve",
      },
    },
    groupId: "fixture-group",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [{
        id: "cycle_current",
        status: "ACTIVE",
        settlementConfirmed: false,
        startDate: "2026-10-01",
        endDate: null,
        startBoundary: { id: "start-1", source: "marker", confidence: "HIGH" },
      }],
      prepare: async () => ({ jobId: "local", expectedImages: 1, status: "queued" }),
      runAndGet: async () => {},
    },
    localDatabase: {
      getScanJob: () => ({
        status: "complete",
        selectedCycleData: {
          status: "PENDING_SETTLEMENT",
          calculationMessage,
          clearanceMessage: null,
        },
        result: { expenses: [{ id: "receipt-1", date: "2026-10-02", paidBy: "Alex", merchant: "Market", amount: 10, category: "Groceries" }] },
        reconciliation: { failed: 0, queued: 0 },
      }),
    },
    imageLoader: async () => ({ buffer: Buffer.from("image"), mimetype: "image/jpeg" }),
    client: {
      select: async (table) => table === "periods"
        ? [{ id: "p", status: "CURRENT", start_date: "2026-10-01", end_date: "2026-10-31" }]
        : [],
      upload: async () => {},
      update: async (table, filters, body) => table === "sync_requests" ? [{ id: "job", ...body }] : [],
      rpc: async (name, body) => {
        rpcCalls.push({ name, body });
        return name === "finalize_sync_request" ? { result_summary: "done" } : null;
      },
    },
  });
  const result = await worker.processClaimedJob({ id: "11111111-1111-4111-8111-111111111111" }, { assert() {} });
  assert.equal(result.finalized, true);
  assert.deepEqual(rpcCalls.map((call) => call.name), ["record_period_cycle_state", "finalize_sync_request"]);
  assert.equal(rpcCalls[0].body.p_cycle_status, "PENDING_SETTLEMENT");
  assert.deepEqual(rpcCalls[0].body.p_calculation_message, calculationMessage);
  assert.equal(rpcCalls[0].body.p_clearance_message, null);
});

test("settlement totals use cents, stable members, and exclude transfer proofs", () => {
  const settlement = settlementForReceipts([
    { id: "a", amount_cents: 101, payer: "Alex", merchant: "Shop", date: "2026-10-01", is_excluded: false },
    { id: "b", amount_cents: 100, payer: "Jamie", merchant: "Market", date: "2026-10-02", is_excluded: false },
    { id: "transfer", amount_cents: 5000, payer: "Jamie", merchant: "Bank Transfer", date: "2026-10-03", is_excluded: true },
  ], ["Alex", "Jamie", "Taylor"]);

  assert.equal(settlement.totalCents, 201);
  assert.equal(settlement.perPersonCents, 67);
  assert.deepEqual(settlement.memberTotals, { Alex: 101, Jamie: 100, Taylor: 0 });
  assert.equal(settlement.receiptCount, 2);
});

test("a verified clearance rolls forward before November receipts are scanned", async () => {
  const rpcCalls = [];
  let preparedContext = null;
  const clearance = {
    id: "clearance-31-oct", text: "Clear up to date", timestamp: 1793449800,
    source: "marker", confidence: "HIGH",
  };
  const startBoundary = { ...clearance, dateStr: "2026-10-31" };
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: true,
    workerId: "rollover-worker",
    contract: {
      approved: true,
      value: {
        members: ["Alex", "Jamie", "Morgan", "Taylor"], aliases: {},
        shareRounding: "floor", settlementIdMode: "existing-only", zeroAmountPolicy: "preserve",
      },
    },
    groupId: "fixture-group",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [
        { id: "cycle_current", status: "ACTIVE", settlementConfirmed: false, startDate: "2026-10-31", endDate: null, startBoundary },
        { id: "cycle_hist_1", status: "SETTLED", settlementConfirmed: true, startDate: "2026-09-01", endDate: "2026-10-31", startBoundary: { id: "old-start" }, endBoundary: startBoundary, clearanceMessage: clearance },
      ],
      prepare: async (context) => {
        preparedContext = context;
        return { jobId: "local-rollover", expectedImages: 1, status: "queued" };
      },
      runAndGet: async () => {},
    },
    localDatabase: {
      getScanJob: () => ({
        status: "complete",
        selectedCycleData: { status: "ACTIVE", calculationMessage: null, clearanceMessage: null },
        result: { expenses: [{ id: "nov-2", date: "2026-11-02T01:00:00Z", paidBy: "Jamie", merchant: "November Market", amount: 4, category: "Groceries" }] },
        reconciliation: { failed: 0, queued: 0 },
      }),
    },
    imageLoader: async () => ({ buffer: Buffer.from("image"), mimetype: "image/jpeg" }),
    client: {
      select: async (table, query = {}) => {
        if (table === "periods" && query.id === "eq.period_2026-10-31")
          return [{ id: "period_2026-10-31", status: "CURRENT", start_date: "2026-10-31", end_date: null }];
        if (table === "periods")
          return [{ id: "period_2026-10-10", status: "CURRENT", start_date: "2026-10-10", end_date: "2026-10-31" }];
        return [];
      },
      upload: async () => {},
      update: async (table, filters, body) => table === "sync_requests" ? [{ id: "job", ...body }] : [],
      rpc: async (name, body) => {
        rpcCalls.push({ name, body });
        return name === "finalize_sync_request" ? { result_summary: "done" } : {};
      },
    },
  });
  await worker.processClaimedJob({ id: "11111111-1111-4111-8111-111111111111" }, { assert() {} });
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "rollover_settlement_period", "record_period_cycle_state", "finalize_sync_request",
  ]);
  assert.equal(rpcCalls[0].body.p_old_period_id, "period_2026-10-10");
  assert.equal(rpcCalls[0].body.p_new_period_id, "period_2026-10-31");
  assert.equal(rpcCalls[0].body.p_new_settlement_id, "settlement_2026-10-31_current");
  assert.equal(preparedContext.startDate, "2026-10-31");
  assert.equal(preparedContext.cycleBoundaryId, "clearance-31-oct");
  assert.equal(rpcCalls[2].body.p_period_id, "period_2026-10-31");
});

test("REST client sends conditional updates used for lease renewals", async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: "https://example.supabase.co",
    key: "server-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify([{ id: "job-1", status: "processing" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const rows = await client.update(
    "sync_requests",
    { id: "eq.job-1", status: "eq.pending" },
    { status: "processing", stage: "claimed" },
  );

  assert.equal(rows[0].status, "processing");
  assert.match(calls[0].url, /sync_requests\?id=eq\.job-1&status=eq\.pending/);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.headers.Prefer, "return=representation");
});

test("REST client calls the database claim RPC instead of a select-then-update race", async () => {
  const calls = [];
  const client = new SupabaseRestClient({
    url: "https://example.supabase.co",
    key: "server-key",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify([{ id: "job-1", status: "processing" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const rows = await client.rpc("claim_sync_request", {
    p_worker_id: "worker-1",
    p_requested_by: "netlify-app",
    p_lease_seconds: 900,
  });

  assert.equal(rows[0].id, "job-1");
  assert.match(calls[0].url, /rest\/v1\/rpc\/claim_sync_request$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    p_worker_id: "worker-1",
    p_requested_by: "netlify-app",
    p_lease_seconds: 900,
  });
});

test("Supabase REST and Storage use the correct headers for modern secret and legacy JWT keys", async () => {
  const credentials = [
    { key: "sb_secret_modern-fixture", bearer: false },
    { key: "eyJhbGciOiJIUzI1NiJ9.legacy-service-role-fixture", bearer: true },
  ];

  for (const credential of credentials) {
    const calls = [];
    const client = new SupabaseRestClient({
      url: "https://example.supabase.co",
      key: credential.key,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response(String(url).includes("/storage/v1/") ? "{}" : "[]", { status: 200 });
      },
    });

    await client.select("sync_requests", { limit: 0 });
    await client.upload("period/receipt.jpg", Buffer.from("image"), "image/jpeg");

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.options.headers.apikey, credential.key);
      if (credential.bearer)
        assert.equal(call.options.headers.Authorization, `Bearer ${credential.key}`);
      else
        assert.equal("Authorization" in call.options.headers, false);
    }
  }
});

test("modern Supabase secret keys take precedence and are redacted from failures", async () => {
  assert.equal(resolveSupabaseServerKey({
    SUPABASE_SECRET_KEY: "sb_secret_preferred",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-fallback",
  }), "sb_secret_preferred");
  assert.equal(resolveSupabaseServerKey({ SUPABASE_SERVICE_ROLE_KEY: "legacy-only" }), "legacy-only");

  const secret = "sb_secret_must-not-appear-in-logs";
  const client = new SupabaseRestClient({
    url: "https://example.supabase.co",
    key: secret,
    fetchImpl: async () => new Response(JSON.stringify({ message: `invalid ${secret}` }), { status: 401 }),
  });
  await assert.rejects(
    () => client.select("sync_requests"),
    (error) => !error.message.includes(secret) && error.message.includes("[REDACTED]"),
  );

  const transportClient = new SupabaseRestClient({
    url: "https://example.supabase.co",
    key: secret,
    fetchImpl: async () => { throw new Error(`transport rejected ${secret}`); },
  });
  await assert.rejects(
    () => transportClient.upload("period/receipt.jpg", Buffer.from("image"), "image/jpeg"),
    (error) => !error.message.includes(secret) && error.message.includes("[REDACTED]"),
  );
});

test("Supabase worker requires the additive lease columns", () => {
  assert.deepEqual(REQUIRED_COLUMNS.sync_requests.slice(-4), [
    "worker_id",
    "lease_expires_at",
    "attempt_count",
    "claimed_at",
  ]);
});

test("dry-run verifies configuration without claiming or writing jobs", async () => {
  let rpcCalls = 0;
  let updateCalls = 0;
  const worker = createSupabaseWorker({
    mode: "dry-run",
    client: {
      columns: {},
      verifySchema: async () => {},
      rpc: async () => {
        rpcCalls++;
        throw new Error("claim must not run in dry-run");
      },
      update: async () => {
        updateCalls++;
        throw new Error("update must not run in dry-run");
      },
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  await worker.tick();
  assert.equal(worker.schemaVerified, true);
  assert.equal(rpcCalls, 0);
  assert.equal(updateCalls, 0);
});

test("live mode without both explicit confirmations cannot claim jobs", async () => {
  let claims = 0;
  for (const approvals of [{}, { schemaApproved: SCHEMA_APPROVAL }, { writeApproval: WRITE_APPROVAL }]) {
    const worker = createSupabaseWorker({
      mode: "live", ...approvals,
      client: { verifySchema: async () => {}, rpc: async () => { claims++; } },
      getConnection: () => ({ client: {}, clientStatus: "READY", geminiApiKeys: ["fixture-key"] }),
      logger: { log() {}, warn() {}, error() {} },
    });
    await worker.tick();
  }
  assert.equal(claims, 0);
});

test("a lost job lease stops processing before receipt writes", async () => {
  let scans = 0;
  const worker = createSupabaseWorker({
    mode: "live", schemaApproved: SCHEMA_APPROVAL, writeApproval: WRITE_APPROVAL,
    contract: { approved: true },
    transactionalWrites: false,
    client: {
      verifySchema: async () => {},
      rpc: async (name) => name === "instabox_worker_capabilities" ? { version: 5, writes_enabled: true } : [{ id: "recovered", lease_expires_at: new Date(Date.now() + 60000).toISOString() }],
      select: async () => [{ id: "p", status: "CURRENT", start_date: "2026-10-01", end_date: "2026-10-31" }],
      update: async () => [],
      insert: async () => { throw new Error("no insert should occur after lease loss"); },
    },
    groupId: "fixture-group",
    getConnection: () => ({ client: {}, clientStatus: "READY", geminiApiKeys: ["fixture-key"] }),
    scanManager: { prepare: async () => { scans++; } },
    logger: { log() {}, warn() {}, error() {} },
  });
  await worker.tick();
  assert.equal(scans, 0);
});

test("WhatsApp session ownership prevents two local clients sharing a profile", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "splitmate-lock-"));
  const first = new WhatsAppSessionLock(directory, "first").acquire();
  try {
    assert.throws(
      () => new WhatsAppSessionLock(directory, "second").acquire(),
      /already owned by first/,
    );
  } finally {
    first.release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
