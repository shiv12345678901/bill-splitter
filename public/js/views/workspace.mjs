import { state, result } from "../store.mjs";
import { money, needsReview } from "../domain.mjs";
import { esc, button, date, empty, icon } from "../ui.mjs";
export function overview() {
  const w = state.work,
    r = result(),
    pending = r.transfers.filter((t) => !w.payments[t.id]);
  const excluded = w.expenses.length - r.count;
  const confirmed = r.transfers.length - pending.length;
  const next = !r.count
    ? [
        "Add your first receipt",
        "Collect receipts from WhatsApp, or enter an expense yourself.",
        "collect",
        "Collect receipts",
      ]
    : r.reviewCount
      ? [
          `Review ${r.reviewCount} receipt${r.reviewCount === 1 ? "" : "s"}`,
          "Check uncertain amounts and possible duplicates before settling.",
          "review",
          "Review receipts",
        ]
      : [
          "Your payment plan is ready",
          `${pending.length} transfer${pending.length === 1 ? "" : "s"} remaining. Record each payment after it has been made.`,
          "settle",
          "View payment plan",
        ];
  const stat = (label, iconName, value, detail) =>
    `<div class="stat-card" style="--index:${stat.i++}"><div class="stat-head"><span>${label}</span><span class="stat-icon" aria-hidden="true">${icon(iconName)}</span></div><strong>${value}</strong><small>${detail}</small><span class="stat-mark" aria-hidden="true">${icon(iconName)}</span></div>`;
  stat.i = 0;
  return `<div class="stats-grid">${stat(
    "Total expenses",
    "receipt",
    money(r.total),
    `${r.count} included receipt${r.count === 1 ? "" : "s"}${excluded ? ` · ${excluded} excluded` : ""}`,
  )}${stat(
    "Share per person",
    "users",
    money(r.share),
    `Across ${r.balances.length} ${r.balances.length === 1 ? "person" : "people"} · equal split`,
  )}${stat(
    "Still to transfer",
    "send",
    pending.length ? money(pending.reduce((a, t) => a + t.amount, 0)) : "All settled",
    r.transfers.length
      ? `${confirmed} of ${r.transfers.length} payments confirmed`
      : "No transfers needed",
  )}${stat(
    "Needs review",
    "flag",
    r.reviewCount || "All clear",
    r.reviewCount
      ? "Resolve before confirming payments"
      : "No outstanding receipt issues",
  )}</div>
  <section class="next-step"><div><span class="eyebrow">${w.closedAt ? "Completed" : "Next step"}</span><h2>${w.closedAt ? "This settlement is closed" : next[0]}</h2><p>${w.closedAt ? "Payments have been recorded. Your receipts and payment plan remain available below." : next[1]}</p></div>${!w.closedAt ? button(next[3], next[2], "primary") : ""}</section>
  <div class="two-column"><section class="panel"><div class="section-title"><h2>Recent receipts</h2>${w.expenses.length ? `<span class="muted small-note">${w.expenses.length} total</span> ${button(`View all ${icon("arrowRight")}`, "receipts", "text-button")}` : ""}</div>${
    w.expenses.length
      ? [...w.expenses]
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, 5)
          .map(
            (e, i) =>
              `<button class="receipt-summary" style="--index:${Math.min(i, 5)}" data-action="select-receipt" data-id="${esc(e.id)}"><span class="merchant-icon">${esc(e.merchant[0].toUpperCase())}</span><span><b>${esc(e.merchant)}</b><small>${esc(e.paidBy)} · ${date(e.date)}</small></span><span class="amount">${money(e.amount)}<small>${e.isExcluded ? "Excluded" : needsReview(e) ? "Needs review" : "Included"}</small></span></button>`,
          )
          .join("")
      : empty(
          "Everything starts with a receipt",
          "Add shared expenses to see a clear picture of this period.",
          button("Add an expense", "add", "secondary"),
        )
  }</section>
  <section class="panel"><div class="section-title"><h2>Your household</h2>${!state.archive && !w.closedAt ? button("Edit", "period", "text-button") : ""}</div>${
    r.balances.length
      ? r.balances
          .map(
            (b) =>
              `<div class="person-row"><span class="avatar">${esc(
                b.name
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join(""),
              )}</span><span><b>${esc(b.name)}</b><small>Paid ${money(b.paid / 100)}</small></span><span class="amount">${money(b.share / 100)}<small>Share</small></span></div>`,
          )
          .join("")
      : '<p class="muted padded">Add the people sharing these expenses, including anyone who has not paid for a receipt.</p>'
  }</section></div>`;
}
export function settlement() {
  const w = state.work,
    r = result(),
    locked = Boolean(state.archive || w.closedAt);
  if (!r.count)
    return empty(
      "No payment plan yet",
      "Add receipts and household members to calculate who owes whom.",
      button("Add an expense", "add", "primary"),
    );
  const remaining = r.transfers.filter((t) => !w.payments[t.id]);
  const unresolvedCycle = w.cycleProvenance?.status === "UNRESOLVED";
  return `<div class="page-intro"><div><h2>One clear payment plan</h2><p>Equal shares, with balances combined to reduce transfers.</p></div><span class="actions">${button("Copy calculation", "copy-calculation", "primary")}${button("Copy summary", "copy", "secondary")}</span></div>
    ${r.reviewCount ? `<div class="notice warning">${r.reviewCount} receipts need review. This plan is provisional. ${button("Review receipts", "review", "text-button")}</div>` : ""}
    ${unresolvedCycle ? `<div class="notice warning"><b>Cycle boundaries need review.</b> This settlement cannot be closed until its WhatsApp boundary IDs are resolved on the Cycles page. ${button("Open cycles", "cycles", "text-button")}</div>` : ""}
    <section class="panel transfer-panel"><div class="section-title"><h2>${remaining.length ? `${remaining.length} payments remaining` : "All balances settled"}</h2><span class="muted">${money(r.total)} total</span></div>
    ${r.transfers.length ? r.transfers.map((t, i) => `<div class="transfer" style="--index:${i}"><span class="transfer-symbol" aria-hidden="true">${icon("arrowUpRight")}</span><div><b>${esc(t.from)} <span class="muted">pays</span> ${esc(t.to)}</b><small>${w.payments[t.id] ? `Confirmed ${date(w.payments[t.id])}` : "Waiting for payment"}</small></div><strong>${money(t.amount)}</strong>${button(w.payments[t.id] ? `${icon("check")}<span>Paid</span>` : "Confirm payment", "payment", w.payments[t.id] ? "paid secondary with-icon" : "secondary", `data-id="${esc(t.id)}" ${locked || r.reviewCount ? "disabled" : ""}`)}</div>`).join("") : '<p class="padded muted">Everyone has paid their share. No transfers are needed.</p>'}
    <footer class="panel-footer"><p>Confirm only after money has changed hands. This app does not send payments.</p>${!locked ? button("Close settlement", "close", "primary", remaining.length || r.reviewCount || unresolvedCycle ? "disabled" : "") : '<span class="badge">Read-only record</span>'}</footer></section>
    <section class="panel"><div class="section-title"><h2>How the split adds up</h2><span class="muted">AUD · Equal split</span></div><table><thead><tr><th>Person</th><th class="numeric">Paid</th><th class="numeric">Share</th><th class="numeric">Balance</th></tr></thead><tbody>${r.balances.map((b) => `<tr><td>${esc(b.name)}</td><td class="numeric">${money(b.paid / 100)}</td><td class="numeric">${money(b.share / 100)}</td><td class="numeric"><span class="status-pill ${b.net > 0 ? "good" : b.net < 0 ? "warn" : "idle"}">${b.net > 0 ? `Receives ${money(b.net / 100)}` : b.net < 0 ? `Owes ${money(-b.net / 100)}` : "Settled"}</span></td></tr>`).join("")}</tbody></table><p class="padded muted">Any leftover cent is assigned in alphabetical order so the totals always balance exactly.</p></section>`;
}
