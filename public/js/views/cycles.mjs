import { state, emit } from "../store.mjs";
import { money } from "../domain.mjs";
import { esc, button, date, empty, icon } from "../ui.mjs";

function cycleRow(c, i) {
  const scanned = Boolean(c.scannedAt);
  const unresolved = c.provenance?.status === "UNRESOLVED";
  const completeness = c.completeness || {};
  const label =
    c.status === "ACTIVE"
      ? `Current cycle · since ${date(c.startDate)}`
      : `${date(c.startDate)} – ${date(c.endDate)}`;
  const meta = [
    c.checkpoint ? `Marker "${esc(c.checkpoint.text)}"` : null,
    `${c.groceryCount ?? 0} receipt photo${(c.groceryCount ?? 0) === 1 ? "" : "s"}`,
    c.paymentCount
      ? `${c.paymentCount} transfer proof${c.paymentCount === 1 ? "" : "s"}`
      : null,
    `${completeness.expected ?? 0} expected`,
    `${completeness.processed ?? 0} processed`,
    `${completeness.failed ?? 0} failed`,
    `${completeness.excluded ?? 0} excluded`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="history-row static" style="--index:${Math.min(i, 8)}"><span class="merchant-icon">${icon("calendar")}</span><span><b>${esc(label)}</b><small>${meta}</small>${unresolved ? `<small class="integrity-issue">${esc(c.provenance.issues.join(" · "))}</small>` : ""}</span>${
    scanned
      ? `<span class="badge good-badge">Scanned ${date(c.scannedAt)}</span><strong>${money(c.totals?.totalPool ?? 0)}</strong>`
      : '<span class="badge">Not scanned</span>'
  }<span class="badge ${unresolved ? "warning-badge" : "good-badge"}">${unresolved ? "Boundary review" : "Verified boundaries"}</span><span class="row-actions">${button("Repair", "repair-cycle", "secondary", `data-id="${esc(c.cycleKey)}"`)}${c.detectedId ? button(scanned ? "Scan again" : "Scan receipts", "run-cycle-scan", "secondary", `data-cycle="${esc(c.cycleKey)}"${state.scan?.active ? " disabled" : ""}`) : ""}</span></div>`;
}

export function cyclesPage() {
  const saved = state.savedCycles.filter(
    (c) => !state.work.groupId || c.groupId === state.work.groupId,
  ).sort((a, b) =>
    a.status === "ACTIVE"
      ? -1
      : b.status === "ACTIVE"
        ? 1
        : (b.startDate || "").localeCompare(a.startDate || ""),
  );
  const unresolved = saved.filter((c) => c.provenance?.status === "UNRESOLVED");
  const ready = state.online && state.status === "READY" && Boolean(state.keys);
  const detecting = state.detecting;
  const lastDetect = saved
    .map((c) => c.detectedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  return `<div class="page-intro"><div><h2>Settlement cycles</h2><p>${saved.length ? `${saved.length} saved cycle record${saved.length === 1 ? "" : "s"}. Verified records use immutable WhatsApp marker IDs; flagged records need boundary repair.` : "Run a full scan of the group to map every settlement between its \"clear up to date\" markers."}</p></div>${button(
    detecting
      ? `${icon("sync")}<span>Detecting cycles…</span>`
      : `${icon("sync")}<span>Scan cycles</span>`,
    "detect-cycles",
    `primary with-icon${detecting ? " is-syncing" : ""}`,
    !ready || state.scan?.active ? "disabled" : "",
  )}</div>
  ${unresolved.length ? `<div class="notice warning"><b>${unresolved.length} cycle${unresolved.length === 1 ? " has" : "s have"} unresolved provenance.</b> Review the flagged boundary records before closing a settlement. Saved receipt images have not been deleted.</div>` : ""}
  ${saved.length ? `<section class="panel">${saved.map(cycleRow).join("")}</section>` : empty(
    "No cycles mapped yet",
    ready
      ? 'Run "Scan cycles" to read the group chat and map every settlement cycle.'
      : "Connect WhatsApp and configure receipt recognition first, then run \"Scan cycles\".",
    "",
  )}`;
}
