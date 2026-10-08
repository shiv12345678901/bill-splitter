const path = require("path");
module.exports = function registerGroups(
  socket,
  getConnection,
  { loadUserConfig, detectSettlementCycles, downloadMediaBuffer },
) {
  // Query chat for last "clear up to date" checkpoint
  socket.on("get:last_checkpoint", async ({ groupId }) => {
    const { client, clientStatus } = getConnection();
    if (!client || clientStatus !== "READY" || !client.pupPage) {
      return socket.emit("group:checkpoint", { groupId, checkpoint: null });
    }

    try {
      const checkpoint = await client.pupPage.evaluate(async (gId) => {
        const chatColl = window.require("WAWebCollections")?.Chat;
        let c = chatColl?.get(gId);
        if (!c && chatColl) {
          const all = chatColl.getModelsArray
            ? chatColl.getModelsArray()
            : chatColl._models || [];
          c = all.find((m) => (m.id?._serialized || m.id?.$1 || m.id) === gId);
        }
        if (!c) return null;

        // Open chat if not open
        try {
          const openJob = window.require("WAWebChatOpenJob");
          if (openJob && typeof openJob.openChat === "function") {
            await openJob.openChat({ chat: c });
          }
        } catch (e) {}

        const checkpointRegex =
          /\b(clear(?:ed)?\s*(?:up\s*to|upto|till)|settled?\s*(?:up\s*to|upto|till)|all\s*cleared|all\s*settled|clear\s*date)\b/i;

        // Load earlier messages until a checkpoint is found (up to 12 batches)
        const loader = window.require("WAWebChatLoadMessages");
        if (loader && typeof loader.loadEarlierMsgs === "function") {
          for (let i = 0; i < 12; i++) {
            const msgs = c.msgs
              ? c.msgs.getModelsArray
                ? c.msgs.getModelsArray()
                : c.msgs._models || []
              : [];
            const hasCheckpoint = msgs.some((m) => {
              const body =
                m.body || m.caption || (m._data && m._data.body) || "";
              return typeof body === "string" && checkpointRegex.test(body);
            });
            if (hasCheckpoint) break;
            const earlier = await loader.loadEarlierMsgs({ chat: c });
            if (!earlier || !earlier.length) break;
            await new Promise((r) => setTimeout(r, 60));
          }
        }

        const allMsgs = c.msgs
          ? c.msgs.getModelsArray
            ? c.msgs.getModelsArray()
            : c.msgs._models || []
          : [];
        const sorted = [...allMsgs].sort(
          (a, b) => (b.t || b.timestamp || 0) - (a.t || a.timestamp || 0),
        );

        for (const m of sorted) {
          if (!m || m.isNotification) continue;
          const text = m.body || m.caption || (m._data && m._data.body) || "";
          if (typeof text === "string" && checkpointRegex.test(text)) {
            const ts = m.t || m.timestamp || 0;
            return {
              id: m.id?._serialized || m.id?.$1 || m.id,
              text: text.trim().replace(/\n+/g, " ").substring(0, 100),
              timestamp: ts,
              dateStr: new Date(ts * 1000).toISOString().split("T")[0],
              fullDate: new Date(ts * 1000).toLocaleDateString("en-AU", {
                day: "numeric",
                month: "short",
                year: "numeric",
              }),
            };
          }
        }
        return null;
      }, groupId);

      socket.emit("group:checkpoint", { groupId, checkpoint });

      // Concurrently discover settlement cycles for this group
      detectSettlementCycles(groupId)
        .then((cycles) => {
          socket.emit("group:cycles", { groupId, cycles });
        })
        .catch((err) =>
          console.warn("[Cycles] Auto-detect error:", err.message),
        );
    } catch (e) {
      socket.emit("group:checkpoint", { groupId, checkpoint: null });
    }
  });

  // Query chat for all detected settlement cycles and boundary separation
  socket.on("get:cycles", async ({ groupId }) => {
    const { client, clientStatus } = getConnection();
    if (!client || clientStatus !== "READY") {
      return socket.emit("group:cycles", { groupId, cycles: [] });
    }
    try {
      console.log(`[Cycles] Detecting settlement cycles for ${groupId}...`);
      const cycles = await detectSettlementCycles(groupId);
      console.log(
        `[Cycles] Discovered ${cycles.length} settlement cycles for ${groupId}.`,
      );
      socket.emit("group:cycles", { groupId, cycles });
    } catch (err) {
      console.error("Error detecting settlement cycles:", err);
      socket.emit("group:cycles", { groupId, cycles: [] });
    }
  });

  // Fetch media buffer data on demand for preview modal
  socket.on("get:media_data", async ({ msgId, groupId }) => {
    const { client, clientStatus } = getConnection();
    try {
      const media = await downloadMediaBuffer(client, msgId, groupId);
      if (media && media.data) {
        const mime = media.mimetype || "image/jpeg";
        socket.emit("media:data", {
          msgId,
          dataUrl: `data:${mime};base64,${media.data}`,
        });
      } else {
        socket.emit("media:data", { msgId, error: "Could not load photo" });
      }
    } catch (e) {
      socket.emit("media:data", { msgId, error: e.message });
    }
  });
};
