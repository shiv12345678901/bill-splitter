const { loadUserConfig } = require("./config.cjs");
const library = require("./library.cjs");
const { buildSettlementCycles } = require("./cycle-state.cjs");
const { ensureCollectionBridge } = require("./whatsapp-collection.cjs");
const { isGenuineImageMessage, messageMimeType, messageType } = require("./whatsapp-media.cjs");
const {
  discoveryStats,
  mergeMessages,
  refreshRecentMessageSnapshot,
  runWhatsAppOperation,
  safeErrorMessage,
} = require("./whatsapp-snapshot.cjs");

function messageId(message) {
  if (typeof message?.id === "string") return message.id;
  return message?.id?._serialized || message?.id?.$1 || "";
}

async function detectSettlementCycles(groupId, client) {
  if (!client?.pupPage) throw new Error("WhatsApp page is unavailable; message freshness is unverified.");
  const config = loadUserConfig();
  const recent = await refreshRecentMessageSnapshot(groupId, client);

  const searched = [];
  const searchedIds = new Set();
  for (const query of ["clear", "settled", "calculation", "total =="]) {
    try {
      const matches = await runWhatsAppOperation(
        "search_history",
        () => client.searchMessages(query, { chatId: groupId, limit: 100, page: 0 }),
      );
      for (const message of matches || []) {
        const id = messageId(message);
        if (!id || searchedIds.has(id)) continue;
        searchedIds.add(id);
        searched.push({
          id,
          timestamp: message.timestamp || 0,
          body: message.body || "",
          isNotification: false,
          type: messageType(message),
          mimetype: messageMimeType(message),
          isMedia: isGenuineImageMessage(message),
          author: message.author || message.from || "",
        });
      }
    } catch (error) {
      console.warn(`[Cycles] Optional history search failed: ${safeErrorMessage(error)}`);
    }
  }

  await runWhatsAppOperation("prepare_collection_lookup", () => ensureCollectionBridge(client));
  const inPage = await runWhatsAppOperation("evaluate_history", () => client.pupPage.evaluate(async (gId) => {
    try {
      const chat = window.SplitMateWACollection?.findChat(gId);
      if (!chat) return { complete: false, error: "The selected WhatsApp group is unavailable.", messages: [] };
      try {
        const opener = window.require("WAWebChatOpenJob");
        if (opener?.openChat) await opener.openChat({ chat });
      } catch {}
      const loader = window.require("WAWebChatLoadMessages");
      let complete = false;
      if (loader?.loadEarlierMsgs) {
        let stalled = 0;
        for (let index = 0; index < 400; index += 1) {
          const before = window.SplitMateWACollection.messages(chat);
          const beforeOldest = Math.min(
            ...before.map((message) => Number(message.t || message.timestamp)).filter((value) => value > 0),
          );
          const earlier = await loader.loadEarlierMsgs({ chat });
          if (Array.isArray(earlier) && earlier.length === 0) {
            complete = true;
            break;
          }
          const after = window.SplitMateWACollection.messages(chat);
          const afterOldest = Math.min(
            ...after.map((message) => Number(message.t || message.timestamp)).filter((value) => value > 0),
          );
          if (after.length > before.length || afterOldest < beforeOldest) stalled = 0;
          else if (++stalled >= 3)
            throw new Error("WhatsApp stopped loading older cycle history.");
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
      const models = window.SplitMateWACollection.messages(chat);
      const messages = models.map((message) => {
        const id = typeof message.id === "string" ? message.id : message.id?._serialized || message.id?.$1 || "";
        const author = typeof message.author === "string"
          ? message.author
          : message.author?._serialized || message.author?.$1 || message.from?._serialized || message.from?.$1 || "";
        let preview = "";
        let rawPreview = message.mediaData?.preview || message.mediaData?._preview;
        if (rawPreview?._b64) rawPreview = rawPreview._b64;
        if (typeof rawPreview === "string" && rawPreview.length > 20) preview = `data:image/jpeg;base64,${rawPreview}`;
        if (!preview && id) preview = `/api/media?id=${encodeURIComponent(id)}&groupId=${encodeURIComponent(gId)}`;
        const type = String(message.type || message._data?.type || "").trim().toLowerCase();
        const mimetype = String(
          message.mimetype || message.mediaData?.mimetype ||
          message.mediaData?.fullMimetype || message._data?.mimetype || "",
        ).split(";")[0].trim().toLowerCase();
        const imageMime = /^image\/(?:jpeg|jpg|png|webp|heic|heif)$/i.test(mimetype);
        return {
          id,
          timestamp: message.t || message.timestamp || 0,
          body: message.body || message.caption || message._data?.body || "",
          isNotification: Boolean(message.isNotification),
          type,
          mimetype,
          isMedia: !message.isNotification && (!type || type === "image") &&
            (!mimetype || imageMime) && (type === "image" || imageMime),
          author,
          preview,
        };
      });
      return { complete, messages };
    } catch (error) {
      return { complete: false, error: error?.message || "WhatsApp history discovery failed.", messages: [] };
    }
  }, groupId), { timeoutMs: 60000 });

  if (!inPage?.complete) {
    throw new Error(
      `WhatsApp history is incomplete; refusing to finalize this scan. ${inPage?.error || "Reconnect and retry."}`,
    );
  }

  const messages = mergeMessages(inPage.messages, searched, recent.messages).map((message) => {
    const isMedia = isGenuineImageMessage(message);
    if (!isMedia) return { ...message, isMedia: false };
    const known = library.findById(message.id);
    return {
      ...message,
      isMedia,
      classification: known
        ? known.isBankTransfer ? "bank_transfer" : known.merchant ? "grocery_receipt" : "unclassified"
        : "unclassified",
    };
  });
  const stats = discoveryStats(messages);
  console.log(
    `[WhatsApp:Discovery] messages=${stats.messageCount} newest=${stats.newestTimestamp ? new Date(stats.newestTimestamp * 1000).toISOString() : "none"} images=${stats.imageCount} rejected=${stats.rejectedCandidateCount} cycle_history=complete recent_delivery=${recent.deliveryCompleteness}`,
  );
  const cycles = buildSettlementCycles({
    groupId,
    aliases: config.aliases || {},
    configuredGroupStart: config.groupStartDates?.[groupId] || null,
    messages,
  });
  cycles.snapshot = {
    retrievalVerified: recent.retrievalVerified === true,
    freshness: recent.freshness,
    deliveryCompleteness: recent.deliveryCompleteness,
    historyTransfer: recent.historyTransfer,
    refreshedAt: recent.refreshedAt,
    source: recent.source,
    ...stats,
  };
  return cycles;
}

module.exports = { detectSettlementCycles };
