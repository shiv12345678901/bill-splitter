const { isGenuineImageMessage, messageMimeType, messageType } = require("./whatsapp-media.cjs");

const clientStates = new WeakMap();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function attachMessageSnapshotTracker(client) {
  if (!client?.on) return;
  const state = stateFor(client);
  if (state.attached) return;
  state.attached = true;
  const remember = (message) => {
    const groupId = groupIdFor(message);
    if (!groupId) return;
    const existing = state.groups.get(groupId) || [];
    state.groups.set(groupId, mergeMessages(existing, [message]).slice(-500));
    state.cache.delete(groupId);
  };
  client.on("message", remember);
  client.on("message_create", remember);
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

async function refreshRecentMessageSnapshot(groupId, client, {
  logger = console,
  recentLimit = 250,
  minimumWaitMs = Number(process.env.SPLITMATE_WHATSAPP_REFRESH_MIN_WAIT_MS) || 2000,
  pollMs = Number(process.env.SPLITMATE_WHATSAPP_REFRESH_POLL_MS) || 500,
  maxWaitMs = Number(process.env.SPLITMATE_WHATSAPP_REFRESH_MAX_WAIT_MS) || 6000,
  cacheMs = Number(process.env.SPLITMATE_WHATSAPP_SNAPSHOT_CACHE_MS) || 5000,
  wait = sleep,
  now = () => Date.now(),
} = {}) {
  if (!groupId || !client?.getChatById || !client?.getState) {
    throw new Error("WhatsApp recent-message freshness cannot be verified.");
  }
  attachMessageSnapshotTracker(client);
  const state = stateFor(client);
  const cached = state.cache.get(groupId);
  if (cached && now() - cached.refreshedAtMs <= cacheMs) return cached;

  const connectionState = await client.getState();
  if (connectionState !== "CONNECTED") {
    throw new Error(`WhatsApp recent-message freshness is unverified while state is ${connectionState || "unknown"}.`);
  }
  const chat = await client.getChatById(groupId);
  if (!chat?.fetchMessages || !chat?.syncHistory) {
    throw new Error("The installed WhatsApp client cannot refresh recent chat history safely.");
  }

  let messages = mergeMessages(await chat.fetchMessages({ limit: recentLimit }), state.groups.get(groupId));
  let fingerprint = snapshotFingerprint(messages);
  const refreshStartedAt = now();
  let syncRequested;
  try {
    syncRequested = await chat.syncHistory();
  } catch (error) {
    throw new Error(`WhatsApp recent-message refresh failed: ${error.message}`);
  }

  let stableReads = 0;
  while (now() - refreshStartedAt <= maxWaitMs) {
    await wait(Math.max(0, pollMs));
    const next = mergeMessages(await chat.fetchMessages({ limit: recentLimit }), state.groups.get(groupId));
    const nextFingerprint = snapshotFingerprint(next);
    stableReads = nextFingerprint === fingerprint ? stableReads + 1 : 0;
    messages = next;
    fingerprint = nextFingerprint;
    if (now() - refreshStartedAt >= minimumWaitMs && stableReads >= 2) break;
  }
  if (now() - refreshStartedAt > maxWaitMs || stableReads < 2) {
    throw new Error("WhatsApp recent-message refresh did not converge; scan freshness is unverified.");
  }
  const finalConnectionState = await client.getState();
  if (finalConnectionState !== "CONNECTED") {
    throw new Error("WhatsApp disconnected during recent-message refresh; scan freshness is unverified.");
  }

  const stats = discoveryStats(messages);
  const result = {
    verified: true,
    source: "syncHistory+fetchMessages+events",
    connectionState: finalConnectionState,
    syncRequested: syncRequested === true,
    refreshedAt: new Date(now()).toISOString(),
    refreshedAtMs: now(),
    messages,
    ...stats,
  };
  state.cache.set(groupId, result);
  logger.log?.(
    `[WhatsApp:Recent] group=${groupId} messages=${stats.messageCount} newest=${stats.newestTimestamp ? new Date(stats.newestTimestamp * 1000).toISOString() : "none"} images=${stats.imageCount} rejected=${stats.rejectedCandidateCount} freshness=verified`,
  );
  return result;
}

module.exports = {
  attachMessageSnapshotTracker,
  discoveryStats,
  mergeMessages,
  normaliseMessage,
  refreshRecentMessageSnapshot,
};
