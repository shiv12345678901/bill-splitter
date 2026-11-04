const {
  loadChatHistory,
  readReceiptCandidates,
} = require("../services/message-discovery.cjs");
const processReceipts = require("../services/receipt-workers.cjs");
const database = require("../services/database.cjs");
const library = require("../services/library.cjs");
const {
  loadReceiptCache,
  loadSettlementHistory,
  saveSettlementHistory,
} = require("../services/storage.cjs");
const { loadUserConfig } = require("../services/config.cjs");
const { selectCycleForPeriod } = require("../services/cycle-state.cjs");
const { tagReceiptDuplicates } = require("../services/receipt-dedup.cjs");
const { safeErrorMessage } = require("../services/whatsapp-snapshot.cjs");
const {
  calculateSettlement,
  formatWhatsAppReport,
} = require("../services/settlement.cjs");

const TERMINAL = new Set(["failed", "cancelled", "complete"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function historicalScanError(error) {
  const message = error instanceof Error && error.message
    ? error.message
    : safeErrorMessage(error);
  if (/WhatsApp history|chat history|history loading|chat-collection|group is unavailable|resource unavailable/i.test(message)) {
    return "WhatsApp chat history is unavailable or incomplete for that cycle. Open WhatsApp on the linked phone, allow history to finish syncing, and try again.";
  }
  return message;
}
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
      cycleBoundaryId,
      maxMessages = 600,
      useCheckpoint = false,
      sync = false,
      historicalEvidence = false,
      historicalQueueEvidence = false,
    } = request;
    const historicalCycle = historicalEvidence || historicalQueueEvidence;
    if (historicalCycle && !groupId)
      throw new Error("Choose the WhatsApp group for this cycle scan.");
    if (!ISO_DATE.test(startDate || "") || !ISO_DATE.test(endDate || "") || startDate > endDate) {
      throw new Error("Choose a valid start and end date for the cycle scan.");
    }
    const startUnix = Math.floor(new Date(`${startDate}T00:00:00`).getTime() / 1000);
    const endUnix = Math.floor(new Date(`${endDate}T23:59:59`).getTime() / 1000);
    if (!Number.isFinite(startUnix) || !Number.isFinite(endUnix))
      throw new Error("Invalid start or end date.");

    notify("fetching_messages", "Connecting to chat and loading messages…", 0, 0);
    let groupDisplayName = request.groupName || "Selected group";
    let candidateMessages = [];
    let selectedCycleData = null;
    let activeCheckpoint = null;
    let messageFreshness = null;

    if ((cycleId || sync) && detectSettlementCycles) {
      const cycles = await detectSettlementCycles(groupId);
      messageFreshness = cycles.snapshot || null;
      if (sync && messageFreshness?.retrievalVerified !== true) {
        throw new Error("WhatsApp recent-message retrieval is unverified; refusing to finalize this scan.");
      }
      const historicalMatches = historicalCycle
        ? cycles.filter((cycle) =>
          cycle.status === "SETTLED" &&
          cycle.startDate === startDate &&
          cycle.endDate === endDate &&
          (!cycleId || cycle.id === cycleId))
        : [];
      if (historicalCycle && historicalMatches.length !== 1) {
        throw new Error(
          historicalMatches.length
            ? "That date range matches more than one settled WhatsApp cycle. Select the cycle by its saved ID."
            : "No settled WhatsApp cycle exactly matches that start and end date.",
        );
      }
      const target = historicalCycle
        ? historicalMatches[0]
        : cycleId
          ? cycles.find((cycle) => cycle.id === cycleId)
          : selectCycleForPeriod(cycles, startDate);
      if (!target) {
        throw new Error(
          cycleId
            ? "The requested WhatsApp settlement cycle was not found."
            : "The Supabase period cannot be mapped to exactly one WhatsApp settlement cycle; refusing to mix cycles.",
        );
      }
      if (cycleBoundaryId && target.startBoundary?.id !== cycleBoundaryId) {
        throw new Error("The WhatsApp cycle boundary changed during discovery; refusing an ambiguous scan.");
      }
      if (historicalCycle && (!target.startBoundary?.id || !target.endBoundary?.id)) {
        throw new Error("The settled cycle has no immutable WhatsApp boundaries and cannot be rescanned safely.");
      }
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
          unclassifiedCount: target.unclassifiedCount || 0,
          calculationMessage: target.calculationMessage || null,
          clearanceMessage: target.clearanceMessage || null,
          settlementConfirmed: target.settlementConfirmed === true,
        };
        startDate = target.startDate;
        if (target.endDate) endDate = target.endDate;
        activeCheckpoint = target.startCheckpoint || null;
        const seen = new Set();
        for (const message of [
          ...(target.groceryMessages || []),
          ...(target.paymentMessages || []),
          ...(target.unclassifiedMessages || []),
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
      const history = await loadChatHistory(client, groupId, fetchLimit, sync ? startUnix : null);
      const { messages: recentMessages = [], ...freshnessSummary } = history.recentSnapshot || {};
      messageFreshness = freshnessSummary;
      const raw = await readReceiptCandidates(
        client,
        groupId,
        startUnix,
        endUnix,
        useCheckpoint,
        recentMessages,
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

    const excludedMessageIds = new Set(
      Array.isArray(request.excludeMessageIds) ? request.excludeMessageIds.map(String) : [],
    );
    if (excludedMessageIds.size) {
      candidateMessages = candidateMessages.filter((candidate) =>
        !excludedMessageIds.has(String(candidate.id)));
    }

    return {
      request: { ...request, startDate, endDate },
      candidates: candidateMessages,
      groupDisplayName,
      selectedCycleData,
      checkpoint: activeCheckpoint,
      messageFreshness,
    };
  }

  async function prepare(request = {}, { autoStart = false, errorEvent = "scan:error" } = {}) {
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
      emit(errorEvent, {
        runId: jobId,
        message: request.historicalEvidence
          ? historicalScanError(error)
          : error instanceof Error && error.message ? error.message : safeErrorMessage(error),
      });
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

  async function finishHistoricalEvidence(job, status, outcomes, expenses) {
    const history = loadSettlementHistory();
    const matches = job.request.historyId
      ? history.filter((record) => record.id === job.request.historyId)
      : history.filter((record) =>
        record.startDate === job.request.startDate &&
        record.endDate === job.request.endDate &&
        (!record.groupId || record.groupId === job.groupId));
    if (matches.length !== 1) {
      throw new Error(
        matches.length
          ? "More than one saved settlement matches that cycle. Send its historyId with the scan request."
          : "No saved settlement history matches that cycle. Refresh History and try again.",
      );
    }
    const existingRecord = matches[0];
    if (
      (existingRecord.startDate && existingRecord.startDate !== job.request.startDate) ||
      (existingRecord.endDate && existingRecord.endDate !== job.request.endDate) ||
      (existingRecord.groupId && existingRecord.groupId !== job.groupId)
    ) {
      throw new Error("The saved settlement does not match the requested WhatsApp cycle.");
    }

    const existingExpenses = Array.isArray(existingRecord.expenses)
      ? existingRecord.expenses
      : [];
    const existingById = new Map(existingExpenses.map((expense) => [expense.id, expense]));
    const addedEvidence = [];
    const refreshedById = new Map();
    for (const scanned of expenses) {
      const existing = existingById.get(scanned.id);
      if (existing) {
        refreshedById.set(scanned.id, { ...scanned, ...existing, id: existing.id });
        continue;
      }
      const evidence = {
        ...scanned,
        isExcluded: true,
        needsReview: true,
        historicalEvidence: true,
        evidenceOnly: true,
      };
      refreshedById.set(evidence.id, evidence);
      addedEvidence.push(evidence);
    }
    const mergedExpenses = existingExpenses.map((expense) =>
      refreshedById.get(expense.id) || expense);
    for (const evidence of addedEvidence) mergedExpenses.push(evidence);

    const now = new Date().toISOString();
    const updatedHistoryRecord = {
      ...existingRecord,
      expenses: mergedExpenses,
      evidenceRescan: {
        scannedAt: now,
        startDate: job.request.startDate,
        endDate: job.request.endDate,
        cycleId: job.selectedCycleData.id,
        found: expenses.length,
        added: addedEvidence.length,
        failed: outcomes.filter((outcome) => outcome.status === "failed").length,
        settlementPreserved: true,
      },
    };
    const historyIndex = history.indexOf(existingRecord);
    history[historyIndex] = updatedHistoryRecord;
    saveSettlementHistory(history);

    const savedCycle = library.loadSettlementCycles().find((cycle) =>
      cycle.groupId === job.groupId &&
      cycle.startBoundaryId === job.selectedCycleData.startBoundary?.id);
    const imagesById = new Map((savedCycle?.images || []).map((image) => [image.id, image]));
    for (const outcome of outcomes) {
      if (!outcome.receipt || imagesById.has(outcome.messageId)) continue;
      imagesById.set(outcome.messageId, {
        id: outcome.messageId,
        merchant: outcome.receipt.merchant || "",
        amount: outcome.receipt.amount || 0,
        paidBy: outcome.receipt.paidBy || "",
        status: "excluded",
        isExcluded: true,
      });
    }
    const cycleRecord = await library.recordSettlementCycle({
      groupId: job.groupId,
      groupName: job.groupDisplayName,
      startDate: job.selectedCycleData.startDate,
      endDate: job.selectedCycleData.endDate,
      status: "SETTLED",
      calculationMessage: job.selectedCycleData.calculationMessage,
      clearanceMessage: job.selectedCycleData.clearanceMessage,
      settlementConfirmed: job.selectedCycleData.settlementConfirmed,
      unclassifiedCount: job.selectedCycleData.unclassifiedCount,
      startBoundary: job.selectedCycleData.startBoundary,
      endBoundary: job.selectedCycleData.endBoundary,
      expectedMedia: Math.max(
        Number(savedCycle?.completeness?.expected) || 0,
        job.expectedImages,
        imagesById.size,
      ),
      images: [...imagesById.values()],
      totals: savedCycle?.totals || null,
    });

    const reconciliation = reconciliationFor(job.jobId, job.startedAt);
    const updated = database.updateScanJob(job.jobId, {
      status,
      stage: "historical_evidence_saved",
      message: status === "complete"
        ? `${addedEvidence.length} new evidence item(s) saved. Settlement values were preserved.`
        : `${addedEvidence.length} evidence item(s) saved; some images need attention. Settlement values were preserved.`,
      reconciliation,
      finishedAt: now,
      result: {
        expenses,
        historyId: updatedHistoryRecord.id,
        addedEvidence: addedEvidence.length,
        settlementPreserved: true,
        cycleRecord,
      },
    });
    publishJob(job.jobId);
    emit("history:saved", { record: updatedHistoryRecord });
    emit("history:list", { history });
    emit("history:scan_cycle_complete", {
      runId: job.jobId,
      job: publicJob(updated),
      historyId: updatedHistoryRecord.id,
      cycleId: job.selectedCycleData.id,
      found: expenses.length,
      added: addedEvidence.length,
      reconciliation,
      settlementPreserved: true,
    });
    return updated;
  }

  async function finishHistoricalQueueEvidence(job, status, outcomes, expenses) {
    const evidence = expenses.map((expense) => ({
      ...expense,
      isExcluded: true,
      needsReview: true,
      historicalEvidence: true,
      evidenceOnly: true,
    }));
    const reconciliation = reconciliationFor(job.jobId, job.startedAt);
    const updated = database.updateScanJob(job.jobId, {
      status,
      stage: "historical_evidence_ready",
      message: status === "complete"
        ? `${evidence.length} new historical evidence item(s) ready to save.`
        : `${evidence.length} historical evidence item(s) read; some images need attention.`,
      reconciliation,
      finishedAt: new Date().toISOString(),
      result: { expenses: evidence, evidenceOnly: true },
    });
    publishJob(job.jobId);
    return updated;
  }

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
    let outcomes = database.getScanOutcomes(job.jobId);
    let expenses = outcomes
      .map((outcome) => outcome.receipt)
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    tagReceiptDuplicates(expenses);
    for (const expense of expenses) {
      if (!expense.isDuplicate || !expense.needsReview || !expense.isExcluded) continue;
      const outcome = outcomes.find((item) => item.messageId === expense.id);
      if (!outcome || outcome.status === "excluded") continue;
      database.recordScanOutcome(job.jobId, {
        ...outcome,
        status: "excluded",
        reason: expense.duplicateReason,
        receipt: expense,
      });
    }
    outcomes = database.getScanOutcomes(job.jobId);
    expenses = outcomes
      .map((outcome) => outcome.receipt)
      .filter(Boolean)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (job.request.historicalQueueEvidence) {
      return finishHistoricalQueueEvidence(job, status, outcomes, expenses);
    }
    if (job.request.historicalEvidence) {
      return finishHistoricalEvidence(job, status, outcomes, expenses);
    }
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
        startDate: job.selectedCycleData?.startDate || job.checkpoint?.dateStr || job.request.startDate,
        endDate: job.selectedCycleData ? job.selectedCycleData.endDate : job.request.endDate,
        status: job.selectedCycleData?.status,
        calculationMessage: job.selectedCycleData?.calculationMessage,
        clearanceMessage: job.selectedCycleData?.clearanceMessage,
        settlementConfirmed: job.selectedCycleData?.settlementConfirmed,
        unclassifiedCount: job.selectedCycleData?.unclassifiedCount,
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
          isExcluded: Boolean(outcome.receipt?.isExcluded || outcome.status === "excluded"),
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
      const message = job.request.historicalEvidence
        ? historicalScanError(error)
        : error instanceof Error && error.message
          ? error.message
          : safeErrorMessage(error);
      database.updateScanJob(jobId, {
        status,
        message,
        errorCode: processReceipts.classifyScanError(error),
        finishedAt: new Date().toISOString(),
        reconciliation: reconciliationFor(jobId, job.startedAt),
      });
      publishJob(jobId);
      const errorEvent = job.request.historicalEvidence
        ? "history:scan_cycle_error"
        : status === "cancelled" ? "scan:aborted" : "scan:error";
      emit(errorEvent, {
        runId: jobId,
        message,
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

  async function scanHistoricalCycle(request = {}) {
    const runId = request.runId || crypto.randomUUID();
    emit("history:scan_cycle_started", { runId });
    const prepared = await prepare(
      {
        ...request,
        runId,
        historicalEvidence: true,
        sync: true,
        useCheckpoint: false,
      },
      { errorEvent: "history:scan_cycle_error" },
    );
    if (!prepared) return null;
    await run(prepared.jobId);
    return database.getScanJob(prepared.jobId);
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
    socket.on("history:scan_cycle", (request) => scanHistoricalCycle(request));
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

  async function runAndGet(jobId, options) {
    await run(jobId, options);
    return database.getScanJob(jobId);
  }

  return {
    prepare,
    run,
    runAndGet,
    cancel,
    resumePending,
    scanHistoricalCycle,
    registerSocket,
    detectCycles: async (groupId) => detectSettlementCycles ? detectSettlementCycles(groupId) : [],
  };
}

module.exports = function registerScan(socket, getConnection, dependencies) {
  const manager = createScanManager(socket, getConnection, dependencies);
  manager.registerSocket(socket);
  return manager;
};
module.exports.createScanManager = createScanManager;
