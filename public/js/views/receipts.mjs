import { state } from "../store.mjs";
import { money, needsReview } from "../domain.mjs";
import { esc, button, date, empty, field, icon } from "../ui.mjs";
export function receiptDetail(e) {
  if (!e)
    return `<div class="detail-placeholder"><span aria-hidden="true">${icon("receipt")}</span><h3>Select a receipt</h3><p>Review its details without leaving the list.</p></div>`;
  const locked = Boolean(state.archive || state.work.closedAt);
  if (!locked && state.edits[e.id]) e = { ...e, ...state.edits[e.id] };
  const image = e.thumbnail || e.photo || "";
  const safeImage =
    /^data:image\/(png|jpeg|webp);base64,/.test(image) ||
    image.startsWith("/api/media?")
      ? image
      : "";
  const transferPending = e.isBankTransfer && !e.reviewed;
  return `<div class="detail-heading"><div><span class="eyebrow">Receipt details</span><h2>${esc(e.merchant)}</h2></div><span class="badge ${needsReview(e) ? "warning" : ""}">${e.isExcluded && !e.isBankTransfer ? "Excluded" : e.isBankTransfer ? "Transfer proof" : needsReview(e) ? "Needs review" : "Included"}</span></div>
  ${safeImage ? `<button class="receipt-image" data-action="photo" data-id="${esc(e.id)}"><img src="${esc(safeImage)}" alt="Receipt from ${esc(e.merchant)}"><span>Open preview ${icon("arrowUpRight")}</span></button>` : '<div class="no-photo">Manually entered · No image attached</div>'}
  ${transferPending ? `<div class="inline-warning">This looks like a money transfer between personal accounts, not a purchase. It stays out of the split. Confirm it, or correct the details below if it is actually a receipt.</div><button class="secondary full" data-action="ack-transfer" data-id="${esc(e.id)}"${locked ? " disabled" : ""}>${icon("check")}<span>It's a transfer — keep it out of the split</span></button>` : needsReview(e) ? '<p class="inline-warning">Check the original, then confirm the details. If this is a duplicate, exclude it from the split.</p>' : ""}
  <form id="receipt-form"><fieldset ${locked ? "disabled" : ""}>${field("Merchant", "merchant", e.merchant, "text", 'required maxlength="120"')}
  <div class="form-row">${field("Amount · AUD", "amount", e.amount || "", "number", 'required min="0.01" max="999999" step="0.01"')}${field("Date", "date", e.date.slice(0, 10), "date", "required")}</div>
  <label>Paid by<select name="paidBy" required><option value="">Choose a person</option>${[...new Set([...state.work.members, e.paidBy].filter(Boolean))].map((n) => `<option ${n === e.paidBy ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
  <label>Category<select name="category">${["Groceries", "Utilities", "Dining", "Household Supplies", "Other"].map((c) => `<option ${e.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
  <small id="edit-draft-status">${state.edits[e.id] ? "Unapplied changes saved as a draft." : ""}</small><button class="primary full" type="submit">${needsReview(e) ? "Confirm details" : "Save changes"}</button></fieldset></form>
  ${!locked ? `<div class="detail-actions">${button(e.isExcluded ? "Include in split" : "Exclude from split", "exclude", "text-button", `data-id="${esc(e.id)}"`)}${button("Delete", "delete-receipt", "text-button danger", `data-id="${esc(e.id)}"`)}</div>` : ""}`;
}
export function filteredReceipts() {
  const query = state.query.trim().toLowerCase();
  return state.work.expenses
    .filter(
      (e) =>
        (!query ||
          `${e.merchant} ${e.paidBy} ${e.category}`
            .toLowerCase()
            .includes(query)) &&
        (state.personFilter === "all" || !state.personFilter
          ? true
          : (e.paidBy || "Unknown payer") === state.personFilter) &&
        (state.filter === "all" ||
          (state.filter === "review"
            ? needsReview(e) || (!e.isExcluded && state.edits[e.id])
            : state.filter === "transfers"
              ? e.isBankTransfer
              : e.isExcluded)),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function payers() {
  return [
    ...new Set(
      state.work.expenses
        .map((e) => e.paidBy || "Unknown payer")
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function receipts() {
  const filtered = filteredReceipts();
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  state.page = Math.min(state.page, pages);
  const slice = filtered.slice((state.page - 1) * 10, state.page * 10);
  const selected = state.work.expenses.find((e) => e.id === state.selected);
  const transfersPending = state.work.expenses.filter(
    (e) => e.isBankTransfer && !e.reviewed,
  ).length;
  const people = payers();
  return `<div class="page-intro"><div><h2>Every expense, accounted for</h2><p>Review uncertain receipts. Excluded items stay here for reference.</p></div>${!state.archive && !state.work.closedAt ? button(`${icon("plus")}<span>Add expense</span>`, "add", "secondary with-icon") : ""}</div>
  ${transfersPending && state.filter !== "transfers" ? `<div class="notice">${transfersPending} transfer proof${transfersPending === 1 ? "" : "s"} between personal accounts ${transfersPending === 1 ? "was" : "were"} left out of the split. ${button("Review transfers", "review-transfers", "text-button")}</div>` : ""}
  <div class="receipt-workspace"><section class="receipt-list panel"><div class="list-toolbar"><label class="search"><span class="sr-only">Search receipts</span><input id="receipt-search" type="search" placeholder="Search receipts or people" value="${esc(state.query)}"></label><label><span class="sr-only">Filter receipts</span><select id="receipt-filter"><option value="all" ${state.filter === "all" ? "selected" : ""}>All receipts</option><option value="review" ${state.filter === "review" ? "selected" : ""}>Needs review</option><option value="transfers" ${state.filter === "transfers" ? "selected" : ""}>Transfers</option><option value="excluded" ${state.filter === "excluded" ? "selected" : ""}>Excluded</option></select></label><label><span class="sr-only">Filter by person</span><select id="person-filter"><option value="all" ${state.personFilter === "all" ? "selected" : ""}>All people</option>${people.map((p) => `<option ${state.personFilter === p ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label></div>
  <div class="receipt-rows">${slice.length ? slice.map((e, i) => `<button class="receipt-summary ${e.id === state.selected ? "selected" : ""}" style="--index:${i}" data-action="select-receipt" data-id="${esc(e.id)}" aria-pressed="${e.id === state.selected}"><span class="merchant-icon">${esc(e.merchant[0]?.toUpperCase())}</span><span><b>${esc(e.merchant)}</b><small>${esc(e.paidBy || "Unknown payer")} · ${date(e.date)}</small></span><span class="amount">${money(e.amount)}<small class="${needsReview(e) ? "review-label" : ""}">${e.isBankTransfer ? "Transfer" : e.isExcluded ? "Excluded" : needsReview(e) ? "Needs review" : esc(e.category)}</small></span></button>`).join("") : empty("No receipts found", state.work.expenses.length ? "Try another search or filter." : "Collect receipts from WhatsApp or add an expense.")}</div>
  <footer class="pagination"><span>${filtered.length} receipts</span><div>${button(icon("chevronLeft"), "prev", "icon-button", `aria-label="Previous page" ${state.page === 1 ? "disabled" : ""}`)}<span>${state.page} of ${pages}</span>${button(icon("chevronRight"), "next", "icon-button", `aria-label="Next page" ${state.page === pages ? "disabled" : ""}`)}</div></footer></section><aside class="receipt-detail panel" aria-label="Receipt detail">${receiptDetail(selected)}</aside></div>`;
}
