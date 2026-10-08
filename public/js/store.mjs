import { normaliseReceipt, today, calculate, needsReview } from "./domain.mjs";
export const KEY = "splitmate-desktop-v2";
export const blank = () => ({
  id: crypto.randomUUID(),
  groupId: "",
  groupName: "My household",
  startDate: today().slice(0, 8) + "01",
  endDate: today(),
  members: [],
  expenses: [],
  payments: {},
  closedAt: null,
});
export const state = {
  work: blank(),
  previous: null,
  returnWork: null,
  scan: null,
  lastScanReport: null,
  online: false,
  status: "DISCONNECTED",
  keys: 0,
  aliases: {},
  groups: [],
  history: [],
  libraryImages: [],
  savedCycles: [],
  detectedCycles: [],
  cyclesError: "",
  detecting: false,
  dataStats: null,
  personFilter: "all",
  qr: "",
  error: "",
  storageError: "",
  savedAt: "",
  archive: null,
  route: "home",
  filter: "all",
  query: "",
  page: 1,
  selected: null,
};
const listeners = new Set();
state.edits = {};
export const subscribe = (fn) => listeners.add(fn);
export const result = () => {
  const calculated = calculate(state.work.expenses, state.work.members);
  if (!state.archive && !state.work.closedAt) {
    calculated.reviewCount = state.work.expenses.filter(
      (e) => (state.edits[e.id] && !e.isExcluded) || needsReview(e),
    ).length;
  }
  return calculated;
};
export function emit() {
  listeners.forEach((fn) => fn());
}
export function validWork(w) {
  return (
    w &&
    typeof w === "object" &&
    Array.isArray(w.expenses) &&
    w.expenses.every(
      (e) =>
        e &&
        typeof e === "object" &&
        Number.isFinite(Number(e.amount)) &&
        Number(e.amount) >= 0,
    ) &&
    (!w.members || Array.isArray(w.members)) &&
    (!w.payments ||
      (typeof w.payments === "object" && !Array.isArray(w.payments))) &&
    ["groupName", "startDate", "endDate"].every(
      (k) => w[k] === undefined || typeof w[k] === "string",
    )
  );
}
export function hydrate(w) {
  return {
    ...blank(),
    ...w,
    members: (w.members || []).filter((n) => typeof n === "string"),
    expenses: w.expenses.map(normaliseReceipt),
    payments: w.payments || {},
  };
}
export function persist() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        work: state.archive ? state.returnWork : state.work,
        previous: state.previous,
        scan: state.scan,
        lastScanReport: state.lastScanReport,
        edits: state.edits,
      }),
    );
    state.storageError = "";
    state.savedAt = new Date().toLocaleTimeString("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    state.storageError =
      "This browser could not save your draft. Export a backup before closing this window.";
  }
  emit();
}
export function change(fn, { financial = true } = {}) {
  if (state.archive || state.work.closedAt) return;
  fn(state.work);
  if (financial) state.work.payments = {};
  persist();
}
export function restore() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!validWork(saved.work)) throw new Error("Invalid draft");
      state.work = hydrate(saved.work);
      state.previous = validWork(saved.previous)
        ? hydrate(saved.previous)
        : null;
      state.edits =
        saved.edits && typeof saved.edits === "object" ? saved.edits : {};
      state.scan =
        saved.scan?.context && Array.isArray(saved.scan.incoming)
          ? {
              ...saved.scan,
              active: ["preparing", "queued", "running"].includes(
                saved.scan.status,
              ),
              incoming: saved.scan.incoming.map(normaliseReceipt),
            }
          : null;
      state.lastScanReport =
        saved.lastScanReport && typeof saved.lastScanReport === "object"
          ? saved.lastScanReport
          : null;
    } else {
      const old = JSON.parse(
        localStorage.getItem("splitmate-workspace-v1") || "null",
      );
      if (old?.current && validWork(old.current)) {
        state.work = hydrate({
          ...old.current.context,
          expenses: old.current.expenses,
        });
        if (validWork(old.previous))
          state.previous = hydrate({
            ...old.previous.context,
            expenses: old.previous.expenses,
          });
        if (old.interrupted && old.scanContext)
          state.scan = {
            id: crypto.randomUUID(),
            active: false,
            context: old.scanContext,
            incoming: (old.incoming || []).map(normaliseReceipt),
          };
      }
    }
    if (state.scan && !["queued", "running", "partial"].includes(state.scan.status))
      state.error =
        "Your last scan was interrupted. Your existing receipts are safe. Keep recovered receipts or discard the scan before starting again.";
  } catch {
    try {
      localStorage.setItem(
        "splitmate-recovery-original",
        localStorage.getItem(KEY) ||
          localStorage.getItem("splitmate-workspace-v1") ||
          "",
      );
    } catch {}
    state.error =
      "The saved draft could not be read. The original has been retained under its recovery key in this browser. Import a valid backup to recover your workspace.";
  }
}
