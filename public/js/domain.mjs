export const money = (value) =>
  new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(
    Number(value) || 0,
  );
export const today = () => new Date().toLocaleDateString("en-CA");
export const needsReview = (e) =>
  // A transfer proof between personal accounts is kept out of the split, but
  // the owner confirms each one before the settlement can be closed.
  (e.isBankTransfer && !e.reviewed) ||
  (!e.isExcluded &&
    (!(Number(e.amount) > 0) ||
      !e.paidBy?.trim() ||
      (!e.reviewed &&
        (e.needsReview ||
          e.isDuplicate ||
          e.isBlurry ||
          e.confidence === "LOW"))));
export const mergeReceipts = (existing, incoming) => {
  const incomingById = new Map(
    incoming.map((e) => [String(e.id || crypto.randomUUID()), e]),
  );
  // A re-scan repairs items whose image failed to download last time,
  // while every other existing receipt keeps its edits and state.
  const merged = existing.map((e) => {
    const inc = incomingById.get(String(e.id));
    return inc &&
      e.merchant === "Receipt could not be read" &&
      inc.merchant !== "Receipt could not be read"
      ? inc
      : e;
  });
  const seen = new Set(merged.map((e) => e.id));
  return [
    ...merged,
    ...incoming.filter((e) => !seen.has(e.id) && seen.add(e.id)),
  ];
};
export function normaliseReceipt(e) {
  return {
    ...e,
    id: String(e.id || crypto.randomUUID()),
    merchant: String(e.merchant || "Untitled receipt"),
    paidBy: String(e.paidBy || ""),
    amount: Number(e.amount) || 0,
    date: String(e.date || today()),
    category: String(e.category || "Other"),
  };
}
export function flagDuplicates(expenses) {
  return expenses.map((e, i) => ({
    ...e,
    isDuplicate:
      e.isDuplicate ||
      expenses.some(
        (other, j) =>
          j < i &&
          !other.isExcluded &&
          other.amount === e.amount &&
          other.date.slice(0, 10) === e.date.slice(0, 10) &&
          other.merchant.toLowerCase().trim() ===
            e.merchant.toLowerCase().trim(),
      ),
  }));
}
// All arithmetic uses cents. A remaining cent goes to members in stable name order.
export function calculate(expenses, members = []) {
  const active = expenses.filter(
    (e) => !e.isExcluded && Number(e.amount) > 0 && e.paidBy?.trim(),
  );
  const names = [
    ...new Set(
      [...members, ...active.map((e) => e.paidBy)]
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ].sort();
  const paid = Object.fromEntries(names.map((n) => [n, 0]));
  for (const e of active) paid[e.paidBy] += Math.round(Number(e.amount) * 100);
  const total = Object.values(paid).reduce((a, b) => a + b, 0);
  const base = names.length ? Math.floor(total / names.length) : 0;
  const balances = names.map((name, i) => ({
    name,
    paid: paid[name],
    share: base + (i < total % names.length ? 1 : 0),
    net: paid[name] - base - (i < total % names.length ? 1 : 0),
  }));
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ name: b.name, amount: -b.net }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ name: b.name, amount: b.net }))
    .sort((a, b) => b.amount - a.amount);
  const transfers = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const cents = Math.min(debtors[i].amount, creditors[j].amount);
    transfers.push({
      from: debtors[i].name,
      to: creditors[j].name,
      amount: cents / 100,
      id: JSON.stringify([debtors[i].name, creditors[j].name, cents]),
    });
    debtors[i].amount -= cents;
    creditors[j].amount -= cents;
    if (!debtors[i].amount) i++;
    if (!creditors[j].amount) j++;
  }
  return {
    total: total / 100,
    share: base / 100,
    balances,
    transfers,
    reviewCount: expenses.filter(needsReview).length,
    count: active.length,
  };
}
export function report(work, result) {
  return `${work.groupName || "Household"} · ${work.startDate} – ${work.endDate}\n\nTotal: ${money(result.total)}\n${result.balances.map((b) => `${b.name}: paid ${money(b.paid / 100)} · share ${money(b.share / 100)}`).join("\n")}\n\nPayment plan\n${result.transfers.map((t) => `${t.from} → ${t.to}: ${money(t.amount)}${work.payments?.[t.id] ? " · confirmed" : " · pending"}`).join("\n") || "No transfers needed."}\n\n${result.reviewCount ? "Provisional: receipts still need review." : "Payments are only confirmed when manually recorded."}`;
}

// The calculation format the household posts in the chat:
// Shiva ==
// 11.14+8.10+63.45=82.69
//
// Total ==
// 82.69+497.40+167.74+291.82=1,039.25
//
// $259.81 each
export function calculationReport(expenses, result) {
  const fmt = (n) => {
    const fixed = (Math.round(n * 100) / 100).toFixed(2);
    const trimmed = fixed.replace(/\.?0+$/, "");
    return trimmed === "" ? "0" : trimmed;
  };
  const byPerson = {};
  for (const e of expenses) {
    if (e.isExcluded || !(Number(e.amount) > 0) || !e.paidBy?.trim()) continue;
    (byPerson[e.paidBy] ||= []).push(e);
  }
  const lines = [];
  for (const b of result.balances) {
    const chain = (byPerson[b.name] || [])
      .sort((a, c) => String(a.date).localeCompare(String(c.date)))
      .map((e) => fmt(e.amount));
    const first = b.name.split(" ")[0];
    lines.push(
      `${first} ==\n${chain.length ? `${chain.join("+")}=${fmt(b.paid / 100)}` : fmt(b.paid / 100)}`,
    );
  }
  lines.push(
    `Total ==\n${result.balances.map((b) => fmt(b.paid / 100)).join("+")}=${fmt(result.total)}`,
  );
  lines.push(`$${fmt(result.share)} each`);
  return lines.join("\n\n");
}
