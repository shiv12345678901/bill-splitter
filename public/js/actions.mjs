import {
  state,
  change,
  persist,
  emit,
  result,
  blank,
  validWork,
  hydrate,
} from "./store.mjs";
import {
  money,
  report,
  calculationReport,
  needsReview,
} from "./domain.mjs";
import { $, dialog, esc, toast, copy, download } from "./ui.mjs";
import {
  collect,
  addReceipt,
  editPeriod,
  connect,
  keys,
  aliases,
} from "./dialogs.mjs";
import {
  request,
  saveHistory,
  acceptScan,
  stopScan,
  syncReceipts,
  beginScan,
  requestRunCycle,
  runPreparedScan,
  retryFailedImages,
} from "./connection.mjs";
import { filteredReceipts } from "./views/receipts.mjs";
import { openLightbox } from "./ui.mjs";
const record = () => ({
  ...state.work,
  totalPool: result().total,
  settlement: result(),
  reportText: report(state.work, result()),
});
const unlocked = () => !state.archive && !state.work.closedAt;
function confirm(title, message, label, fn) {
  dialog(
    title,
    `<p>${esc(message)}</p><footer><button class="primary" type="submit">${label}</button></footer>`,
    (_, root) => {
      fn();
      root.close();
    },
  );
}
function boundaryRepair(action, cycleKey) {
  const cycle = state.savedCycles.find((item) => item.cycleKey === cycleKey);
  if (!cycle) return toast("That cycle is no longer available. Refresh and try again.");
  $("#dialog").close();
  const title = action === "split" ? "Split cycle" : "Correct shared boundary";
  dialog(
    title,
    `<p class="muted">Use the exact WhatsApp message ID for the settlement marker. This makes the boundary stable even if its wording or date display changes.</p><label>Boundary message ID<input name="id" required maxlength="240" spellcheck="false" autocomplete="off"></label><label>Boundary date<input name="dateStr" type="date" required min="2020-01-01" max="2100-12-31"></label><p class="inline-warning">Receipt images are kept, but calculated totals are cleared until the affected cycle is scanned again.</p><footer><button class="primary" type="submit">${action === "split" ? "Split cycle" : "Correct boundary"}</button></footer>`,
    (form, root) => {
      const data = Object.fromEntries(form);
      if (
        request("cycles:repair", {
          action,
          cycleKey,
          boundary: { id: data.id.trim(), dateStr: data.dateStr },
        })
      ) root.close();
    },
  );
}
function repairCycle(cycleKey) {
  const cycle = state.savedCycles.find((item) => item.cycleKey === cycleKey);
  if (!cycle) return toast("That cycle is no longer available. Refresh and try again.");
  dialog(
    "Repair cycle boundaries",
    `<p class="muted">Choose the smallest correction. Saved receipt images are never deleted by these actions.</p>${cycle.provenance?.issues?.length ? `<div class="inline-warning">${esc(cycle.provenance.issues.join(" "))}</div>` : ""}<div class="repair-actions"><button type="button" class="secondary" data-action="cycle-split" data-id="${esc(cycleKey)}">Split at a marker</button><button type="button" class="secondary" data-action="cycle-correct" data-id="${esc(cycleKey)}">Correct next boundary</button><button type="button" class="secondary danger" data-action="cycle-merge" data-id="${esc(cycleKey)}">Merge with next cycle</button></div><p class="muted">Split creates two periods. Correct changes the shared end/start marker. Merge combines this period with the following one.</p>`,
    () => {},
  );
}
const actions = {
  sync: syncReceipts,
  collect,
  add: addReceipt,
  period: editPeriod,
  connect,
  keys,
  aliases,
  "detect-cycles": () => {
    if (!state.online || state.status !== "READY")
      return toast("Connect WhatsApp before scanning cycles.");
    if (!state.keys)
      return toast("Configure receipt recognition before scanning cycles.");
    if (state.scan?.active) return toast("A scan is already running.");
    state.detecting = true;
    emit();
    request("detect:cycles", { groupId: state.work.groupId, save: true });
  },
  "run-cycle-scan": (id, control) => {
    const cycleKey = control?.dataset?.cycle;
    if (!cycleKey) return;
    if (!state.online || state.status !== "READY" || !state.keys)
      return toast(
        "Connect WhatsApp and configure recognition before scanning a cycle.",
      );
    if (state.scan?.active) return toast("A scan is already running.");
    requestRunCycle(cycleKey);
  },
  "repair-cycle": repairCycle,
  "cycle-split": (cycleKey) => boundaryRepair("split", cycleKey),
  "cycle-correct": (cycleKey) => boundaryRepair("correct", cycleKey),
  "cycle-merge": (cycleKey) => {
    $("#dialog").close();
    confirm(
      "Merge these cycles",
      "This combines the selected cycle with the following period. Receipt images are kept, but totals must be recalculated by scanning the merged cycle again.",
      "Merge cycles",
      () => request("cycles:repair", { action: "merge", cycleKey }),
    );
  },
  home: () => (location.hash = "home"),
  receipts: () => (location.hash = "receipts"),
  cycles: () => (location.hash = "cycles"),
  settle: () => (location.hash = "settlements"),
  review: () => {
    state.filter = "review";
    state.query = "";
    state.page = 1;
    state.selected = state.work.expenses.find((e) => needsReview(e))?.id;
    location.hash = "receipts";
    emit();
  },
  "select-receipt": (id) => {
    state.selected = id;
    location.hash = "receipts";
    emit();
  },
  prev: () => {
    state.page = Math.max(1, state.page - 1);
    emit();
  },
  next: () => {
    state.page++;
    emit();
  },
  exclude: (id) => {
    if (!unlocked()) return;
    const e = state.work.expenses.find((e) => e.id === id);
    if (!e) return;
    const before = structuredClone(state.work);
    change(() => (e.isExcluded = !e.isExcluded));
    toast(
      e.isExcluded ? "Receipt excluded from the split." : "Receipt included.",
      () => {
        state.work = before;
        persist();
      },
    );
  },
  "delete-receipt": (id) => {
    if (!unlocked()) return;
    const before = structuredClone(state.work);
    change((w) => (w.expenses = w.expenses.filter((e) => e.id !== id)));
    state.selected = null;
    emit();
    toast("Receipt deleted.", () => {
      state.work = before;
      persist();
    });
  },
  photo: (id) => {
    const list = filteredReceipts();
    const items = list.length ? list : state.work.expenses;
    const found = items.findIndex((e) => e.id === id);
    openLightbox(items, found === -1 ? 0 : found);
  },
  copy: () => copy(report(state.work, result())),
  "copy-calculation": () => copy(calculationReport(state.work.expenses, result())),
  "ack-transfer": (id) => {
    if (!unlocked()) return;
    const e = state.work.expenses.find((e) => e.id === id);
    if (!e || !e.isBankTransfer) return;
    change((w) => {
      const item = w.expenses.find((x) => x.id === id);
      item.reviewed = true;
      item.isExcluded = true;
    }, { financial: false });
    toast("Transfer proof confirmed and kept out of the split.");
  },
  "review-transfers": () => {
    state.filter = "transfers";
    state.query = "";
    state.page = 1;
    state.selected = state.work.expenses.find(
      (e) => e.isBankTransfer && !e.reviewed,
    )?.id;
    location.hash = "receipts";
    emit();
  },
  "clear-data": (id, control) => {
    if (state.scan?.active)
      return toast("Stop the scan before clearing stored data.");
    const scopes = control?.dataset?.scopes || "";
    const all = scopes === "all";
    confirm(
      all ? "Delete everything and start fresh?" : "Clear stored data?",
      all
        ? "All images, scan results, cycle summaries, history and this browser's draft will be deleted. Your WhatsApp pairing is kept. This cannot be undone."
        : "The selected data will be deleted from this computer. This cannot be undone.",
      all ? "Delete everything" : "Clear data",
      () => {
        if (all) {
          try {
            localStorage.clear();
          } catch (e) {}
          if (window.caches)
            caches.keys().then((keys) =>
              Promise.all(keys.map((k) => caches.delete(k))).finally(() =>
                navigator.serviceWorker
                  .getRegistrations()
                  .then((regs) =>
                    Promise.all(regs.map((r) => r.unregister())).finally(() =>
                      location.reload(),
                    ),
                  ),
              ),
            );
          request("data:clear", {
            scopes: ["ocrCache", "library", "images", "cycles", "history"],
          });
          setTimeout(() => location.reload(), 1500);
          return;
        }
        request("data:clear", { scopes: scopes.split(",").filter(Boolean) });
      },
    );
  },
  payment: (id) => {
    if (!unlocked() || result().reviewCount) return;
    const transfer = result().transfers.find((t) => t.id === id);
    if (!transfer) return;
    if (state.work.payments[id])
      return confirm(
        "Undo payment confirmation",
        "This changes your record only. It does not reverse a bank transfer.",
        "Mark as pending",
        () => change((w) => delete w.payments[id], { financial: false }),
      );
    confirm(
      "Confirm payment",
      `Has ${transfer.from} paid ${money(transfer.amount)} to ${transfer.to}? Confirm only after checking the payment.`,
      "Confirm received",
      () =>
        change((w) => (w.payments[id] = new Date().toISOString()), {
          financial: false,
        }),
    );
  },
  close: () => {
    const r = result();
    if (
      !unlocked() ||
      !r.count ||
      r.reviewCount ||
      state.work.cycleProvenance?.status === "UNRESOLVED" ||
      r.transfers.some((t) => !state.work.payments[t.id])
    )
      return;
    confirm(
      "Close this settlement",
      "All payments are confirmed. Close this period to keep its receipt and payment records together.",
      "Close settlement",
      () => {
        change((w) => (w.closedAt = new Date().toISOString()), {
          financial: false,
        });
        if (state.online) saveHistory(record());
        else
          toast(
            "Closed in this browser. Save to History when the server reconnects.",
          );
      },
    );
  },
  save: () => {
    if (state.archive || !state.work.expenses.length) return;
    saveHistory(record());
  },
  export: () => {
    download(
      `splitmate-${state.work.startDate || "backup"}.json`,
      JSON.stringify({ version: 2, work: state.work }, null, 2),
    );
    toast("Workspace backup exported.");
  },
  import: () => {
    if (state.scan?.active) return toast("Stop the scan before importing.");
    $("#import-file").click();
  },
  new: () => {
    if (state.scan?.active) return;
    confirm(
      "Start a new settlement",
      "Your current workspace will be kept as the previous settlement. Export a backup if you want an additional copy.",
      "Start new settlement",
      () => {
        state.previous = structuredClone(state.work);
        state.work = {
          ...blank(),
          groupId: state.work.groupId,
          groupName: state.work.groupName,
          members: [...state.work.members],
        };
        state.archive = null;
        state.scan = null;
        state.error = "";
        state.selected = null;
        persist();
        location.hash = "home";
      },
    );
  },
  restore: () => {
    if (state.scan?.active || !state.previous) return;
    const current = structuredClone(state.work);
    state.work = state.previous;
    state.previous = current;
    state.archive = null;
    state.error = "";
    state.scan = null;
    persist();
  },
  "refresh-history": () => request("history:get"),
  "refresh-library": () => {
    request("library:get");
    request("cycles:get");
  },
  "open-history": (id) => {
    const h = state.history.find((h) => h.id === id);
    if (!h || state.scan)
      return toast("Finish scan recovery before opening history.");
    if (!state.archive) state.returnWork = structuredClone(state.work);
    state.archive = id;
    state.work = hydrate({
      ...h,
      expenses: h.expenses || [],
      members: h.members || Object.keys(h.settlement?.memberTotals || {}),
    });
    emit();
    location.hash = "settlements";
  },
  "return-workspace": () => {
    if (!state.archive || !state.returnWork) return;
    state.work = state.returnWork;
    state.returnWork = null;
    state.archive = null;
    persist();
    location.hash = "home";
  },
  "accept-scan": () => {
    acceptScan();
    location.hash = "receipts";
  },
  "discard-scan": () => {
    if (state.scan?.active) return;
    state.scan = null;
    state.error = "";
    persist();
  },
  "stop-scan": stopScan,
  "start-scan-job": runPreparedScan,
  "retry-failed-images": retryFailedImages,
  "dismiss-scan-report": () => {
    state.lastScanReport = null;
    persist();
  },
  logout: () => {
    $("#dialog").close();
    confirm(
      "Disconnect WhatsApp",
      "You will need to pair your phone again to collect more receipts. Saved receipts stay on this computer.",
      "Disconnect",
      () => request("whatsapp:logout"),
    );
  },
};
export function wireActions() {
  document.addEventListener("input", (e) => {
    if (!e.target.closest("#receipt-form") || !unlocked()) return;
    state.edits[state.selected] = Object.fromEntries(
      new FormData($("#receipt-form")),
    );
    persist();
    if ($("#edit-draft-status"))
      $("#edit-draft-status").textContent =
        "Unapplied changes saved as a draft.";
  });
  document.addEventListener("click", (e) => {
    const control = e.target.closest("[data-action]");
    if (!control || control.disabled) return;
    const fn = actions[control.dataset.action];
    if (!fn) return;
    if (
      $("#dialog").open &&
      ["add", "connect", "keys"].includes(control.dataset.action)
    )
      $("#dialog").close();
    fn(control.dataset.id, control);
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "receipt-form") return;
    e.preventDefault();
    if (!unlocked()) return;
    const data = Object.fromEntries(new FormData(e.target));
    const receipt = state.work.expenses.find((r) => r.id === state.selected);
    if (!receipt) return;
    if (
      !data.merchant.trim() ||
      !data.paidBy?.trim() ||
      !Number.isFinite(Number(data.amount)) ||
      Number(data.amount) <= 0
    )
      return toast("Enter valid receipt details.");
    delete state.edits[state.selected];
    change(() =>
      Object.assign(receipt, data, {
        merchant: data.merchant.trim(),
        amount: Number(data.amount),
        reviewed: true,
        needsReview: false,
      }),
    );
    toast("Receipt saved. The payment plan has been recalculated.");
  });
  $("#import-file").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("This backup is too large. The limit is 20 MB.");
      const data = JSON.parse(await file.text()),
        work = data.work || data.current;
      if (!validWork(work))
        throw new Error("This file is not a valid SplitMate workspace backup.");
      confirm(
        "Import workspace",
        `${work.expenses.length} receipts will be loaded. Your current settlement remains available through Restore previous.`,
        "Import backup",
        () => {
          state.previous = structuredClone(state.work);
          state.work = hydrate({ ...work.context, ...work });
          state.archive = null;
          state.scan = null;
          state.error = "";
          persist();
          location.hash = "home";
        },
      );
    } catch (err) {
      toast(
        err.message ||
          "Could not read the backup. Your current workspace is unchanged.",
      );
    }
  };
}
