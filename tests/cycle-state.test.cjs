const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSettlementCycles,
  isExplicitClearanceMessage,
  sydneyDate,
  sydneyStartTimestamp,
  selectCycleForPeriod,
  planPeriodRollover,
} = require("../server/services/cycle-state.cjs");
const { migrateCycle } = require("../server/services/cycle-integrity.cjs");

const ts = (value) => Math.floor(new Date(value).getTime() / 1000);
const message = (id, timestamp, body = "", extra = {}) => ({ id, timestamp: ts(timestamp), body, ...extra });
const detect = (messages, options = {}) => buildSettlementCycles({
  groupId: "household@g.us",
  configuredGroupStart: "2026-09-01",
  nowTs: ts("2026-10-31T01:00:00Z"),
  messages,
  ...options,
});

test("a calculation creates an open pending-settlement cycle and keeps later transfer evidence in it", () => {
  const cycles = detect([
    message("grocery", "2026-10-01T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
    message("calculation", "2026-10-02T01:00:00Z", "Arjun = 40\nArpan = 20\nTotal = 60\n$15 each"),
    message("transfer", "2026-10-03T01:00:00Z", "", { isMedia: true, classification: "bank_transfer" }),
  ]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].status, "PENDING_SETTLEMENT");
  assert.equal(cycles[0].endDate, null);
  assert.equal(cycles[0].settlementConfirmed, false);
  assert.deepEqual(cycles[0].paymentMessages.map((item) => item.id), ["transfer"]);
});

test("only an explicit clearance closes the pending cycle and starts a new active cycle", () => {
  const cycles = detect([
    message("calculation", "2026-10-02T01:00:00Z", "Arjun = 40\nArpan = 20\nTotal = 60"),
    message("transfer", "2026-10-03T01:00:00Z", "", { isMedia: true, classification: "bank_transfer" }),
    message("clearance", "2026-10-04T01:00:00Z", "All cleared up to today"),
    message("next-grocery", "2026-10-05T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
  ]);
  assert.equal(cycles[0].status, "ACTIVE");
  assert.deepEqual(cycles[0].groceryMessages.map((item) => item.id), ["next-grocery"]);
  assert.equal(cycles[1].status, "SETTLED");
  assert.equal(cycles[1].settlementConfirmed, true);
  assert.deepEqual(cycles[1].paymentMessages.map((item) => item.id), ["transfer"]);
});

test("an explicit clearance without a calculation still closes exactly one cycle", () => {
  const cycles = detect([
    message("grocery", "2026-10-02T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
    message("clearance", "2026-10-04T01:00:00Z", "Clear till today"),
  ]);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[1].status, "SETTLED");
  assert.equal(cycles[1].calculationMessage, null);
});

test("a Supabase period must map to exactly one non-overlapping WhatsApp cycle", () => {
  const cycles = detect([
    message("clearance", "2026-10-04T01:00:00Z", "All settled"),
  ]);
  assert.equal(selectCycleForPeriod(cycles, "2026-10-05").id, "cycle_current");
  assert.equal(selectCycleForPeriod([
    ...cycles,
    { ...cycles[0], id: "overlap" },
  ], "2026-10-05"), null);
});

test("repeated calculations do not create cycles and the latest one is authoritative", () => {
  const cycles = detect([
    message("calc-old", "2026-10-02T01:00:00Z", "Arjun = 10\nArpan = 10\nTotal = 20"),
    message("calc-new", "2026-10-03T01:00:00Z", "Arjun = 20\nArpan = 20\nTotal = 40"),
  ]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].calculationMessage.id, "calc-new");
});

test("message IDs are idempotent and grocery images after calculations remain grocery receipts", () => {
  const duplicate = message("same", "2026-10-03T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" });
  const cycles = detect([
    message("calc", "2026-10-02T01:00:00Z", "Arjun = 20\nArpan = 20\nTotal = 40"),
    duplicate,
    { ...duplicate },
  ]);
  assert.equal(cycles[0].groceryCount, 1);
  assert.equal(cycles[0].paymentCount, 0);
});

test("31 October Sydney clearance rolls the CURRENT period to the open cycle containing 2 November receipts", () => {
  const cycles = detect([
    message("oct-receipt", "2026-10-30T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
    message("oct-clearance", "2026-10-31T12:30:00Z", "Clear up to date"),
    message("nov-receipt", "2026-11-02T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
  ]);
  const plan = planPeriodRollover(cycles, {
    id: "period_2026-10-10",
    status: "CURRENT",
    start_date: "2026-10-10",
    end_date: "2026-10-31",
  });
  assert.equal(plan.action, "rollover");
  assert.equal(plan.closedCycle.endDate, "2026-10-31");
  assert.equal(plan.nextCycle.startDate, "2026-10-31");
  assert.deepEqual(plan.nextCycle.groceryMessages.map((item) => item.id), ["nov-receipt"]);
  assert.equal(plan.newPeriodId, "period_2026-10-31");
  assert.equal(plan.newSettlementId, "settlement_2026-10-31_current");
});

test("a clearance at Sydney midnight rolls the next cycle onto the following local day", () => {
  const cycles = detect([
    message("midnight-clearance", "2026-10-31T12:59:59Z", "All settled"),
    message("after-midnight", "2026-10-31T13:00:01Z", "", { isMedia: true, classification: "grocery_receipt" }),
  ]);
  const plan = planPeriodRollover(cycles, {
    status: "CURRENT", start_date: "2026-10-10", end_date: "2026-10-31",
  });
  assert.equal(plan.nextCycle.startDate, "2026-11-01");
  assert.equal(plan.newPeriodId, "period_2026-11-01");
  assert.deepEqual(plan.nextCycle.groceryMessages.map((item) => item.id), ["after-midnight"]);
});

test("rollover rejects date mismatches, missing next cycles and ambiguous cycle mappings", () => {
  const cycles = detect([
    message("clearance", "2026-10-31T12:30:00Z", "All cleared"),
    message("nov-receipt", "2026-11-02T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
  ]);
  assert.throws(() => planPeriodRollover(cycles, {
    status: "CURRENT", start_date: "2026-10-10", end_date: "2026-11-02",
  }), /end date/i);
  assert.throws(() => planPeriodRollover(cycles.filter((cycle) => cycle.status === "SETTLED"), {
    status: "CURRENT", start_date: "2026-10-10", end_date: "2026-10-31",
  }), /next open/i);
  assert.throws(() => planPeriodRollover([...cycles, { ...cycles[0], id: "duplicate-open" }], {
    status: "CURRENT", start_date: "2026-10-10", end_date: "2026-10-31",
  }), /exactly one|ambiguous/i);
});

test("delayed duplicate clearance messages without intervening cycle activity do not create extra cycles", () => {
  const cycles = detect([
    message("clearance-original", "2026-10-31T12:30:00Z", "Clear up to date"),
    message("clearance-delayed-copy", "2026-11-01T12:30:00Z", "Everything is all settled"),
    message("nov-receipt", "2026-11-02T01:00:00Z", "", { isMedia: true, classification: "grocery_receipt" }),
  ]);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].startBoundary.id, "clearance-original");
  assert.deepEqual(cycles[0].groceryMessages.map((item) => item.id), ["nov-receipt"]);
});

test("out-of-order input is sorted and incomplete history remains explicit", () => {
  const cycles = buildSettlementCycles({
    groupId: "household@g.us",
    messages: [
      message("later", "2026-10-03T01:00:00Z", "", { isMedia: true }),
      message("earlier", "2026-10-01T01:00:00Z", "", { isMedia: true }),
    ],
  });
  assert.equal(cycles[0].startBoundary.source, "history");
  assert.equal(cycles[0].unclassifiedCount, 2);
});

test("future intent is not accepted as a clearance marker", () => {
  assert.equal(isExplicitClearanceMessage("We will clear up to today later"), false);
  assert.equal(isExplicitClearanceMessage("Everything is settled up to today"), true);
  assert.equal(isExplicitClearanceMessage("All cleared, we can start the next cycle"), true);
});

test("Australia/Sydney dates handle daylight saving and UTC day boundaries", () => {
  assert.equal(sydneyDate(ts("2026-10-03T14:30:00Z")), "2026-10-04");
  assert.equal(new Date(sydneyStartTimestamp("2026-10-04") * 1000).toISOString(), "2026-10-03T14:00:00.000Z");
});

test("legacy calculation-boundary cycles migrate to unconfirmed without rewriting data", () => {
  const owes = { Arjun: { Shiva: 1200 } };
  const migrated = migrateCycle({
    groupId: "household@g.us",
    status: "SETTLED",
    owes,
    startBoundary: { id: "calc-1", timestamp: 1, dateStr: "2026-10-01", source: "calculation", confidence: "LOW" },
    endBoundary: { id: "calc-2", timestamp: 2, dateStr: "2026-10-02", source: "calculation", confidence: "LOW" },
  });
  assert.equal(migrated.status, "UNCONFIRMED");
  assert.deepEqual(migrated.owes, owes);
});

test("receipt images cannot trigger calculation or clearance", () => {
  const cycles = detect([
    message("oct-clearance", "2026-10-31T12:30:00Z", "Clear up to date"),
    message(
      "nov-receipt",
      "2026-11-02T05:08:00Z",
      "Arjun = 40\nArpan = 20\nTotal = 60",
      { isMedia: true, classification: "grocery_receipt" }
    ),
    message(
      "image-clearance-caption",
      "2026-11-02T06:00:00Z",
      "All cleared up to today",
      { isMedia: true, classification: "grocery_receipt" }
    ),
  ]);

  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].status, "ACTIVE");
  assert.equal(cycles[0].calculationMessage, null);
  assert.equal(cycles[0].endBoundary, null);
  assert.equal(cycles[1].status, "SETTLED");
  assert.equal(cycles[1].endBoundary.id, "oct-clearance");
});
