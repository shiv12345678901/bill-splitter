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

function fakeIntegration({ failInsert = false } = {}) {
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
        if (table === "periods") return [{ id: "p", start_date: "2026-10-01", end_date: "2026-10-31" }];
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
      rpc: async (name) => name === "instabox_worker_capabilities" ? { version: 2, writes_enabled: true } : [{ id: "recovered", lease_expires_at: new Date(Date.now() + 60000).toISOString() }],
      select: async () => [{ id: "p", start_date: "2026-10-01", end_date: "2026-10-31" }],
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
