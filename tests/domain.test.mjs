import test from "node:test";
import assert from "node:assert/strict";
import {
  calculate,
  needsReview,
  mergeReceipts,
  flagDuplicates,
  report,
  calculationReport,
} from "../public/js/domain.mjs";
const receipt = (id, paidBy, amount, extra = {}) => ({
  id,
  paidBy,
  amount,
  merchant: "Store",
  date: "2026-09-10",
  ...extra,
});
test("one cent across three people balances exactly", () => {
  const r = calculate([receipt("1", "C", 0.01)], ["A", "B", "C"]);
  assert.equal(
    r.balances.reduce((s, b) => s + b.net, 0),
    0,
  );
  assert.deepEqual(
    r.transfers.map(({ from, to, amount }) => ({ from, to, amount })),
    [{ from: "A", to: "C", amount: 0.01 }],
  );
});
test("people who paid nothing still owe their share", () => {
  const r = calculate([receipt("1", "A", 100)], ["A", "B", "C", "D"]);
  assert.equal(r.share, 25);
  assert.equal(r.transfers.length, 3);
  assert.equal(
    r.transfers.reduce((s, t) => s + t.amount, 0),
    75,
  );
});
test("excluded receipt does not contribute to totals or review blockers", () => {
  const r = calculate(
    [
      receipt("1", "A", 100),
      receipt("2", "B", 50, { isExcluded: true, needsReview: true }),
    ],
    ["A", "B"],
  );
  assert.equal(r.total, 100);
  assert.equal(r.reviewCount, 0);
});
test("financial reconciliation holds for many cent amounts", () => {
  for (let cents = 1; cents < 500; cents++) {
    const r = calculate(
      [receipt("a", "A", cents / 100), receipt("b", "B", 1.37)],
      ["A", "B", "C", "D"],
    );
    const remaining = Object.fromEntries(
      r.balances.map((b) => [b.name, b.net]),
    );
    for (const t of r.transfers) {
      remaining[t.from] += Math.round(t.amount * 100);
      remaining[t.to] -= Math.round(t.amount * 100);
    }
    assert.ok(Object.values(remaining).every((n) => n === 0));
  }
});
test("uncertain receipts must be confirmed, missing amount cannot be confirmed away", () => {
  assert.equal(needsReview(receipt("1", "A", 5, { confidence: "LOW" })), true);
  assert.equal(
    needsReview(receipt("1", "A", 5, { confidence: "LOW", reviewed: true })),
    false,
  );
  assert.equal(needsReview(receipt("1", "A", 0, { reviewed: true })), true);
});
test("transfer proofs between personal accounts are reviewed, then ignored", () => {
  const transfer = receipt("1", "A", 0, {
    isBankTransfer: true,
    isExcluded: true,
    needsReview: true,
  });
  assert.equal(needsReview(transfer), true);
  const r = calculate([transfer], ["A", "B"]);
  assert.equal(r.total, 0);
  assert.equal(r.reviewCount, 1);
  assert.equal(
    needsReview({ ...transfer, reviewed: true }),
    false,
    "confirming the transfer clears its review flag",
  );
});
test("calculation report follows the household's chat format", () => {
  const expenses = [
    receipt("1", "Shiva Kafle", 11.14, { date: "2026-10-01" }),
    receipt("2", "Shiva Kafle", 8.1, { date: "2026-10-02" }),
    receipt("3", "Arjun Bhurtel", 25.38, { date: "2026-10-01" }),
    receipt("4", "Arpan Bhurtel", 0, { isBankTransfer: true }),
  ];
  const text = calculationReport(
    expenses,
    calculate(expenses, [
      "Shiva Kafle",
      "Arjun Bhurtel",
      "Arpan Bhurtel",
      "Swasti Adhikari",
    ]),
  );
  assert.match(text, /Shiva ==\n11\.14\+8\.1=19\.24/);
  assert.match(text, /Arjun ==\n25\.38=25\.38/);
  assert.match(text, /Arpan ==\n0/);
  assert.match(text, /Total ==\n25\.38\+0\+19\.24\+0=44\.62/);
  assert.match(text, /\$11\.15 each/);
});
test("rescanning preserves manually corrected receipts and deduplicates stream", () => {
  const old = receipt("a", "A", 12);
  const r = mergeReceipts(
    [old],
    [receipt("a", "A", 99), receipt("b", "B", 4), receipt("b", "B", 4)],
  );
  assert.equal(r.length, 2);
  assert.equal(r[0].amount, 12);
});
test("matching merchant, date and amount flags a possible duplicate", () => {
  const r = flagDuplicates([receipt("a", "A", 10), receipt("b", "B", 10)]);
  assert.equal(r[1].isDuplicate, true);
});
test("copying a report never claims unconfirmed payments are complete", () => {
  const work = {
    groupName: "Home",
    startDate: "2026-09-01",
    endDate: "2026-09-10",
    payments: {},
  };
  const text = report(work, calculate([receipt("a", "A", 10)], ["A", "B"]));
  assert.match(text, /pending/);
  assert.doesNotMatch(text, /Clear up to date/);
});
