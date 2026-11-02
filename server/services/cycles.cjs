const { loadUserConfig } = require("./config.cjs");
const library = require("./library.cjs");
const { buildSettlementCycles } = require("./cycle-state.cjs");

function messageId(message) {
  if (typeof message?.id === "string") return message.id;
  return message?.id?._serialized || message?.id?.$1 || "";
}

async function detectSettlementCycles(groupId, client) {
  if (!client?.pupPage) return [];
  const config = loadUserConfig();
  try {
    const chat = await client.getChatById(groupId);
    await chat.fetchMessages({ limit: Infinity });
  } catch (error) {
    console.warn("[Cycles] Full history preload was incomplete:", error.message);
  }

  const searched = [];
  const searchedIds = new Set();
  for (const query of ["clear", "settled", "calculation", "total =="]) {
    try {
      const matches = await client.searchMessages(query, { chatId: groupId, limit: 100, page: 0 });
      for (const message of matches || []) {
        const id = messageId(message);
        if (!id || searchedIds.has(id)) continue;
        searchedIds.add(id);
        searched.push({
          id,
          timestamp: message.timestamp || 0,
          body: message.body || "",
          isNotification: false,
          isMedia: Boolean(message.hasMedia || message.isMedia),
          author: message.author || message.from || "",
        });
      }
    } catch (error) {
      console.warn(`[Cycles] History search for "${query}" failed:`, error.message);
    }
  }

  const inPage = await client.pupPage.evaluate(async (gId) => {
    try {
      const collection = window.require("WAWebCollections")?.Chat;
      let chat = collection?.get(gId);
      if (!chat && collection) {
        const all = collection.getModelsArray ? collection.getModelsArray() : collection._models || [];
        chat = all.find((model) => (model.id?._serialized || model.id?.$1 || model.id) === gId);
      }
      if (!chat) return [];
      try {
        const opener = window.require("WAWebChatOpenJob");
        if (opener?.openChat) await opener.openChat({ chat });
      } catch {}
      const loader = window.require("WAWebChatLoadMessages");
      if (loader?.loadEarlierMsgs) {
        for (let index = 0; index < 400; index += 1) {
          const earlier = await loader.loadEarlierMsgs({ chat });
          if (!earlier?.length) break;
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      }
      const models = chat.msgs
        ? chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : chat.msgs._models || []
        : [];
      return models.map((message) => {
        const id = typeof message.id === "string" ? message.id : message.id?._serialized || message.id?.$1 || "";
        const author = typeof message.author === "string"
          ? message.author
          : message.author?._serialized || message.author?.$1 || message.from?._serialized || message.from?.$1 || "";
        let preview = "";
        let rawPreview = message.mediaData?.preview || message.mediaData?._preview;
        if (rawPreview?._b64) rawPreview = rawPreview._b64;
        if (typeof rawPreview === "string" && rawPreview.length > 20) preview = `data:image/jpeg;base64,${rawPreview}`;
        if (!preview && id) preview = `/api/media?id=${encodeURIComponent(id)}&groupId=${encodeURIComponent(gId)}`;
        return {
          id,
          timestamp: message.t || message.timestamp || 0,
          body: message.body || message.caption || message._data?.body || "",
          isNotification: Boolean(message.isNotification),
          isMedia: Boolean(message.isMedia || message.mediaData || message.type === "image" || message.mimetype?.startsWith("image/")),
          author,
          preview,
        };
      });
    } catch {
      return [];
    }
  }, groupId);

  const messages = [...(inPage || []), ...searched].map((message) => {
    if (!message.isMedia) return message;
    const known = library.findById(message.id);
    return {
      ...message,
      classification: known
        ? known.isBankTransfer ? "bank_transfer" : known.merchant ? "grocery_receipt" : "unclassified"
        : "unclassified",
    };
  });
  return buildSettlementCycles({
    groupId,
    aliases: config.aliases || {},
    configuredGroupStart: config.groupStartDates?.[groupId] || null,
    messages,
  });
}

module.exports = { detectSettlementCycles };
