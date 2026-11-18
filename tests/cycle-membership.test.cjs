const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCycleMembership,
  disabledCycleMembers,
  membershipSettlementForReceipts,
} = require("../server/services/cycle-membership.cjs");

const members = ["Shiva Kafle", "Arjun Bhurtel", "Arpan Bhurtel", "Swasti Adhikari"];
const membership = (modes = {}, revision = 1) => ({
  period_id: "period-current",
  revision,
  members: members.map((member_name) => ({
    member_name,
    participation_mode: modes[member_name] || "enabled",
  })),
});
const receipts = [
  { id: "shiva", payer: "Shiva Kafle", amount_cents: 101, is_excluded: false },
  { id: "arjun", payer: "Arjun Bhurtel", amount_cents: 100, is_excluded: false },
  { id: "arpan", payer: "Arpan Bhurtel", amount_cents: 99, is_excluded: false },
  { id: "swasti", payer: "Swasti Adhikari", amount_cents: 98, is_excluded: false },
];

test("all four members are enabled with cent-exact deterministic shares", () => {
  const result = membershipSettlementForReceipts(receipts, membership());
  assert.equal(result.totalCents, 398);
  assert.equal(result.displayEqualShareCents, 100);
  assert.equal(Object.values(result.shareCents).reduce((sum, value) => sum + value, 0), 398);
  assert.equal(Object.values(result.netCents).reduce((sum, value) => sum + value, 0), 0);
});

test("disabled receipts are stored but excluded while keep-receipts payments remain credited", () => {
  const disabled = membership({ "Swasti Adhikari": "disabled" });
  const disabledResult = membershipSettlementForReceipts(receipts, disabled);
  assert.equal(disabledResult.totalCents, 300);
  assert.equal(disabledResult.paidCents["Swasti Adhikari"], 0);
  assert.equal(disabledResult.shareCents["Swasti Adhikari"], 0);
  assert.deepEqual(disabledCycleMembers(normalizeCycleMembership(disabled)), ["Swasti Adhikari"]);

  const kept = membership({ "Swasti Adhikari": "keep_receipts" });
  const keptResult = membershipSettlementForReceipts(receipts, kept);
  assert.equal(keptResult.totalCents, 398);
  assert.equal(keptResult.paidCents["Swasti Adhikari"], 98);
  assert.equal(keptResult.shareCents["Swasti Adhikari"], 0);
});

test("two enabled members can reimburse two keep-receipts members exactly", () => {
  const result = membershipSettlementForReceipts(receipts, membership({
    "Arpan Bhurtel": "keep_receipts",
    "Swasti Adhikari": "keep_receipts",
  }));
  assert.equal(result.shareCents["Arpan Bhurtel"], 0);
  assert.equal(result.shareCents["Swasti Adhikari"], 0);
  assert.equal(result.shareCents["Arjun Bhurtel"] + result.shareCents["Shiva Kafle"], 398);
  assert.equal(Object.values(result.netCents).reduce((sum, value) => sum + value, 0), 0);
});

test("manual exclusions remain excluded after disabling and re-enabling", () => {
  const manuallyExcluded = [{ id: "manual", payer: "Swasti Adhikari", amount_cents: 500, is_excluded: true }];
  assert.equal(membershipSettlementForReceipts(manuallyExcluded, membership({ "Swasti Adhikari": "disabled" })).totalCents, 0);
  assert.equal(membershipSettlementForReceipts(manuallyExcluded, membership()).totalCents, 0);
});

test("zero enabled members and unknown identities fail closed", () => {
  assert.throws(() => normalizeCycleMembership(membership(Object.fromEntries(members.map((name) => [name, "keep_receipts"])))), /ZERO_ENABLED_MEMBERS/);
  assert.throws(() => normalizeCycleMembership({ ...membership(), members: [{ member_name: "Unknown", participation_mode: "enabled" }] }), /unknown household/i);
});
