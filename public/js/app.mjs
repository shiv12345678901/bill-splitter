import { state, restore, subscribe, emit } from "./store.mjs";
import { $, esc, date, button, icon } from "./ui.mjs";
import { overview, settlement } from "./views/workspace.mjs";
import { receipts } from "./views/receipts.mjs";
import { cyclesPage } from "./views/cycles.mjs";
import { history, settings, receiptLibrary } from "./views/library.mjs";
import { needsReview } from "./domain.mjs";
import { wireActions } from "./actions.mjs";
import { updateConnection } from "./dialogs.mjs";
const routes = {
  home: overview,
  receipts,
  settlements: settlement,
  cycles: cyclesPage,
  library: receiptLibrary,
  history,
  settings,
};
let contentSignature = "";
const reconciliationCopy = (report = {}) => {
  const skipped = Number(report.skipped) || 0;
  const failed = Number(report.failed) || 0;
  const excluded = Number(report.excluded) || 0;
  return `${Number(report.processed) || 0} processed · ${excluded} excluded · ${failed} failed · ${skipped} skipped`;
};
const reconciliationDetails = (report = {}) => {
  const reasons = Object.entries(report.skippedReasons || {});
  if (!reasons.length) return "";
  return `<ul class="scan-reasons">${reasons
    .map(([reason, count]) => `<li>${esc(reason)} <span>${Number(count) || 0}</span></li>`)
    .join("")}</ul>`;
};
function scanStatusCard(scan) {
  const status = scan.status || (scan.active ? "running" : "partial");
  const estimate = scan.estimate || {};
  const report = scan.reconciliation;
  const progress = scan.expectedImages
    ? Math.round(((scan.completedImages || 0) / scan.expectedImages) * 100)
    : scan.progress || 0;
  const title = {
    preparing: "Preparing scan",
    queued: "Scan ready",
    running: "Collecting receipts",
    partial: "Scan needs attention",
    failed: "Scan failed",
    cancelled: "Scan cancelled",
  }[status] || "Scan status";
  const message =
    status === "queued"
      ? `${estimate.imageCount || 0} images found · ${estimate.cachedImages || 0} already saved · up to ${estimate.maximumApiCalls || 0} recognition requests`
      : report
        ? reconciliationCopy(report)
        : scan.message || "Checking scan status…";
  let actions = "";
  if (status === "queued")
    actions =
      button("Cancel", "stop-scan", "secondary") +
      button("Start scan", "start-scan-job", "primary");
  else if (["preparing", "running"].includes(status))
    actions = status === "running" ? button("Stop scan", "stop-scan", "secondary") : "";
  else {
    if (report?.failed)
      actions += button("Retry failed images", "retry-failed-images", "secondary");
    actions += button("Discard", "discard-scan", "secondary");
    if (scan.incoming?.length)
      actions += button("Keep recovered receipts", "accept-scan", "primary");
  }
  return `<div class="scan-status ${status === "running" ? "is-running" : ""}" role="status" aria-live="polite"><div><div class="scan-heading"><b>${esc(title)}</b><span class="scan-state">${esc(status)}</span></div><p>${esc(message)}</p>${reconciliationDetails(report)}${["preparing", "running"].includes(status) ? `<progress aria-label="Scan progress" value="${progress}" max="100"></progress>` : ""}</div><div class="actions">${actions}</div></div>`;
}
function lastScanCard(report) {
  if (!report?.reconciliation) return "";
  return `<div class="scan-status scan-report"><div><div class="scan-heading"><b>Last scan reconciled</b><span class="scan-state">${esc(report.status || "complete")}</span></div><p>${esc(reconciliationCopy(report.reconciliation))}</p>${reconciliationDetails(report.reconciliation)}</div><div class="actions">${report.reconciliation.failed ? button("Retry failed images", "retry-failed-images", "secondary") : ""}${button("Dismiss", "dismiss-scan-report", "text-button")}</div></div>`;
}
function render() {
  const w = state.work,
    isWorkspace = ["home", "receipts", "settlements"].includes(state.route);
  $("#page-title").textContent = isWorkspace
    ? "Current settlement"
    : state.route === "history"
      ? "History"
      : state.route === "library"
        ? "Receipt library"
        : state.route === "cycles"
          ? "Settlement cycles"
          : "Settings";
  $("#page-subtitle").textContent = isWorkspace
    ? "Shared expenses, simply settled."
    : state.route === "history"
      ? "A record of what you have settled."
      : state.route === "library"
        ? "Everything collected, saved on this computer."
        : state.route === "cycles"
          ? "One scan maps every settlement in the group."
          : "Make yourself at home.";
  $("#workspace-header").hidden = !isWorkspace;
  $("#workspace-name").textContent = w.groupName;
  $("#workspace-period").textContent =
    `${date(w.startDate)} – ${date(w.endDate)}`;
  const marker = $("#workspace-marker");
  if (w.checkpoint?.text) {
    marker.hidden = false;
    marker.textContent = `Cycle started after "${w.checkpoint.text}"`;
  } else {
    marker.hidden = true;
    marker.textContent = "";
  }
  $("#workspace-status").textContent = state.archive
    ? "Saved record"
    : w.closedAt
      ? "Completed"
      : "Draft";
  $("#edit-period").hidden = Boolean(state.archive || w.closedAt);
  $("#collect-header").hidden =
    !isWorkspace || Boolean(state.archive || w.closedAt);
  $("#sync-header").hidden = !isWorkspace || Boolean(state.archive || w.closedAt);
  $("#sync-header").disabled = Boolean(state.scan);
  $("#sync-header").innerHTML = `${icon("sync")}<span class="button-label">${state.scan?.sync && state.scan.active ? "Syncing…" : "Sync receipts"}</span>`;
  $("#sync-header").classList.toggle("is-syncing", Boolean(state.scan?.sync && state.scan.active));
  $("#collect-header").innerHTML = `${icon("plus")}<span class="button-label">Collect receipts</span>`;
  $("#sync-header").title = w.lastSyncedAt
    ? `Last synced ${new Date(w.lastSyncedAt).toLocaleString("en-AU")}. Check for receipts through today.`
    : "Load receipts from the settlement start date through today";
  $("#save-header").hidden =
    !isWorkspace || Boolean(state.archive) || !w.expenses.length;
  $("#save-header").disabled = !state.online;
  $("#server-status").textContent = state.online
    ? "Connected"
    : state.savedAt
      ? "Working offline"
      : "Connecting…";
  $("#connection-dot").classList.toggle("online", state.online);
  const pairing = ["INITIALIZING", "QR", "QR_READY", "AUTHENTICATED"].includes(
    state.status,
  );
  const wa =
    state.status === "READY"
      ? ["good", "Connected"]
      : pairing
        ? ["warn", "Pairing…"]
        : ["", "Not connected"];
  $("#wa-dot").className = `conn-dot ${wa[0]}`;
  $("#wa-status").textContent = wa[1];
  $("#keys-dot").className = `conn-dot ${state.keys ? "good" : state.online ? "warn" : ""}`;
  $("#keys-status").textContent = state.keys
    ? `${state.keys} key${state.keys === 1 ? "" : "s"} ready`
    : state.online
      ? "No API key"
      : "Offline";
  const badge =
    state.status === "READY"
      ? ["good", "WhatsApp connected"]
      : pairing
        ? ["warn", "WhatsApp pairing…"]
        : state.status === "AUTH_FAILURE"
          ? ["warn", "WhatsApp sign-in failed"]
          : state.status === "ERROR"
            ? ["warn", "WhatsApp connection error"]
            : ["idle", "WhatsApp offline"];
  $("#connection-badge").className = `status-pill ${badge[0]}`;
  $("#connection-badge-text").textContent = badge[1];
  $("#save-status").textContent = state.storageError
    ? "Draft not saved"
    : state.savedAt
      ? `Draft saved · ${state.savedAt}`
      : "Local & personal";
  document
    .querySelectorAll("[data-nav]")
    .forEach((a) =>
      a.setAttribute(
        "aria-current",
        a.dataset.nav === (isWorkspace ? "home" : state.route) ? "page" : "false",
      ),
    );
  document
    .querySelectorAll("[data-tab]")
    .forEach((a) =>
      a.setAttribute(
        "aria-current",
        a.dataset.tab === state.route ? "page" : "false",
      ),
    );
  $("#banners").innerHTML =
    `${!state.online ? '<div class="notice">The local server is offline. You can still review receipts, edit expenses and export your workspace.</div>' : ""}${state.storageError ? `<div class="notice warning">${esc(state.storageError)} ${button("Export backup", "export", "text-button")}</div>` : ""}${state.archive ? `<div class="notice">Viewing a saved record. ${button("Return to current settlement", "return-workspace", "text-button")}</div>` : ""}${state.error ? `<div class="notice warning" role="alert">${esc(state.error)}</div>` : ""}${state.scan ? scanStatusCard(state.scan) : lastScanCard(state.lastScanReport)}`;
  $("#restore-previous").hidden = !state.previous || Boolean(state.archive);
  $("#restore-previous").disabled = Boolean(state.scan?.active);
  const step = !w.expenses.length ? "collect" : resultForWorkflow(w).reviewCount ? "review" : "settle";
  const order = ["collect", "review", "settle"];
  document.querySelectorAll("[data-workflow-step]").forEach((el) => {
    const current = el.dataset.workflowStep;
    el.classList.toggle("active", current === step);
    el.classList.toggle("complete", order.indexOf(current) < order.indexOf(step) || (w.closedAt && current === "settle"));
  });
  // Connection progress must not replace an in-progress receipt edit.
  const signature = JSON.stringify([
    state.route,
    w,
    state.archive,
    state.query,
    state.filter,
    state.page,
    state.selected,
    state.online,
    state.status,
    state.keys,
    state.detecting,
    state.route === "history" ? state.history : null,
    state.route === "cycles" ? state.savedCycles : null,
    state.route === "library" ? [state.libraryImages, state.savedCycles] : null,
    state.route === "settings"
      ? [state.status, state.keys, state.online, state.dataStats]
      : null,
  ]);
  if (signature !== contentSignature) {
    const focus = document.activeElement,
      focusId = focus?.id,
      caret = focus?.selectionStart;
    $("#content").innerHTML = routes[state.route]();
    contentSignature = signature;
    if (focusId && document.getElementById(focusId)) {
      document.getElementById(focusId).focus();
      try {
        document.getElementById(focusId).setSelectionRange(caret, caret);
      } catch {}
    }
    if ($("#receipt-search"))
      $("#receipt-search").oninput = (e) => {
        state.query = e.target.value;
        state.page = 1;
        emit();
      };
    if ($("#receipt-filter"))
      $("#receipt-filter").onchange = (e) => {
        state.filter = e.target.value;
        state.page = 1;
        emit();
      };
    if ($("#person-filter"))
      $("#person-filter").onchange = (e) => {
        state.personFilter = e.target.value;
        state.page = 1;
        emit();
      };
    if ($("#appearance")) {
      $("#appearance").value =
        localStorage.getItem("splitmate-appearance") || "system";
      $("#appearance").onchange = (e) => window.setAppearance(e.target.value);
    }
  }
  updateConnection();
}
function resultForWorkflow(workspace) {
  // Keep the progress rail cheap and independent from route rendering.
  const included = workspace.expenses.filter((expense) => !expense.isExcluded && Number(expense.amount) > 0 && expense.paidBy?.trim());
  const reviewCount = workspace.expenses.filter(needsReview).length;
  return { count: included.length, reviewCount };
}
function navigate() {
  state.route = Object.hasOwn(routes, location.hash.slice(1))
    ? location.hash.slice(1)
    : "home";
  render();
  $("#page-title").focus({ preventScroll: true });
}
restore();
subscribe(render);
wireActions();
window.addEventListener("hashchange", navigate);
navigate();

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
