async function ensureCollectionBridge(client) {
  if (!client?.pupPage?.evaluate) throw new Error("WhatsApp page evaluation is unavailable.");
  return client.pupPage.evaluate(() => {
    window.SplitMateWACollection = {
      findChat(groupId) {
        const collection = window.require("WAWebCollections")?.Chat;
        if (!collection) return null;
        let chat = null;
        try {
          chat = collection.get(groupId);
        } catch {}
        if (!chat) {
          try {
            const wid = window.require("WAWebWidFactory")?.createWid?.(groupId);
            if (wid) chat = collection.get(wid);
          } catch {}
        }
        if (chat) return chat;
        const all = collection.getModelsArray
          ? collection.getModelsArray()
          : collection._models || [];
        return all.find((model) => {
          const id = typeof model?.id === "string"
            ? model.id
            : model?.id?._serialized || model?.id?.$1 || "";
          return id === groupId;
        }) || null;
      },
      messages(chat) {
        if (!chat?.msgs) return [];
        return chat.msgs.getModelsArray
          ? chat.msgs.getModelsArray()
          : chat.msgs._models || [];
      },
      serializeMessage(message) {
        const serializeId = (value) => typeof value === "string"
          ? value
          : value?._serialized || value?.$1 || "";
        const id = serializeId(message?.id);
        const type = String(message?.type || message?._data?.type || "").trim().toLowerCase();
        const mimetype = String(
          message?.mimetype || message?.mediaData?.mimetype ||
          message?.mediaData?.fullMimetype || message?._data?.mimetype || "",
        ).split(";")[0].trim().toLowerCase();
        return {
          id,
          timestamp: Number(message?.t || message?.timestamp || 0),
          body: String(message?.body || message?.caption || message?._data?.body || ""),
          isNotification: Boolean(message?.isNotification),
          hasMedia: Boolean(message?.hasMedia || message?.mediaData),
          type,
          mimetype,
          author: serializeId(message?.author) || serializeId(message?.from),
          from: serializeId(message?.from),
          to: serializeId(message?.to),
        };
      },
    };
    return true;
  });
}

async function fetchRecentCollectionMessages(client, groupId, limit) {
  await ensureCollectionBridge(client);
  return client.pupPage.evaluate(async (gId, requestedLimit) => {
    const bridge = window.SplitMateWACollection;
    const chat = bridge?.findChat(gId);
    if (!chat) throw new Error("The selected WhatsApp group is unavailable in the chat collection.");
    try {
      const opener = window.require("WAWebChatOpenJob");
      if (opener?.openChat) await opener.openChat({ chat });
    } catch {}
    const messages = bridge.messages(chat)
      .filter((message) => message && !message.isNotification)
      .sort((left, right) =>
        Number(left.t || left.timestamp || 0) - Number(right.t || right.timestamp || 0));
    const count = Math.max(1, Number(requestedLimit) || 250);
    return messages.slice(-count).map((message) => bridge.serializeMessage(message));
  }, groupId, limit);
}

module.exports = {
  ensureCollectionBridge,
  fetchRecentCollectionMessages,
};
