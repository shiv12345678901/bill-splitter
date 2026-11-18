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
  validateBankTransferEvidence,
  assertReceiptCycleAssignment,
  settlementForReceipts,
  whatsappGroupIdentityHash,
  SupabaseRestClient,
  resolveSupabaseServerKey,
  REQUIRED_COLUMNS,
  createSupabaseWorker,
  SCHEMA_APPROVAL,
  WRITE_APPROVAL,
} = require("../server/services/supabase-worker.cjs");
const { WhatsAppSessionLock, clearStaleChromiumProfileLocks } = require("../server/services/whatsapp-session-lock.cjs");
const timestamp = (value) => Math.floor(Date.parse(value) / 1000);
const membershipResponse = (periodId, members = ["Alex", "Jamie", "Morgan", "Taylor"], revision = 1) => ({
  period_id: periodId,
  revision,
  members: members.map((member_name) => ({ member_name, participation_mode: "enabled" })),
});

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

test("bank-transfer evidence is classified separately without becoming a bill or verified payment", () => {
  const row = validateBankTransferEvidence({
    id: "true_transfer-message",
    date: "2026-10-20T01:02:03.000Z",
    paidBy: "sender",
    isBankTransfer: true,
    transferAmount: 42.55,
    transferRecipient: "Jamie",
    transferReference: "OSKO-123",
    transactionDate: "2026-10-20",
  }, "period_2026-10-01", { sender: "Alex" });
  assert.deepEqual(row, {
    id: "true_transfer-message",
    period_id: "period_2026-10-01",
    source_message_id: "true_transfer-message",
    captured_at: "2026-10-20T01:02:03.000Z",
    sender_name: "Alex",
    recipient_name: "Jamie",
    amount_cents: 4255,
    transfer_date: "2026-10-20",
    reference_number: "OSKO-123",
    evidence_url: null,
    classification: "bank_transfer",
    review_status: "pending",
  });
  assert.throws(() => validateBankTransferEvidence({ ...row, isBankTransfer: false }, "p"), /not classified/i);
  assert.throws(() => validateBankTransferEvidence({
    ...row, isBankTransfer: true, paidBy: "Alex", date: row.captured_at, transactionDate: "2026-02-30",
  }, "p"), /invalid transfer date/i);
});

test("bank evidence uses Sydney period dates and distinguishes unknown from explicit zero", () => {
  const period = { id: "period_2026-10-31", start_date: "2026-10-31", end_date: "2026-11-30" };
  const base = {
    id: "bank-sydney-boundary", isBankTransfer: true, paidBy: "sender",
    date: "2026-10-30T13:00:00.000Z", transactionDate: null, transferAmount: null,
  };
  const unknown = validateBankTransferEvidence(base, period, { sender: "Alex" });
  assert.equal(unknown.amount_cents, null);
  assert.equal(unknown.captured_at, "2026-10-30T13:00:00.000Z");
  assert.throws(
    () => validateBankTransferEvidence({ ...base, transferAmount: 0 }, period, { sender: "Alex" }),
    (error) => error.code === "BANK_EVIDENCE_REVIEW_REQUIRED",
  );
  assert.throws(
    () => validateBankTransferEvidence({ ...base, transactionDate: "2026-04-25", transferAmount: 500 }, period, { sender: "Alex" }),
    (error) => error.code === "BANK_EVIDENCE_DATE_OUTSIDE_PERIOD",
  );
  assert.throws(
    () => validateBankTransferEvidence({ ...base, paidBy: "" }, period, { sender: "Alex" }),
    (error) => error.code === "BANK_EVIDENCE_MISSING_SENDER",
  );
});

test("the November 17 deleted screenshot OCR cannot become financial evidence", () => {
  const period = { id: "period_2026-10-31", start_date: "2026-10-31", end_date: null };
  const incident = {
    id: "false_120363424816420097@g.us_3A48677346BB6FE9253F_60821199667305@lid",
    isBankTransfer: true,
    date: "2026-11-17T06:39:00.000Z",
    paidBy: "",
    transactionDate: "2026-04-25",
    transferAmount: 500,
    amount: 0,
  };
  assert.throws(
    () => validateBankTransferEvidence(incident, period, { sender: "Shiva Kafle" }),
    (error) => error.code === "BANK_EVIDENCE_MISSING_SENDER",
  );
  assert.throws(
    () => validateBankTransferEvidence({ ...incident, paidBy: "sender" }, period, { sender: "Shiva Kafle" }),
    (error) => error.code === "BANK_EVIDENCE_DATE_OUTSIDE_PERIOD",
  );
});

test("immutable boundaries separate receipts on the same Sydney clearance date", () => {
  const clearanceTimestamp = timestamp("2026-10-31T12:30:00Z");
  const beforeTimestamp = clearanceTimestamp - 1;
  const afterTimestamp = clearanceTimestamp + 1;
  const oldStart = {
    id: "configured-october-start",
    timestamp: timestamp("2026-10-09T13:00:00Z") - 1,
  };
  const clearance = { id: "clearance-31-oct", timestamp: clearanceTimestamp };
  const oldPeriod = { id: "period_2026-10-10", start_date: "2026-10-10", end_date: "2026-10-31" };
  const nextPeriod = {
    id: "period_2026-10-31",
    start_date: "2026-10-31",
    end_date: null,
    whatsapp_start_boundary: clearance,
  };
  const oldExpense = { id: "true_oct-before", date: new Date(beforeTimestamp * 1000).toISOString() };
  const nextExpense = { id: "false_nov-after#page1", date: new Date(afterTimestamp * 1000).toISOString() };
  const oldJob = {
    selectedCycleData: {
      id: "cycle_hist_1", startDate: "2026-10-10", endDate: "2026-10-31",
      startBoundary: oldStart, endBoundary: clearance,
    },
    candidates: [{ id: oldExpense.id, timestamp: beforeTimestamp }],
  };
  const nextJob = {
    selectedCycleData: {
      id: "cycle_current", startDate: "2026-10-31", endDate: null,
      startBoundary: clearance, endBoundary: null,
    },
    candidates: [{ id: nextExpense.id, timestamp: afterTimestamp }],
  };

  assert.equal(assertReceiptCycleAssignment({
    expenses: [oldExpense], scanJob: oldJob, period: oldPeriod,
    expectedCycleId: "cycle_hist_1", expectedBoundaryId: oldStart.id,
  }), true);
  assert.equal(assertReceiptCycleAssignment({
    expenses: [nextExpense], scanJob: nextJob, period: nextPeriod,
    expectedCycleId: "cycle_current", expectedBoundaryId: clearance.id,
  }), true);
  assert.throws(() => assertReceiptCycleAssignment({
    expenses: [nextExpense],
    scanJob: { ...oldJob, candidates: [{ id: nextExpense.id, timestamp: afterTimestamp }] },
    period: oldPeriod, expectedCycleId: "cycle_hist_1", expectedBoundaryId: oldStart.id,
  }), /ambiguous|mismatched/i);
  assert.throws(() => assertReceiptCycleAssignment({
    expenses: [oldExpense],
    scanJob: { ...nextJob, candidates: [{ id: oldExpense.id, timestamp: beforeTimestamp }] },
    period: nextPeriod, expectedCycleId: "cycle_current", expectedBoundaryId: clearance.id,
  }), /ambiguous|mismatched/i);
});

test("Sydney midnight and daylight-saving boundary instants remain authoritative", () => {
  for (const fixture of [
    {
      boundary: "2026-10-03T15:59:59Z",
      receipt: "2026-10-03T16:00:00Z",
      date: "2026-10-04",
      id: "true_dst-receipt",
    },
    {
      boundary: "2026-10-31T12:59:59Z",
      receipt: "2026-10-31T13:00:00Z",
      date: "2026-11-01",
      id: "false_midnight-receipt",
    },
  ]) {
    const boundaryTimestamp = timestamp(fixture.boundary);
    const receiptTimestamp = timestamp(fixture.receipt);
    const boundary = { id: `boundary-${fixture.id}`, timestamp: boundaryTimestamp };
    const expense = { id: fixture.id, date: new Date(receiptTimestamp * 1000).toISOString() };
    const scanJob = {
      selectedCycleData: {
        id: "cycle_current", startDate: fixture.date, endDate: null,
        startBoundary: boundary, endBoundary: null,
      },
      candidates: [{ id: fixture.id, timestamp: receiptTimestamp }],
    };
    assert.equal(assertReceiptCycleAssignment({
      expenses: [expense], scanJob,
      period: { id: `period_${fixture.date}`, start_date: fixture.date, end_date: null, whatsapp_start_boundary: boundary },
      expectedCycleId: "cycle_current", expectedBoundaryId: boundary.id,
    }), true);
  }
});

test("cycle assignment is retry-safe and rejects missing or ambiguous evidence", () => {
  const startTimestamp = timestamp("2026-10-31T12:30:00Z");
  const receiptTimestamp = startTimestamp + 10;
  const boundary = { id: "clearance-31-oct", timestamp: startTimestamp };
  const period = { id: "period_2026-10-31", start_date: "2026-10-31", end_date: null, whatsapp_start_boundary: boundary };
  const ids = ["true_message-id", "false_message-id", "true_document-id#page1"];
  const candidates = ids.map((id, index) => ({ id, timestamp: receiptTimestamp + index }));
  const expenses = candidates.map(({ id, timestamp: sentAt }) => ({ id, date: new Date(sentAt * 1000).toISOString() }));
  const scanJob = {
    selectedCycleData: { id: "cycle_current", startDate: "2026-10-31", endDate: null, startBoundary: boundary, endBoundary: null },
    candidates,
  };
  const input = { expenses, scanJob, period, expectedCycleId: "cycle_current", expectedBoundaryId: boundary.id };

  assert.equal(assertReceiptCycleAssignment(input), true);
  assert.equal(assertReceiptCycleAssignment(input), true);
  assert.deepEqual(expenses.map((expense) => expense.id), ids);
  assert.throws(() => assertReceiptCycleAssignment({ ...input, scanJob: { candidates } }), /no immutable/i);
  assert.throws(() => assertReceiptCycleAssignment({ ...input, expenses: [{ id: "missing", date: expenses[0].date }] }), /not an authoritative member/i);
  assert.throws(() => assertReceiptCycleAssignment({
    ...input,
    scanJob: { ...scanJob, candidates: [...candidates, { id: ids[0], timestamp: receiptTimestamp + 99 }] },
  }), /conflicting immutable/i);
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
    loadUserConfig: () => ({ defaultGroupId: "fixture-group@g.us", aliases: { sender: "Alex" } }),
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

test("an existing WhatsApp receipt is never reassigned to another period", async () => {
  const fixture = fakeIntegration();
  fixture.receipts.set("new", {
    id: "new",
    period_id: "historical-period",
    merchant: "Historical edit",
    payer: "Jamie",
    amount_cents: 777,
    date: "2026-09-01",
    is_excluded: true,
    image_url: null,
  });

  await assert.rejects(
    () => fixture.worker.processClaimedJob({ id: "job" }, { assert() {} }),
    /belongs to another period/i,
  );
  assert.equal(fixture.receipts.get("new").period_id, "historical-period");
  assert.equal(fixture.receipts.get("new").merchant, "Historical edit");
  assert.equal(fixture.uploads.length, 0);
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
  let staleLocalBoundary = false;
  const recoveredBoundary = {
    id: "clearance-31-oct",
    timestamp: timestamp("2026-10-31T12:30:00Z"),
    source: "marker",
    confidence: "HIGH",
  };
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: false,
    settlementIdMode: "text",
    groupId: "fixture-group@g.us",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [{
        id: "cycle_current", status: "ACTIVE", startDate: "2026-10-31", endDate: null,
        startBoundary: recoveredBoundary, endBoundary: null,
      }],
      prepare: async (context) => {
        preparedContext = context;
        return { jobId: "recovered-rollover", expectedImages: 0, status: "queued" };
      },
      runAndGet: async () => {},
    },
    localDatabase: {
      getScanJob: () => ({
        status: "complete",
        selectedCycleData: {
          id: "cycle_current", status: "ACTIVE", startDate: "2026-10-31", endDate: null,
          startBoundary: staleLocalBoundary ? { ...recoveredBoundary, id: "stale-boundary" } : recoveredBoundary,
          endBoundary: null,
        },
        candidates: [],
        result: { expenses: [] },
        reconciliation: { failed: 0, queued: 0 },
      }),
    },
    client: {
      select: async (table, query = {}) => {
        if (table === "instabox_rollover_approvals") return [];
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
  assert.equal(preparedContext.cycleBoundaryId, "clearance-31-oct");

  staleLocalBoundary = true;
  await assert.rejects(
    () => worker.processClaimedJob({ id: "stale-job", period_id: "old" }, { assert() {} }),
    /ambiguous or changed WhatsApp start boundary/i,
  );
});

test("transactional publishing records pending-cycle metadata before finalizing receipts", async () => {
  const rpcCalls = [];
  const calculationMessage = { id: "calc-1", text: "Total = 40", timestamp: 1793500000 };
  const startBoundary = {
    id: "start-1",
    timestamp: timestamp("2026-09-30T14:00:00Z") - 1,
    source: "marker",
    confidence: "HIGH",
  };
  const receiptTimestamp = timestamp("2026-10-02T01:00:00Z");
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: true,
    workerId: "test-worker",
    contract: {
      approved: true,
      value: {
        members: ["Alex", "Jamie", "Morgan", "Taylor"],
        aliases: {},
        shareRounding: "round",
        settlementIdMode: "existing-only",
        zeroAmountPolicy: "preserve",
      },
    },
    groupId: "fixture-group@g.us",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [{
        id: "cycle_current",
        status: "ACTIVE",
        settlementConfirmed: false,
        startDate: "2026-10-01",
        endDate: null,
        startBoundary,
      }],
      prepare: async () => ({ jobId: "local", expectedImages: 2, status: "queued" }),
      runAndGet: async () => {},
    },
    localDatabase: {
      getScanJob: () => ({
        status: "complete",
        selectedCycleData: {
          id: "cycle_current",
          startDate: "2026-10-01",
          endDate: null,
          startBoundary,
          endBoundary: null,
          status: "PENDING_SETTLEMENT",
          calculationMessage,
          clearanceMessage: null,
        },
        candidates: [
          { id: "receipt-1", timestamp: receiptTimestamp },
          { id: "bank-1", timestamp: receiptTimestamp + 1 },
        ],
        result: { expenses: [
          { id: "receipt-1", date: new Date(receiptTimestamp * 1000).toISOString(), paidBy: "Alex", merchant: "Market", amount: 10, category: "Groceries" },
          {
            id: "bank-1", date: new Date((receiptTimestamp + 1) * 1000).toISOString(), paidBy: "Jamie",
            merchant: "Bank Transfer", amount: 0, category: "Other", isBankTransfer: true,
            isExcluded: true, needsReview: true, transferAmount: 42.55,
            transferRecipient: "Alex", transferReference: "OSKO-123", transactionDate: "2026-10-02",
          },
        ] },
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
        if (name === "get_settlement_cycle_membership") return membershipResponse(body.p_period_id);
        rpcCalls.push({ name, body });
        return name === "finalize_sync_request" ? { result_summary: "done" } : null;
      },
    },
  });
  const result = await worker.processClaimedJob({ id: "11111111-1111-4111-8111-111111111111" }, { assert() {} });
  assert.equal(result.finalized, true);
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "prepare_instabox_whatsapp_sources", "record_period_cycle_state", "record_whatsapp_bank_evidence", "finalize_sync_request",
  ]);
  assert.deepEqual(rpcCalls[0].body.p_sources, [
    { source_message_id: "receipt-1", source_kind: "receipt", group_identity_hash: whatsappGroupIdentityHash("fixture-group@g.us"), cycle_start_boundary_id: startBoundary.id },
    { source_message_id: "bank-1", source_kind: "bank_evidence", group_identity_hash: whatsappGroupIdentityHash("fixture-group@g.us"), cycle_start_boundary_id: startBoundary.id },
  ]);
  assert.equal(rpcCalls[1].body.p_cycle_status, "PENDING_SETTLEMENT");
  assert.deepEqual(rpcCalls[1].body.p_calculation_message, calculationMessage);
  assert.equal(rpcCalls[1].body.p_clearance_message, null);
  assert.equal(rpcCalls[1].body.p_membership_revision, 1);
  assert.equal(rpcCalls[2].body.p_evidence[0].id, "bank-1");
  assert.equal(rpcCalls[2].body.p_evidence[0].amount_cents, 4255);
  assert.equal(rpcCalls[2].body.p_evidence[0].review_status, "pending");
  assert.equal(rpcCalls[2].body.p_membership_revision, 1);
  assert.deepEqual(rpcCalls[3].body.p_receipts.map((row) => row.id), ["receipt-1"]);
  assert.equal(rpcCalls[3].body.p_membership_revision, 1);
});

function transactionalOwnershipFixture({
  expenses,
  existingReceipts = [],
  existingBankEvidence = [],
  failFinalizeOnce = false,
  changeMembershipDuringScan = false,
}) {
  const receiptRows = new Map(existingReceipts.map((row) => [row.id, { ...row }]));
  const bankRows = new Map(existingBankEvidence.map((row) => [row.id, { ...row }]));
  const rpcCalls = [];
  const uploads = [];
  let shouldFailFinalize = failFinalizeOnce;
  let membershipRevision = 1;
  const startBoundary = {
    id: "ownership-start",
    timestamp: timestamp("2026-09-30T14:00:00Z") - 1,
    source: "marker",
    confidence: "HIGH",
  };
  const candidates = expenses.map((expense) => ({
    id: expense.id,
    timestamp: timestamp(expense.date),
  }));
  const worker = createSupabaseWorker({
    mode: "dry-run",
    transactionalWrites: true,
    workerId: "ownership-worker",
    contract: {
      approved: true,
      value: {
        members: ["Alex", "Jamie", "Morgan", "Taylor"],
        aliases: {},
        shareRounding: "round",
        settlementIdMode: "existing-only",
        zeroAmountPolicy: "preserve",
      },
    },
    groupId: "fixture-group@g.us",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [{
        id: "cycle_current", status: "ACTIVE", settlementConfirmed: false,
        startDate: "2026-10-01", endDate: null, startBoundary,
      }],
      prepare: async () => ({ jobId: "ownership-local", expectedImages: expenses.length, status: "queued" }),
      runAndGet: async () => {
        if (changeMembershipDuringScan) membershipRevision++;
      },
    },
    localDatabase: {
      getScanJob: () => ({
        status: "complete",
        selectedCycleData: {
          id: "cycle_current", status: "ACTIVE", startDate: "2026-10-01", endDate: null,
          startBoundary, endBoundary: null, calculationMessage: null, clearanceMessage: null,
        },
        candidates,
        result: { expenses },
        reconciliation: { failed: 0, queued: 0 },
      }),
    },
    imageLoader: async (expense) => ({ buffer: Buffer.from(`image:${expense.id}`), mimetype: "image/jpeg" }),
    client: {
      select: async (table, query = {}) => {
        if (table === "periods")
          return [{ id: "p", status: "CURRENT", start_date: "2026-10-01", end_date: "2026-10-31", whatsapp_start_boundary: startBoundary }];
        const id = query.id?.slice(3);
        if (table === "receipts") return receiptRows.has(id) ? [receiptRows.get(id)] : [];
        if (table === "whatsapp_bank_transfer_evidence") return bankRows.has(id) ? [bankRows.get(id)] : [];
        return [];
      },
      upload: async (objectPath) => uploads.push(objectPath),
      update: async (table, filters, body) => table === "sync_requests" ? [{ id: "job", ...body }] : [],
      rpc: async (name, body) => {
        if (name === "get_settlement_cycle_membership") return membershipResponse(body.p_period_id, undefined, membershipRevision);
        rpcCalls.push({ name, body });
        if (name === "record_whatsapp_bank_evidence") {
          for (const row of body.p_evidence) {
            if (!bankRows.has(row.id)) bankRows.set(row.id, { ...row });
          }
        }
        if (name === "finalize_sync_request") {
          if (shouldFailFinalize) {
            shouldFailFinalize = false;
            throw new Error("simulated finalization interruption");
          }
          // The production RPC uses ON CONFLICT DO NOTHING, preserving manual edits.
          for (const row of body.p_receipts) {
            if (!receiptRows.has(row.id)) receiptRows.set(row.id, { ...row });
          }
          return { result_summary: "done" };
        }
        return null;
      },
    },
  });
  return { worker, receiptRows, bankRows, rpcCalls, uploads, startBoundary };
}

test("source registration excludes a legacy receipt while finalization retains legacy and new rows", async () => {
  const legacy = {
    id: "legacy-receipt", period_id: "p", source_message_id: null,
    merchant: "Manual merchant", payer: "Jamie", amount_cents: 4321,
    date: "2026-10-02", is_excluded: true, image_url: "storage://bill-evidence/manual.jpg",
  };
  const fixture = transactionalOwnershipFixture({
    existingReceipts: [legacy],
    expenses: [
      { id: "legacy-receipt", date: "2026-10-02T01:00:00Z", paidBy: "Alex", merchant: "OCR overwrite", amount: 10, category: "Groceries" },
      { id: "new-receipt", date: "2026-10-03T01:00:00Z", paidBy: "Alex", merchant: "New market", amount: 20, category: "Groceries" },
    ],
  });

  await fixture.worker.processClaimedJob({ id: "11111111-1111-4111-8111-111111111111" }, { assert() {} });
  const prepare = fixture.rpcCalls.find((call) => call.name === "prepare_instabox_whatsapp_sources");
  const finalize = fixture.rpcCalls.find((call) => call.name === "finalize_sync_request");
  assert.deepEqual(prepare.body.p_sources.map((source) => source.source_message_id), ["new-receipt"]);
  assert.deepEqual(finalize.body.p_receipts.map((row) => row.id), ["legacy-receipt", "new-receipt"]);
  assert.equal(fixture.receiptRows.size, 2);
  assert.equal(fixture.receiptRows.get("legacy-receipt").merchant, "Manual merchant");
  assert.equal(fixture.receiptRows.get("legacy-receipt").is_excluded, true);
});

test("a scan containing only legacy receipts finalizes idempotently without claiming ownership", async () => {
  const fixture = transactionalOwnershipFixture({
    existingReceipts: [{
      id: "legacy-only", period_id: "p", merchant: "Reviewed", payer: "Alex", amount_cents: 1234,
      date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/reviewed.jpg",
    }],
    expenses: [{ id: "legacy-only", date: "2026-10-02T01:00:00Z", paidBy: "Alex", merchant: "OCR", amount: 12.34, category: "Groceries" }],
  });

  await fixture.worker.processClaimedJob({ id: "22222222-2222-4222-8222-222222222222" }, { assert() {} });
  assert.equal(fixture.rpcCalls.some((call) => call.name === "prepare_instabox_whatsapp_sources"), false);
  const finalize = fixture.rpcCalls.find((call) => call.name === "finalize_sync_request");
  assert.deepEqual(finalize.body.p_receipts.map((row) => row.id), ["legacy-only"]);
});

test("a successfully registered new receipt is not registered again on retry", async () => {
  const fixture = transactionalOwnershipFixture({
    expenses: [{ id: "retry-receipt", date: "2026-10-02T01:00:00Z", paidBy: "Alex", merchant: "Market", amount: 10, category: "Groceries" }],
  });
  const job = { id: "33333333-3333-4333-8333-333333333333" };

  await fixture.worker.processClaimedJob(job, { assert() {} });
  await fixture.worker.processClaimedJob(job, { assert() {} });
  assert.equal(fixture.rpcCalls.filter((call) => call.name === "prepare_instabox_whatsapp_sources").length, 1);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === "finalize_sync_request").length, 2);
  assert.equal(fixture.receiptRows.size, 1);
});

test("retry after pending source registration safely completes one receipt", async () => {
  const fixture = transactionalOwnershipFixture({
    failFinalizeOnce: true,
    expenses: [{ id: "pending-receipt", date: "2026-10-02T01:00:00Z", paidBy: "Alex", merchant: "Market", amount: 10, category: "Groceries" }],
  });
  const job = { id: "55555555-5555-4555-8555-555555555555" };

  await assert.rejects(
    () => fixture.worker.processClaimedJob(job, { assert() {} }),
    /simulated finalization interruption/,
  );
  await fixture.worker.processClaimedJob(job, { assert() {} });
  const preparations = fixture.rpcCalls.filter((call) => call.name === "prepare_instabox_whatsapp_sources");
  assert.equal(preparations.length, 2);
  assert.deepEqual(preparations[0].body.p_sources, preparations[1].body.p_sources);
  assert.equal(fixture.receiptRows.size, 1);
});

test("retry after bank evidence insertion neither re-registers nor duplicates evidence", async () => {
  const fixture = transactionalOwnershipFixture({
    failFinalizeOnce: true,
    expenses: [{
      id: "bank-retry", date: "2026-10-02T01:00:00Z", paidBy: "Alex",
      isBankTransfer: true, transferAmount: 25, transactionDate: "2026-10-02",
      transferRecipient: "Jamie", transferReference: "TEST-REFERENCE",
    }],
  });
  const job = { id: "44444444-4444-4444-8444-444444444444" };

  await assert.rejects(
    () => fixture.worker.processClaimedJob(job, { assert() {} }),
    /simulated finalization interruption/,
  );
  await fixture.worker.processClaimedJob(job, { assert() {} });
  assert.equal(fixture.rpcCalls.filter((call) => call.name === "prepare_instabox_whatsapp_sources").length, 1);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === "record_whatsapp_bank_evidence").length, 1);
  assert.equal(fixture.rpcCalls.filter((call) => call.name === "finalize_sync_request").length, 2);
  assert.equal(fixture.bankRows.size, 1);
  assert.equal(fixture.receiptRows.size, 0);
});

test("a concurrent membership revision change aborts before source registration or finalization", async () => {
  const fixture = transactionalOwnershipFixture({
    changeMembershipDuringScan: true,
    expenses: [{ id: "stale-membership", date: "2026-10-02T01:00:00Z", paidBy: "Alex", merchant: "Market", amount: 10, category: "Groceries" }],
  });
  await assert.rejects(
    () => fixture.worker.processClaimedJob({ id: "77777777-7777-4777-8777-777777777777" }, { assert() {} }),
    /STALE_MEMBERSHIP_REVISION/,
  );
  assert.equal(fixture.rpcCalls.some((call) => call.name === "prepare_instabox_whatsapp_sources"), false);
  assert.equal(fixture.rpcCalls.some((call) => call.name === "finalize_sync_request"), false);
  assert.equal(fixture.receiptRows.size, 0);
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

test("equal shares match historical Muse cent rounding", () => {
  const members = ["Alex", "Jamie", "Morgan", "Taylor"];
  const historicalSettlements = [
    { period: "2026-10-10", totalCents: 166720, perPersonCents: 41680 },
    { period: "2026-09-19", totalCents: 121214, perPersonCents: 30304 },
    { period: "2026-08-25", totalCents: 134311, perPersonCents: 33578 },
  ];

  for (const historical of historicalSettlements) {
    const settlement = settlementForReceipts([{
      id: `receipt-${historical.period}`,
      amount_cents: historical.totalCents,
      payer: "Alex",
      merchant: "Historical fixture",
      date: historical.period,
      is_excluded: false,
    }], members);

    assert.equal(settlement.totalCents, historical.totalCents, historical.period);
    assert.equal(settlement.perPersonCents, historical.perPersonCents, historical.period);
    assert.equal(Number.isSafeInteger(settlement.perPersonCents), true, historical.period);
  }
});

test("production four-member aggregate matches the current 74284-cent settlement", () => {
  const members = ["Shiva Kafle", "Arjun Bhurtel", "Arpan Bhurtel", "Swasti Adhikari"];
  const settlement = settlementForReceipts([
    { id: "current-total", amount_cents: 74284, payer: "Shiva Kafle", merchant: "Fixture", date: "2026-11-17", is_excluded: false },
  ], members);
  assert.equal(settlement.totalCents, 74284);
  assert.equal(settlement.perPersonCents, 18571);
  assert.equal(settlement.receiptCount, 1);
  assert.deepEqual(settlement.memberTotals, {
    "Arjun Bhurtel": 0,
    "Arpan Bhurtel": 0,
    "Shiva Kafle": 74284,
    "Swasti Adhikari": 0,
  });
});

test("a verified clearance rolls forward before November receipts are scanned", async () => {
  const rpcCalls = [];
  const reconciliationUpdates = [];
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
        shareRounding: "round", settlementIdMode: "existing-only", zeroAmountPolicy: "preserve",
      },
    },
    groupId: "fixture-group@g.us",
    loadUserConfig: () => ({ aliases: {} }),
    scanManager: {
      detectCycles: async () => [
        { id: "cycle_current", status: "ACTIVE", settlementConfirmed: false, startDate: "2026-10-31", endDate: null, startBoundary },
        { id: "cycle_hist_1", status: "SETTLED", settlementConfirmed: true, startDate: "2026-09-01", endDate: "2026-10-31", startBoundary: { id: "old-start", timestamp: timestamp("2026-08-31T14:00:00Z") - 1 }, endBoundary: startBoundary, clearanceMessage: clearance },
      ],
      prepare: async (context) => {
        preparedContext = context;
        return { jobId: "local-rollover", expectedImages: 1, status: "queued" };
      },
      runAndGet: async () => {},
    },
    localDatabase: {
      purgeDeletedLocalArtifacts: () => true,
      updateDeletionReconciliation: (id, status) => reconciliationUpdates.push({ id, status }),
      getScanJob: () => ({
        status: "complete",
        groupId: "fixture-group@g.us",
        confirmedDeletions: [{
          message_id: "deleted-source", group_id: "fixture-group@g.us",
          evidence_source: "message_revoke_everyone", detected_at: "2026-11-17T07:00:00Z",
          idempotency_key: "whatsapp-delete:deleted-source",
        }],
        selectedCycleData: {
          id: "cycle_current", startDate: "2026-10-31", endDate: null,
          startBoundary, endBoundary: null, status: "ACTIVE",
          calculationMessage: null, clearanceMessage: null,
        },
        candidates: [{ id: "nov-2", timestamp: timestamp("2026-11-02T01:00:00Z") }],
        result: { expenses: [{ id: "nov-2", date: "2026-11-02T01:00:00Z", paidBy: "Jamie", merchant: "November Market", amount: 4, category: "Groceries" }] },
        reconciliation: { failed: 0, queued: 0 },
      }),
    },
    imageLoader: async () => ({ buffer: Buffer.from("image"), mimetype: "image/jpeg" }),
    client: {
      select: async (table, query = {}) => {
        if (table === "instabox_rollover_approvals") return [{
          old_period_id: "period_2026-10-10",
          clearance_message_id: "clearance-31-oct",
          new_period_id: "period_2026-10-31",
        }];
        if (table === "periods" && query.id === "eq.period_2026-10-31")
          return [{ id: "period_2026-10-31", status: "CURRENT", start_date: "2026-10-31", end_date: null, whatsapp_start_boundary: startBoundary }];
        if (table === "periods")
          return [{ id: "period_2026-10-10", status: "CURRENT", start_date: "2026-10-10", end_date: "2026-10-31" }];
        return [];
      },
      upload: async () => {},
      update: async (table, filters, body) => table === "sync_requests" ? [{ id: "job", ...body }] : [],
      rpc: async (name, body) => {
        if (name === "get_settlement_cycle_membership") return membershipResponse(body.p_period_id);
        rpcCalls.push({ name, body });
        if (name === "reconcile_deleted_whatsapp_images") return { outcomes: { "deleted-source": "protected_legacy" } };
        return name === "finalize_sync_request" ? { result_summary: "done" } : {};
      },
    },
  });
  await worker.processClaimedJob({ id: "11111111-1111-4111-8111-111111111111" }, { assert() {} });
  assert.deepEqual(rpcCalls.map((call) => call.name), [
    "rollover_settlement_period", "reconcile_deleted_whatsapp_images", "prepare_instabox_whatsapp_sources", "record_period_cycle_state", "finalize_sync_request",
  ]);
  assert.equal(rpcCalls[0].body.p_old_period_id, "period_2026-10-10");
  assert.equal(rpcCalls[0].body.p_new_period_id, "period_2026-10-31");
  assert.equal(rpcCalls[0].body.p_new_settlement_id, "settlement_2026-10-31_current");
  assert.equal(rpcCalls[0].body.p_clearance_message.dateStr, "2026-10-31");
  assert.equal(rpcCalls[0].body.p_clearance_message.cycle_start_boundary_id, "old-start");
  assert.equal(rpcCalls[0].body.p_clearance_message.group_identity_hash, whatsappGroupIdentityHash("fixture-group@g.us"));
  assert.equal(rpcCalls[0].body.p_start_boundary.group_identity_hash, whatsappGroupIdentityHash("fixture-group@g.us"));
  assert.equal(rpcCalls[1].body.p_deletions[0].cycle_start_boundary_id, "clearance-31-oct");
  assert.equal(rpcCalls[1].body.p_deletions[0].group_identity_hash, whatsappGroupIdentityHash("fixture-group@g.us"));
  assert.deepEqual(reconciliationUpdates, [{ id: "deleted-source", status: "review_required" }]);
  assert.equal(preparedContext.startDate, "2026-10-31");
  assert.equal(preparedContext.cycleBoundaryId, "clearance-31-oct");
  assert.equal(rpcCalls[4].body.p_period_id, "period_2026-10-31");
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
      rpc: async (name) => name === "instabox_worker_capabilities" ? { version: 6, writes_enabled: true } : [{ id: "recovered", lease_expires_at: new Date(Date.now() + 60000).toISOString() }],
      select: async () => [{ id: "p", status: "CURRENT", start_date: "2026-10-01", end_date: "2026-10-31" }],
      update: async () => [],
      insert: async () => { throw new Error("no insert should occur after lease loss"); },
    },
    groupId: "fixture-group@g.us",
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

test("normal Docker restart cleanup removes only stale Chromium locks and preserves LocalAuth", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "splitmate-profile-restart-"));
  const profile = path.join(directory, "session");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Cookies"), "persistent-auth-fixture");
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
    fs.writeFileSync(path.join(profile, name), "stale");
  assert.deepEqual(clearStaleChromiumProfileLocks(directory).sort(), ["SingletonCookie", "SingletonLock", "SingletonSocket"]);
  assert.equal(fs.readFileSync(path.join(profile, "Default", "Cookies"), "utf8"), "persistent-auth-fixture");
  assert.deepEqual(clearStaleChromiumProfileLocks(directory), []);
});
