const crypto = require("node:crypto");
const { isGenuineImageMessage, messageMimeType, messageType } = require("./whatsapp-media.cjs");
const { fetchRecentCollectionMessages } = require("./whatsapp-collection.cjs");

const clientStates = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OPERATION_LABELS = {
  get_state: "connection-state check",
  get_chat: "chat lookup",
  fetch_recent: "recent-message fetch",
  fetch_recent_collection: "collection recent-message fetch",
  sync_history: "optional peer-history request",
  merge_messages: "message merge",
  evaluate_history: "history page evaluation",
  evaluate_candidates: "candidate page evaluation",
  search_history: "history search",
  prepare_collection_lookup: "chat-collection lookup preparation",
};

function errorCategory(error) {
  const value = String(error?.message || error || "").toLowerCase();
  if (!value || value.length <= 2) return "opaque library rejection";
  if (/timeout|timed out/.test(value)) return "operation timed out";
  if (/stopped loading|could not finish loading/.test(value)) return "history loading stalled";
  if (/execution context|context.*destroyed|detached frame/.test(value)) return "browser context changed";
  if (/target closed|session closed|browser.*closed|page.*closed/.test(value)) return "browser session closed";
  if (/protocol error/.test(value)) return "browser protocol failure";
  if (/disconnect|not connected|socket/.test(value)) return "client disconnected";
  if (/unsupported|not a function|cannot find module/.test(value)) return "operation unsupported";
  if (/not found|unavailable|does not exist/.test(value)) return "resource unavailable";
  return "library operation failed";
}

function operationError(operation, error) {
  if (error?.name === "WhatsAppOperationError" && error.operation === operation) return error;
  const category = errorCategory(error);
  const label = OPERATION_LABELS[operation] || "operation";
  const wrapped = new Error(`WhatsApp ${label} failed (${category}).`);
  wrapped.name = "WhatsAppOperationError";
  wrapped.code = `WHATSAPP_${operation.toUpperCase()}_FAILED`;
  wrapped.operation = operation;
  wrapped.category = category;
  return wrapped;
}

function safeErrorMessage(error, fallback = "WhatsApp operation failed.") {
  if (error?.name === "WhatsAppOperationError" && error.message) return error.message;
  if (error instanceof Error && error.message) return operationError("unknown", error).message;
  if (error !== undefined && error !== null) return operationError("unknown", error).message;
  return fallback;
}

async function runWhatsAppOperation(operation, action, { timeoutMs = 10000 } = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw operationError(operation, error);
  } finally {
    clearTimeout(timer);
  }
}

function serializedId(value) {
  if (typeof value === "string") return value;
  return value?._serialized || value?.$1 || "";
}

function normaliseMessage(message = {}) {
  const id = serializedId(message.id);
  const timestamp = Number(message.timestamp || message.t || 0);
  const from = serializedId(message.from);
  const to = serializedId(message.to);
  const author = serializedId(message.author) || from;
  return {
    id,
    timestamp,
    body: String(message.body || message.caption || message._data?.body || ""),
    isNotification: Boolean(message.isNotification),
    hasMedia: Boolean(message.hasMedia || message.mediaData),
    type: messageType(message),
    mimetype: messageMimeType(message),
    preview: typeof message.preview === "string" ? message.preview : "",
    author,
    from,
    to,
  };
}

function groupIdFor(message) {
  const normalised = normaliseMessage(message);
  if (normalised.from.endsWith("@g.us")) return normalised.from;
  if (normalised.to.endsWith("@g.us")) return normalised.to;
  return "";
}

function mergeMessages(...collections) {
  const byId = new Map();
  for (const collection of collections) {
    for (const input of collection || []) {
      const message = normaliseMessage(input);
      if (!message.id || !Number.isSafeInteger(message.timestamp) || message.timestamp <= 0) continue;
      const existing = byId.get(message.id);
      byId.set(message.id, existing ? {
        ...existing,
        ...message,
        body: message.body || existing.body,
        mimetype: message.mimetype || existing.mimetype,
        type: message.type || existing.type,
        author: message.author || existing.author,
        from: message.from || existing.from,
        to: message.to || existing.to,
        preview: message.preview || existing.preview,
        hasMedia: message.hasMedia || existing.hasMedia,
        isNotification: message.isNotification || existing.isNotification,
      } : message);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

function runMessageMerge(...collections) {
  try {
    return mergeMessages(...collections);
  } catch (error) {
    throw operationError("merge_messages", error);
  }
}

function snapshotFingerprint(messages) {
  return messages.map((message) =>
    `${message.id}:${message.timestamp}:${message.type}:${message.mimetype}`).join("|");
}

function stateFor(client) {
  let state = clientStates.get(client);
  if (!state) {
    state = { groups: new Map(), cache: new Map(), attached: false };
    clientStates.set(client, state);
  }
  return state;
}

function attachMessageSnapshotTracker(client, { logger = console } = {}) {
  if (!client?.on) return;
  const state = stateFor(client);
  if (state.attached) return;
  state.attached = true;
  const clearCache = () => state.cache.clear();
  const remember = (message) => {
    try {
      const groupId = groupIdFor(message);
      if (!groupId) return;
      const existing = state.groups.get(groupId) || [];
      state.groups.set(groupId, runMessageMerge(existing, [message]).slice(-500));
      state.cache.delete(groupId);
    } catch (error) {
      logger.warn?.(`[WhatsApp:Events] ${safeErrorMessage(error)}`);
    }
  };
  client.on("message", remember);
  client.on("message_create", remember);
  client.on("disconnected", clearCache);
  client.on("change_state", (connectionState) => {
    if (connectionState !== "CONNECTED") clearCache();
  });
}

function discoveryStats(messages) {
  const imageCount = messages.filter(isGenuineImageMessage).length;
  const rejectedCandidateCount = messages.filter((message) => {
    if (isGenuineImageMessage(message)) return false;
    return Boolean(message.hasMedia || message.mimetype ||
      ["group-history", "document", "video", "sticker"].includes(message.type));
  }).length;
  const newestTimestamp = messages.reduce(
    (latest, message) => Math.max(latest, Number(message.timestamp) || 0),
    0,
  ) || null;
  return { messageCount: messages.length, imageCount, rejectedCandidateCount, newestTimestamp };
}

function numericOption(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function privateGroupLabel(groupId) {
  return crypto.createHash("sha256").update(String(groupId)).digest("hex").slice(0, 10);
}

async function refreshRecentMessageSnapshot(groupId, client, options = {}) {
  const logger = options.logger || console;
  const recentLimit = numericOption(options.recentLimit, 250, 1);
  const minimumWaitMs = numericOption(options.minimumWaitMs ?? process.env.SPLITMATE_WHATSAPP_REFRESH_MIN_WAIT_MS, 2000);
  const pollMs = numericOption(options.pollMs ?? process.env.SPLITMATE_WHATSAPP_REFRESH_POLL_MS, 500, 1);
  const maxWaitMs = numericOption(options.maxWaitMs ?? process.env.SPLITMATE_WHATSAPP_REFRESH_MAX_WAIT_MS, 6000, pollMs * 2);
  const cacheMs = numericOption(options.cacheMs ?? process.env.SPLITMATE_WHATSAPP_SNAPSHOT_CACHE_MS, 5000);
  const operationTimeoutMs = numericOption(options.operationTimeoutMs ?? process.env.SPLITMATE_WHATSAPP_OPERATION_TIMEOUT_MS, 10000, 100);
  const wait = options.wait || sleep;
  const now = options.now || (() => Date.now());

  if (!groupId || !client?.getState || !client?.pupPage?.evaluate) {
    throw operationError("get_chat", new Error("operation unsupported"));
  }
  attachMessageSnapshotTracker(client, { logger });
  const state = stateFor(client);
  const cached = state.cache.get(groupId);
  if (cached && now() - cached.refreshedAtMs <= cacheMs) return cached;

  const operationOptions = { timeoutMs: operationTimeoutMs };
  const connectionState = await runWhatsAppOperation("get_state", () => client.getState(), operationOptions);
  if (connectionState !== "CONNECTED") throw operationError("get_state", new Error("client disconnected"));
  let chat = null;
  let initialMessages = null;
  let retrievalSource = "collection+events";
  if (typeof client.getChatById === "function") {
    try {
      chat = await runWhatsAppOperation("get_chat", () => client.getChatById(groupId), operationOptions);
      if (typeof chat?.fetchMessages !== "function") chat = null;
    } catch (error) {
      logger.warn?.(`[WhatsApp:Recent] ${safeErrorMessage(error)} Trying the compatible chat-collection lookup.`);
    }
  }
  if (chat) {
    try {
      initialMessages = await runWhatsAppOperation(
        "fetch_recent",
        () => chat.fetchMessages({ limit: recentLimit }),
        operationOptions,
      );
      retrievalSource = "fetchMessages+events";
    } catch (error) {
      logger.warn?.(`[WhatsApp:Recent] ${safeErrorMessage(error)} Trying the compatible chat-collection reader.`);
      chat = null;
    }
  }
  const fetchRecent = chat
    ? () => runWhatsAppOperation(
      "fetch_recent",
      () => chat.fetchMessages({ limit: recentLimit }),
      operationOptions,
    )
    : () => runWhatsAppOperation(
      "fetch_recent_collection",
      () => fetchRecentCollectionMessages(client, groupId, recentLimit),
      operationOptions,
    );
  if (!chat) initialMessages = await fetchRecent();
  let messages = runMessageMerge(initialMessages, state.groups.get(groupId));
  let fingerprint = snapshotFingerprint(messages);
  const refreshStartedAt = now();
  let historyTransfer = "unsupported";
  if (typeof chat?.syncHistory === "function") {
    try {
      const requested = await runWhatsAppOperation("sync_history", () => chat.syncHistory(), operationOptions);
      historyTransfer = requested === true ? "requested" : "not-requested";
    } catch (error) {
      historyTransfer = "failed-optional";
      logger.warn?.(`[WhatsApp:Recent] ${safeErrorMessage(error)} Continuing with supported recent-message retrieval.`);
    }
  }

  let stableReads = 0;
  const maximumPolls = Math.max(2, Math.ceil(maxWaitMs / pollMs));
  for (let poll = 0; poll < maximumPolls; poll += 1) {
    await wait(pollMs);
    const next = runMessageMerge(await fetchRecent(), state.groups.get(groupId));
    const nextFingerprint = snapshotFingerprint(next);
    stableReads = nextFingerprint === fingerprint ? stableReads + 1 : 0;
    messages = next;
    fingerprint = nextFingerprint;
    if (now() - refreshStartedAt >= minimumWaitMs && stableReads >= 2) break;
  }
  if (stableReads < 2) throw operationError("fetch_recent", new Error("operation timed out"));
  const finalConnectionState = await runWhatsAppOperation("get_state", () => client.getState(), operationOptions);
  if (finalConnectionState !== "CONNECTED") throw operationError("get_state", new Error("client disconnected"));

  const stats = discoveryStats(messages);
  const result = {
    retrievalVerified: true,
    freshness: "observed-connected-window",
    deliveryCompleteness: "unverified",
    source: retrievalSource,
    connectionState: finalConnectionState,
    historyTransfer,
    refreshedAt: new Date(now()).toISOString(),
    refreshedAtMs: now(),
    messages,
    ...stats,
  };
  state.cache.set(groupId, result);
  logger.log?.(
    `[WhatsApp:Recent] group=${privateGroupLabel(groupId)} messages=${stats.messageCount} newest=${stats.newestTimestamp ? new Date(stats.newestTimestamp * 1000).toISOString() : "none"} images=${stats.imageCount} rejected=${stats.rejectedCandidateCount} retrieval=verified delivery_completeness=unverified history_transfer=${historyTransfer}`,
  );
  return result;
}

module.exports = {
  attachMessageSnapshotTracker,
  discoveryStats,
  errorCategory,
  mergeMessages,
  normaliseMessage,
  operationError,
  refreshRecentMessageSnapshot,
  runWhatsAppOperation,
  safeErrorMessage,
};
