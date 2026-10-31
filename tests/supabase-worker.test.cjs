const test = require("node:test");
const assert = require("node:assert/strict");

const {
  centsFromAmount,
  validateReceipt,
  settlementForReceipts,
  SupabaseRestClient,
} = require("../server/services/supabase-worker.cjs");

test("Supabase receipt validation preserves Muse's cent and category rules", () => {
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

test("REST client sends conditional updates used for atomic job claims", async () => {
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
