import { state, emit, persist, hydrate } from "./store.mjs";
import {
  mergeReceipts,
  normaliseReceipt,
  flagDuplicates,
  today,
} from "./domain.mjs";
import { toast } from "./ui.mjs";
export const socket = window.io();
let saveTimer, scanTimer, pendingSync = false;
export function request(event, payload) {
  if (!state.online) {
    toast("The local server is offline. Your draft is still available.");
    return false;
  }
  socket.emit(event, payload);
  return true;
}
function scanWatchdog() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (state.scan?.active) {
      state.error =
        "The scan is taking longer than expected. You can stop it and keep the receipts found so far.";
      emit();
    }
  }, 90000);
}
export function beginScan(context, options) {
  if (state.scan || !state.online || state.status !== "READY" || !state.keys)
    return false;
  state.previous = structuredClone(state.work);
  state.scan = {
    id: crypto.randomUUID(),
    active: true,
    status: "preparing",
    incoming: [],
    context,
    sync: Boolean(options?.sync),
    usedCheckpoint: Boolean(options?.useCheckpoint),
    cycleId: options?.cycleId || null,
    progress: 0,
    message: "Counting receipt images and checking saved results…",
  };
  state.error = "";
  persist();
  scanWatchdog();
  request("scan:prepare", {
    ...context,
    ...options,
    runId: state.scan.id,
    aliases: state.aliases,
    filterMember: "all",
  });
  return true;
}
export function syncReceipts() {
  if (state.archive || state.work.closedAt) return;
  if (state.scan) return toast("Finish or discard the current scan before syncing.");
  if (!state.online) return toast("Start the local server before syncing receipts.");
  if (state.status !== "READY") return toast("Connect WhatsApp in Settings before syncing.");
  if (!state.keys) return toast("Configure receipt recognition in Settings before syncing.");
  const { groupId } = state.work;
  if (!groupId)
    return toast("Choose a household in settlement details before syncing.");
  // Sync means: bring the current settlement cycle up to date. The current
  // cycle starts at the last "clear up to date" message, so find it first.
  pendingSync = true;
  toast("Finding the current settlement cycle…");
  request("detect:cycles", { groupId });
}
export function acceptScan() {
  if (!state.scan || state.scan.active) return;
  const { context, incoming, sync } = state.scan;
  const same = sync
    ? context.groupId === state.work.groupId
    : ["groupId", "startDate", "endDate"].every((k) => context[k] === state.work[k]);
  if (!same) {
    state.work = hydrate({
      ...context,
      expenses: [],
      members: state.work.members,
    });
  } else if (sync && context.startDate < state.work.startDate) {
    // A sync window that reaches further back (the cycle marker sits before
    // the current start) keeps every existing receipt and widens the period.
    state.work.startDate = context.startDate;
  }
  const oldCount = state.work.expenses.length;
  state.work.expenses = flagDuplicates(
    mergeReceipts(state.work.expenses, incoming),
  );
  if (!sync || oldCount !== state.work.expenses.length)
    state.work.payments = {};
  if (sync) state.work.endDate = context.endDate;
  state.scan = null;
  state.error = "";
  persist();
}
export function stopScan() {
  if (!state.scan) return;
  request("scan:cancel", { jobId: state.scan.id });
  clearTimeout(scanTimer);
  state.scan.message = "Cancelling after current image work…";
  persist();
}
export function runPreparedScan() {
  if (state.scan?.status !== "queued") return;
  state.scan.status = "running";
  state.scan.active = true;
  state.scan.message = "Starting receipt recognition…";
  persist();
  scanWatchdog();
  request("scan:run", { jobId: state.scan.id });
}
export function retryFailedImages() {
  const report = state.lastScanReport || state.scan;
  if (!report?.jobId || !report.reconciliation?.failed) return;
  state.scan = {
    id: report.jobId,
    active: true,
    status: "running",
    incoming: [],
    context: report.context,
    sync: Boolean(report.sync),
    progress: 0,
    message: `Retrying ${report.reconciliation.failed} failed images…`,
  };
  state.lastScanReport = null;
  persist();
  scanWatchdog();
  request("scan:retry_failed", { jobId: report.jobId });
}
export function saveHistory(record) {
  if (!request("history:save", record)) return;
  toast("Saving to local history…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    state.error =
      "History save was not confirmed. Check History before retrying. Your browser draft is safe.";
    emit();
  }, 12000);
}
socket.on("connect", () => {
  state.online = true;
  request("history:get");
  request("library:get");
  request("cycles:get");
  request("data:stats");
  request("scan:jobs");
  emit();
});
socket.on("disconnect", () => {
  state.online = false;
  if (state.scan?.active) {
    state.scan.message =
      "The app is reconnecting. This scan continues on the local server.";
    persist();
  }
  emit();
});
socket.on("init:state", (data) => {
  state.status = data.status;
  state.keys = data.keyCount || (data.hasGeminiKey ? 1 : 0);
  state.qr = data.qrDataUrl || "";
  state.aliases = data.config?.aliases || {};
  if (!state.work.groupId) {
    state.work.groupId = data.config?.defaultGroupId || "";
    state.work.groupName =
      data.config?.defaultGroupName || state.work.groupName;
  }
  if (!state.work.members.length)
    state.work.members = [...new Set(Object.values(state.aliases))].filter(
      (n) => typeof n === "string" && n.trim(),
    );
  if (state.status === "READY") request("get:groups");
  persist();
});
socket.on("client:status", (data) => {
  state.status = data.status;
  emit();
});
socket.on("client:ready", () => {
  state.status = "READY";
  state.qr = "";
  request("get:groups");
  emit();
});
socket.on("client:qr", (data) => {
  state.qr = data.dataUrl || data.qrDataUrl || "";
  state.status = "QR";
  emit();
});
for (const event of ["config:keys_updated", "config:key_updated"])
  socket.on(event, (data) => {
    state.keys = data.keyCount || 0;
    toast("Receipt recognition updated.");
    emit();
  });
socket.on("groups:list", (data) => {
  if (data.error) toast(data.error);
  else state.groups = data.groups || [];
  emit();
});
let pendingCycleRun = null;
// Runs the receipt scan for a saved cycle. Detection runs first so the
// volatile cycle id is fresh, then the scan starts with its dates.
export function requestRunCycle(cycleKey) {
  pendingCycleRun = cycleKey;
  state.detecting = true;
  emit();
  request("detect:cycles", { groupId: state.work.groupId, save: true });
}

socket.on("cycles:detected", (data) => {
  state.detectedCycles = Array.isArray(data.cycles) ? data.cycles : [];
  state.cyclesError = data.error || "";
  state.detecting = false;
  if (pendingCycleRun) {
    const key = pendingCycleRun;
    pendingCycleRun = null;
    const record = state.savedCycles.find((c) => c.cycleKey === key);
    if (!record?.detectedId)
      return toast("That cycle could not be located. Run Scan cycles again.");
    if (!beginScan(
      {
        groupId: record.groupId || state.work.groupId,
        groupName: record.groupName || state.work.groupName,
        startDate: record.startDate,
        endDate: record.endDate,
      },
      { cycleId: record.detectedId, useCheckpoint: false },
    ))
      toast("Could not start the scan. Check the WhatsApp connection.");
    return;
  }
  if (pendingSync) {
    pendingSync = false;
    const current = state.detectedCycles.find((c) => c.status === "ACTIVE");
    if (!current) {
      state.error =
        'No "clear up to date" marker was found in this chat, so there is no current cycle to sync. Collect receipts with a custom date range instead.';
      emit();
      return;
    }
    const context = {
      groupId: state.work.groupId,
      groupName: state.work.groupName,
      startDate: current.startDate,
      endDate: current.endDate || today(),
    };
    if (
      !beginScan(context, {
        sync: true,
        cycleId: current.id,
        useCheckpoint: false,
      })
    )
      toast("Could not start the sync. Try Collect receipts instead.");
    return;
  }
  emit();
});
socket.on("data:stats", (data) => {
  state.dataStats = data || null;
  emit();
});
socket.on("data:cleared", (data) => {
  toast(
    data.cleared?.length
      ? `Cleared: ${data.cleared.join(", ")}.`
      : "Nothing to clear.",
  );
});
socket.on("history:list", (data) => {
  state.history = Array.isArray(data.history) ? data.history : [];
  emit();
});
socket.on("library:list", (data) => {
  state.libraryImages = Array.isArray(data.images) ? data.images : [];
  emit();
});
socket.on("cycles:list", (data) => {
  state.savedCycles = Array.isArray(data.cycles) ? data.cycles : [];
  emit();
});
socket.on("cycles:repaired", ({ action }) => {
  toast(
    action === "merge"
      ? "Cycles merged. Scan the merged period to recalculate totals."
      : "Cycle boundaries updated. Scan the affected period to recalculate totals.",
  );
});
socket.on("cycles:repair_error", ({ message }) => {
  state.error = message || "The cycle boundary could not be changed.";
  emit();
});
socket.on("history:saved", ({ record }) => {
  if (record?.id === state.work.id) {
    clearTimeout(saveTimer);
    state.error = "";
    toast("Saved to local history.");
    emit();
  }
});
socket.on("history:error", (data) => {
  clearTimeout(saveTimer);
  state.error =
    data.message || "Could not save local history. Your browser draft is safe.";
  emit();
});
socket.on("scan:progress", (data) => {
  if (!state.scan || (data.runId && data.runId !== state.scan.id))
    return;
  state.scan.progress =
    data.total > 0
      ? Math.min(100, Math.round((data.current / data.total) * 100))
      : 0;
  state.scan.message = data.message || "Reading receipts…";
  scanWatchdog();
  emit();
});
socket.on("scan:estimate", ({ runId, job }) => {
  if (!state.scan || (runId && runId !== state.scan.id) || !job) return;
  state.scan = {
    ...state.scan,
    ...job,
    id: job.jobId || runId,
    status: "queued",
    active: false,
    progress: 0,
  };
  clearTimeout(scanTimer);
  persist();
});
socket.on("scan:job", ({ runId, job, outcomes = [] }) => {
  if (!job || !state.scan || (runId && runId !== state.scan.id)) return;
  const incoming = outcomes
    .map((outcome) => outcome.receipt)
    .filter(Boolean)
    .map(normaliseReceipt);
  state.scan = {
    ...state.scan,
    ...job,
    id: job.jobId || runId,
    incoming: mergeReceipts(state.scan.incoming || [], incoming),
    active: ["preparing", "running"].includes(job.status),
    progress: job.expectedImages
      ? Math.min(100, Math.round((job.completedImages / job.expectedImages) * 100))
      : 0,
  };
  persist();
});
socket.on("scan:jobs", ({ activeJob }) => {
  if (!activeJob || state.scan) return;
  state.scan = {
    ...activeJob,
    id: activeJob.jobId,
    active: activeJob.status === "running",
    incoming: (activeJob.result?.expenses || []).map(normaliseReceipt),
    context: activeJob.context || activeJob.request || {},
    progress: activeJob.expectedImages
      ? Math.round((activeJob.completedImages / activeJob.expectedImages) * 100)
      : 0,
  };
  persist();
});
socket.on("scan:receipt_found", ({ receipt, runId }) => {
  if (!state.scan?.active || !receipt || (runId && runId !== state.scan.id))
    return;
  state.scan.incoming = mergeReceipts(state.scan.incoming, [
    normaliseReceipt(receipt),
  ]);
  persist();
  scanWatchdog();
});
socket.on("scan:complete", (data) => {
  if (!state.scan || (data.runId && data.runId !== state.scan.id))
    return;
  state.scan.incoming = mergeReceipts(
    state.scan.incoming,
    (data.expenses || []).map(normaliseReceipt),
  );
  state.scan.active = false;
  clearTimeout(scanTimer);
  const sync = state.scan.sync;
  const checkpoint =
    data.checkpoint && data.checkpoint.dateStr ? data.checkpoint : null;
  const usedCheckpoint = state.scan.usedCheckpoint;
  const found = state.scan.incoming.length;
  state.lastScanReport = {
    ...(data.job || {}),
    jobId: data.job?.jobId || data.runId || state.scan.id,
    status: data.job?.status || "complete",
    reconciliation: data.reconciliation || data.job?.reconciliation || {},
    context: state.scan.context,
    sync,
  };
  acceptScan();
  if (data.cycleRecord) {
    state.work.cycleKey = data.cycleRecord.cycleKey;
    state.work.cycleProvenance = data.cycleRecord.provenance;
    state.work.cycleCompleteness = data.cycleRecord.completeness;
    persist();
  }
  if (sync) {
    state.work.lastSyncedAt = new Date().toISOString();
    persist();
  }
  if (checkpoint && !state.work.closedAt) {
    // The settlement period reflects the real cycle: since the marker.
    if (usedCheckpoint) state.work.startDate = checkpoint.dateStr;
    state.work.checkpoint = { text: checkpoint.text, dateStr: checkpoint.dateStr };
    persist();
  }
  if (sync) {
    state.filter = "all";
    state.query = "";
    state.page = 1;
    emit();
  }
  request("library:get");
  request("cycles:get");
  location.hash = "receipts";
  toast(
    sync
      ? "Synced through today. Existing edits were preserved."
      : checkpoint && usedCheckpoint
        ? `Scanned after the last marker (${checkpoint.dateStr}). ${found} item${found === 1 ? "" : "s"} ready to review.`
        : "Scan complete. Your receipts are ready to review.",
  );
});
socket.on("scan:error", (data) => {
  if (!state.scan || (data.runId && data.runId !== state.scan.id))
    return;
  state.scan.active = false;
  state.scan.status = "failed";
  state.scan.message = data.message || "The scan failed.";
  clearTimeout(scanTimer);
  state.error = `${data.message || "The scan failed."} Your existing receipts are safe.`;
  persist();
});
socket.on("scan:aborted", ({ runId, job } = {}) => {
  if (state.scan && (!runId || runId === state.scan.id)) {
    state.scan.active = false;
    state.scan.status = "cancelled";
    state.scan.message =
      job?.message || "Scan cancelled. Completed image results were kept.";
    state.scan.reconciliation = job?.reconciliation || state.scan.reconciliation;
    state.error = "";
    persist();
  }
});
