async function loadChatHistory(client, groupId, fetchLimit, startUnix = null) {
  return await client.pupPage.evaluate(
    async (gId, limit, cutoff) => {
      const chatColl = window.require("WAWebCollections")?.Chat;
      let c = chatColl?.get(gId);
      if (!c && chatColl) {
        const all = chatColl.getModelsArray() || [];
        c = all.find((m) => {
          const idStr =
            m.id?._serialized ||
            m.id?.$1 ||
            (typeof m.id === "string" ? m.id : "");
          return idStr === gId;
        });
      }
      if (!c) throw new Error("The selected WhatsApp group is unavailable.");

      // Open chat
      try {
        const openJob = window.require("WAWebChatOpenJob");
        if (openJob && typeof openJob.openChat === "function") {
          await openJob.openChat({ chat: c });
        }
      } catch (e) {}

      try {
        const cmd = window.require("WAWebCmd");
        if (cmd && typeof cmd.openChatAt === "function") {
          cmd.openChatAt(c);
        }
      } catch (e) {}

      // Sync walks back to the settlement date instead of stopping at a message count.
      const loader = window.require("WAWebChatLoadMessages");
      let stalled = 0;
      if (loader && typeof loader.loadEarlierMsgs === "function") {
        for (let i = 0; i < (cutoff === null ? 20 : 500); i++) {
          const msgs = c.msgs
            ? c.msgs.getModelsArray
              ? c.msgs.getModelsArray()
              : c.msgs._models || []
            : [];
          const oldest = Math.min(
            ...msgs.map((m) => Number(m.t || m.timestamp)).filter((t) => t > 0),
          );
          if (cutoff !== null ? oldest <= cutoff : msgs.length >= limit) return;
          const earlier = await loader.loadEarlierMsgs({ chat: c });
          const after = c.msgs?.getModelsArray
            ? c.msgs.getModelsArray()
            : c.msgs?._models || [];
          const afterOldest = Math.min(
            ...after
              .map((m) => Number(m.t || m.timestamp))
              .filter((t) => t > 0),
          );
          if (afterOldest < oldest || after.length > msgs.length) stalled = 0;
          else if (Array.isArray(earlier) && earlier.length === 0) return;
          else if (++stalled >= 3)
            throw new Error(
              "WhatsApp stopped loading older messages. Reconnect and retry.",
            );
          await new Promise((r) => setTimeout(r, 70));
        }
      }
      if (cutoff !== null)
        throw new Error(
          "WhatsApp could not finish loading this date range. Retry the sync.",
        );
    },
    groupId,
    fetchLimit,
    startUnix,
  );
}

async function readReceiptCandidates(
  client,
  groupId,
  startUnix,
  endUnix,
  useCheckpoint,
) {
  return await client.pupPage.evaluate(
    (gId, sUnix, eUnix, useChk) => {
      try {
        const chatColl = window.require("WAWebCollections")?.Chat;
        let c = chatColl?.get(gId);
        if (!c && chatColl) {
          const all = chatColl.getModelsArray
            ? chatColl.getModelsArray()
            : chatColl._models || [];
          c = all.find((m) => {
            const idStr =
              m.id?._serialized ||
              m.id?.$1 ||
              (typeof m.id === "string" ? m.id : "");
            return idStr === gId;
          });
        }
        if (!c || !c.msgs)
          return {
            error: "The selected WhatsApp group is unavailable.",
            name: "",
            messages: [],
            checkpoint: null,
            effectiveStartUnix: sUnix,
          };

        const name = c.formattedTitle || c.name || "";
        const allMsgs = c.msgs.getModelsArray
          ? c.msgs.getModelsArray()
          : c.msgs._models || [];

        // Scan for last "clear up to date" checkpoint message
        let detectedCheckpoint = null;
        const sortedDesc = [...allMsgs].sort(
          (a, b) => (b.t || b.timestamp || 0) - (a.t || a.timestamp || 0),
        );
        const checkpointRegex =
          /\b(clear(?:ed)?\s*(?:up\s*to|upto|till)|settled?\s*(?:up\s*to|upto|till)|all\s*cleared|all\s*settled|clear\s*date)\b/i;

        for (const m of sortedDesc) {
          if (!m || m.isNotification) continue;
          const body = m.body || m.caption || (m._data && m._data.body) || "";
          if (typeof body === "string" && checkpointRegex.test(body)) {
            const ts = m.t || m.timestamp || 0;
            detectedCheckpoint = {
              id: m.id?._serialized || m.id?.$1 || m.id,
              text: body.trim().replace(/\n+/g, " ").substring(0, 100),
              timestamp: ts,
              dateStr: new Date(ts * 1000).toISOString().split("T")[0],
              fullDate: new Date(ts * 1000).toLocaleDateString("en-AU", {
                day: "numeric",
                month: "short",
                year: "numeric",
              }),
            };
            break;
          }
        }

        let effectiveStartUnix = sUnix;
        if (useChk && detectedCheckpoint && detectedCheckpoint.timestamp > 0) {
          effectiveStartUnix = detectedCheckpoint.timestamp + 1;
        }

        const filtered = allMsgs
          .filter((m) => {
            if (!m || m.isNotification) return false;
            const ts = m.t || m.timestamp || 0;
            const inWindow = ts >= effectiveStartUnix && ts <= eUnix;
            const isMedia = Boolean(
              m.isMedia ||
              m.mediaData ||
              m.type === "image" ||
              (m.mimetype && m.mimetype.startsWith("image/")),
            );
            return inWindow && isMedia;
          })
          .map((m) => {
            const idStr =
              m.id?._serialized ||
              m.id?.$1 ||
              (typeof m.id === "string" ? m.id : "");
            const authorStr =
              m.author?._serialized ||
              m.author?.$1 ||
              (typeof m.author === "string"
                ? m.author
                : m.from?._serialized || m.from?.$1 || "");
            return {
              id: idStr,
              timestamp: m.t || m.timestamp || 0,
              author: authorStr,
              from: m.from?._serialized || m.from?.$1 || authorStr,
            };
          });

        return {
          name,
          messages: filtered,
          checkpoint: detectedCheckpoint,
          effectiveStartUnix,
        };
      } catch (err) {
        return {
          name: "",
          messages: [],
          checkpoint: null,
          effectiveStartUnix: sUnix,
          error: err.message,
        };
      }
    },
    groupId,
    startUnix,
    endUnix,
    useCheckpoint,
  );
}
module.exports = { loadChatHistory, readReceiptCandidates };
