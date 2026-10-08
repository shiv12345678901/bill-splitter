const {
  loadChatHistory,
  readReceiptCandidates,
} = require("../services/message-discovery.cjs");
const processReceipts = require("../services/receipt-workers.cjs");
const database = require("../services/database.cjs");
const library = require("../services/library.cjs");
const { loadReceiptCache } = require("../services/storage.cjs");
const { loadUserConfig } = require("../services/config.cjs");
const {
  calculateSettlement,
  formatWhatsAppReport,
} = require("../services/settlement.cjs");

const TERMINAL = new Set(["failed", "cancelled", "complete"]);
const memberBreakdownFor = (expenses) => {
  const result = {
    "Arjun Bhurtel": { total: 0, count: 0, receipts: [] },
    "Arpan Bhurtel": { total: 0, count: 0, receipts: [] },
    "Shiva Kafle": { total: 0, count: 0, receipts: [] },
    "Swasti Adhikari": { total: 0, count: 0, receipts: [] },
  };
  for (const expense of expenses) {
    const person = expense.paidBy || "Flatmate";
    if (!result[person]) result[person] = { total: 0, count: 0, receipts: [] };
    if (!expense.isExcluded)
      result[person].total =
        Math.round((result[person].total + expense.amount) * 100) / 100;
    result[person].count++;
    result[person].receipts.push(expense);
  }
  return result;
};

function createScanManager(
  emitter,
  getConnection,
  { detectSettlementCycles, downloadMediaBuffer, parseReceiptWithGemini } = {},
) {
  let activeJobId = null;

  const emit = (event, payload = {}) => emitter.emit(event, payload);
  const publicJob = (job) => {
    if (!job) return null;
    const { candidates, request, result, ...safe } = job;
    return safe;
  };
  const publishJob = (jobId) => {
    const job = database.getScanJob(jobId);
    if (!job) return null;
    emit("scan:job", {
      runId: job.jobId,
      job: publicJob(job),
      outcomes: database.getScanOutcomes(jobId),
    });
    return job;
  };
  const connection = () => {
    const current = getConnection();
    if (!current.client || current.clientStatus !== "READY")
      throw new Error("WhatsApp client is not ready. Please link your phone.");
    const activeKeys = current.geminiApiKeys?.length
      ? current.geminiApiKeys
      : current.geminiApiKey
        ? [current.geminiApiKey]
        : [];
    if (!activeKeys.length)
      throw new Error(
        "Gemini API Key missing. Please provide your Gemini API key in Settings or .env.",
      );
    return { ...current, activeKeys };
  };

  async function discover(request, notify) {
    const { client } = connection();
    let {
      groupId,
      startDate,
      endDate,
      cycleId,
      maxMessages = 600,
      useCheckpoint = false,
      sync = false,
    } = request;
    const startUnix = Math.floor(new Date(`${startDate}T00:00:00`).getTime() / 1000);
    const endUnix = Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000);
    if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix))
      throw new Error("Invalid start or end date.");

    notify("fetching_messages", "Connecting to chat and loading messages…", 0, 0);
    let groupDisplayName = request.groupName || "Selected group";
    let candidateMessages = [];
    let selectedCycleData = null;
    let activeCheckpoint = null;

    if (cycleId && detectSettlementCycles) {
      const cycles = await detectSettlementCycles(groupId);
      const target = cycles.find((cycle) => cycle.id === cycleId);
      if (target) {
        selectedCycleData = {
          id: target.id,
          title: target.title,
          status: target.status,
          startDate: target.startDate,
          endDate: target.endDate,
          startBoundary: target.startBoundary,
          endBoundary: target.endBoundary,
          groundTruth: target.groundTruth,
          groceryCount: target.groceryCount || 0,
          paymentCount: target.paymentCount || 0,
        };
        startDate = target.startDate;
        endDate = target.endDate;
        activeCheckpoint = target.startCheckpoint || null;
        const seen = new Set();
        for (const message of [
          ...(target.groceryMessages || []),
          ...(target.paymentMessages || []),
        ]) {
          if (!message?.id || seen.has(message.id)) continue;
          seen.add(message.id);
          candidateMessages.push({
            id: message.id,
            timestamp: message.timestamp,
            author: message.author,
            from: message.from || message.author,
          });
        }
        candidateMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      }
    }

    if (!selectedCycleData && client.pupPage) {
      const fetchLimit = Math.min(Math.max(parseInt(maxMessages) || 600, 100), 1500);
      await loadChatHistory(client, groupId, fetchLimit, sync ? startUnix : null);
      const raw = await readReceiptCandidates(
        client,
        groupId,
        startUnix,
        endUnix,
        useCheckpoint,
      );
      if (raw?.error) throw new Error(raw.error);
      groupDisplayName = raw?.name || groupDisplayName;
      activeCheckpoint = raw?.checkpoint || null;
      candidateMessages = (raw?.messages || []).map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        author: message.author,
        from: message.from || message.author,
      }));
    }

    return {
      request: { ...request, startDate, endDate },
      candidates: candidateMessages,
      groupDisplayName,
      selectedCycleData,
      checkpoint: activeCheckpoint,
    };
  }

  async function prepare(request = {}, { autoStart = false } = {}) {
    const jobId = request.runId || request.jobId || crypto.randomUUID();
    if (database.getScanJob(jobId)) return database.getScanJob(jobId);
    try {
      const discovered = await discover(request, (stage, message, current, total) =>
        emit("scan:progress", { runId: jobId, stage, message, current, total }),
      );
      const cache = loadReceiptCache();
      const cachedImages = discovered.candidates.filter(
        (candidate) => cache[candidate.id] || library.findById(candidate.id),
      ).length;
      const now = new Date().toISOString();
      const job = database.createScanJob({
        jobId,
        groupId: request.groupId || "",
        status: "queued",
        expectedImages: discovered.candidates.length,
        completedImages: 0,
        createdAt: now,
        updatedAt: now,
        stage: "estimated",
        message: `${discovered.candidates.length} images ready to scan.`,
        estimate: {
          imageCount: discovered.candidates.length,
          cachedImages,
          maximumApiCalls: discovered.candidates.length - cachedImages,
        },
        ...discovered,
      });
      for (const candidate of discovered.candidates)
        database.recordScanOutcome(jobId, {
          messageId: candidate.id,
          status: "queued",
          timestamp: candidate.timestamp,
        });
      emit("scan:estimate", {
        runId: jobId,
        job: publicJob(database.getScanJob(jobId)),
      });
      if (autoStart) void run(jobId);
      return job;
    } catch (error) {
      emit("scan:error", { runId: jobId, message: error.message });
      return null;
    }
  }

  const reconciliationFor = (jobId, startedAt) => {
    const outcomes = database.getScanOutcomes(jobId);
    const counts = {
      processed: 0,
      failed: 0,
      excluded: 0,
      skipped: 0,
      queued: 0,
    };
    const skippedReasons = {};
    let apiCalls = 0;
    for (const outcome of outcomes) {
      counts[outcome.status]++;
      apiCalls += Number(outcome.apiCalls) || 0;
      if (outcome.status === "skipped" || outcome.status === "failed") {
        const reason = outcome.reason || outcome.errorCode || "Unknown";
        skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
      }
    }
    return {
      expected: outcomes.length,
      completed: outcomes.length - counts.queued,
      ...counts,
      apiCalls,
      skippedReasons,
      durationMs: startedAt ? Date.now() - new Date(startedAt).getTime() : 0,
    };
  };

  async function finish(job, status) {
    if (status === "cancelled") {
      for (const outcome of database.getScanOutcomes(job.jobId)) {
        if (outcome.status === "queued")
          database.recordScanOutcome(job.jobId, {
            ...outcome,
            status: "skipped",
            reason: "Cancelled before processing",
          });
      }
    }
    const outcomes = database.getScanOutcomes(job.jobId);
    const expenses = outcomes
      .map((outcome) => outcome.receipt)
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const aliases = { ...loadUserConfig().aliases, ...(job.request.aliases || {}) };
    const settlement = calculateSettlement(expenses, aliases);
    const memberBreakdown = memberBreakdownFor(expenses);
    const reportText = formatWhatsAppReport({
      startDate: job.request.startDate,
      endDate: job.request.endDate,
      totalPool: settlement.totalPool,
      fairShare: settlement.fairShare,
      transfers: settlement.transfers,
      memberBreakdown,
      memberTotals: settlement.memberTotals,
      checkpointText: job.checkpoint?.text || null,
    });
    let cycleRecord = null;
    if (
      status !== "cancelled" &&
      (job.selectedCycleData?.startBoundary || job.checkpoint)
    ) {
      cycleRecord = await library.recordSettlementCycle({
        groupId: job.groupId,
        groupName: job.groupDisplayName,
        startDate: job.checkpoint?.dateStr || job.request.startDate,
        endDate: job.request.endDate,
        checkpoint: job.checkpoint,
        startBoundary: job.selectedCycleData?.startBoundary || job.checkpoint,
        endBoundary: job.selectedCycleData?.endBoundary || null,
        expectedMedia: job.expectedImages,
        images: outcomes.map((outcome) => ({
          id: outcome.messageId,
          merchant: outcome.receipt?.merchant || "",
          amount: outcome.receipt?.amount || 0,
          paidBy: outcome.receipt?.paidBy || "",
          status: outcome.status,
          isExcluded: outcome.status === "excluded",
        })),
        totals: {
          totalPool: settlement.totalPool,
          fairShare: settlement.fairShare,
          memberTotals: settlement.memberTotals,
        },
      });
    }
    const reconciliation = reconciliationFor(job.jobId, job.startedAt);
    const updated = database.updateScanJob(job.jobId, {
      status,
      stage: "reconciled",
      message:
        status === "complete"
          ? "Scan completed and reconciled."
          : status === "cancelled"
            ? "Scan cancelled. Completed image results were kept."
            : "Scan finished with images that need attention.",
      reconciliation,
      finishedAt: new Date().toISOString(),
      result: { expenses, settlement, memberBreakdown, reportText, cycleRecord },
    });
    publishJob(job.jobId);
    emit(status === "cancelled" ? "scan:aborted" : "scan:complete", {
      runId: job.jobId,
      job: publicJob(updated),
      reconciliation,
      expenses,
      settlement,
      memberBreakdown,
      reportText,
      checkpoint: job.checkpoint,
      cycle: job.selectedCycleData,
      cycleRecord,
      groundTruth: job.selectedCycleData?.groundTruth || null,
      paymentCount: job.selectedCycleData?.paymentCount || 0,
    });
    return updated;
  }

  async function run(jobId, { retryFailedOnly = false } = {}) {
    let job = database.getScanJob(jobId);
    if (!job) return emit("scan:error", { runId: jobId, message: "Scan job not found." });
    if (activeJobId && activeJobId !== jobId)
      return emit("scan:error", {
        runId: jobId,
        message: "Another scan is still running. Wait for it to finish or cancel it.",
      });
    if (job.status === "complete" && !retryFailedOnly) return publishJob(jobId);

    let current;
    try {
      current = connection();
    } catch (error) {
      database.updateScanJob(jobId, { status: "partial", message: error.message });
      publishJob(jobId);
      return;
    }

    const prior = database.getScanOutcomes(jobId);
    const selectedIds = new Set(
      retryFailedOnly
        ? prior.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.messageId)
        : prior.filter((outcome) => outcome.status === "queued").map((outcome) => outcome.messageId),
    );
    const candidates = (job.candidates || []).filter((item) => selectedIds.has(item.id));
    if (!candidates.length) {
      const reconciliation = reconciliationFor(jobId, job.startedAt);
      const status = reconciliation.failed || reconciliation.skipped ? "partial" : "complete";
      return finish(job, status);
    }

    for (const id of selectedIds) {
      const old = prior.find((outcome) => outcome.messageId === id);
      database.recordScanOutcome(jobId, { ...old, messageId: id, status: "queued" });
    }
    activeJobId = jobId;
    job = database.updateScanJob(jobId, {
      status: "running",
      cancelRequested: false,
      finishedAt: null,
      startedAt: job.startedAt || new Date().toISOString(),
      stage: "analyzing",
      message: retryFailedOnly
        ? `Retrying ${candidates.length} failed images…`
        : `Scanning ${candidates.length} images…`,
    });
    publishJob(jobId);
    const socket = {
      emit(event, payload = {}) {
        emit(event, { ...payload, runId: jobId });
      },
    };
    try {
      await processReceipts({
        client: current.client,
        groupId: job.groupId,
        candidateMessages: candidates,
        activeKeys: current.activeKeys,
        concurrency: Math.min(Math.max(current.activeKeys.length, 1), 4),
        effectiveAliases: {
          ...loadUserConfig().aliases,
          ...(job.request.aliases || {}),
        },
        filterMember: job.request.filterMember || "all",
        socket,
        isAborted: () => Boolean(database.getScanJob(jobId)?.cancelRequested),
        downloadMediaBuffer,
        parseReceiptWithGemini,
        onOutcome: async (outcome) => {
          database.recordScanOutcome(jobId, outcome);
          const saved = database.getScanJob(jobId);
          database.updateScanJob(jobId, {
            stage: "analyzing",
            message: `Audited ${saved.completedImages} of ${saved.expectedImages} images…`,
          });
          publishJob(jobId);
        },
      });
      job = database.getScanJob(jobId);
      const reconciliation = reconciliationFor(jobId, job.startedAt);
      const status = job.cancelRequested
        ? "cancelled"
        : reconciliation.failed || reconciliation.skipped || reconciliation.queued
          ? "partial"
          : "complete";
      await finish(job, status);
    } catch (error) {
      const status = database.getScanJob(jobId)?.cancelRequested ? "cancelled" : "failed";
      database.updateScanJob(jobId, {
        status,
        message: error.message || "The scan failed.",
        errorCode: processReceipts.classifyScanError(error),
        finishedAt: new Date().toISOString(),
        reconciliation: reconciliationFor(jobId, job.startedAt),
      });
      publishJob(jobId);
      emit(status === "cancelled" ? "scan:aborted" : "scan:error", {
        runId: jobId,
        message: error.message || "The scan failed.",
      });
    } finally {
      activeJobId = null;
    }
  }

  function cancel(jobId = activeJobId) {
    const job = jobId && database.getScanJob(jobId);
    if (!job || TERMINAL.has(job.status)) return;
    const queued = job.status === "queued" && !job.startedAt;
    const updated = database.updateScanJob(jobId, {
      cancelRequested: true,
      status: job.status,
      message: queued ? "Scan cancelled before OCR started." : "Cancelling after current image work…",
      finishedAt: job.finishedAt,
    });
    publishJob(jobId);
    if (queued)
      void finish(updated, "cancelled").catch((error) =>
        emit("scan:error", { runId: jobId, message: error.message }),
      );
  }

  async function resumePending() {
    if (activeJobId) return;
    const job = database
      .listScanJobs({ statuses: ["running", "partial"], limit: 20 })
      .find(
        (candidate) =>
          candidate.startedAt &&
          !candidate.finishedAt &&
          !candidate.cancelRequested,
      );
    if (job) await run(job.jobId);
  }

  function registerSocket(socket) {
    socket.on("scan:prepare", (request) => prepare(request));
    socket.on("scan:start", async (request) => {
      const job = await prepare(request);
      if (job) await run(job.jobId);
    });
    socket.on("scan:run", ({ jobId }) => run(jobId));
    socket.on("scan:retry_failed", ({ jobId }) => run(jobId, { retryFailedOnly: true }));
    socket.on("scan:cancel", ({ jobId } = {}) => cancel(jobId));
    socket.on("scan:jobs", () => {
      const stored = database.listScanJobs({ limit: 10 });
      const active = stored.find(
        (job) =>
          ["queued", "running"].includes(job.status) ||
          (job.status === "partial" && !job.finishedAt),
      );
      socket.emit("scan:jobs", {
        jobs: stored.map(publicJob),
        activeJob: active
          ? {
              ...publicJob(active),
              context: active.request,
              result: active.result,
            }
          : null,
      });
    });
  }

  return { prepare, run, cancel, resumePending, registerSocket };
}

module.exports = function registerScan(socket, getConnection, dependencies) {
  const manager = createScanManager(socket, getConnection, dependencies);
  manager.registerSocket(socket);
  return manager;
};
module.exports.createScanManager = createScanManager;
