module.exports = function registerGroups(
  socket,
  getConnection,
  { loadUserConfig, detectSettlementCycles, downloadMediaBuffer },
) {
  // Detect settlement cycles in a group: "clear up to date" messages end
  // each cycle, the newest one starts the current active cycle. With
  // `save: true` the detected cycles persist to the local cycle log.
  socket.on("detect:cycles", async ({ groupId, save } = {}) => {
    const { client, clientStatus } = getConnection();
    if (!client || clientStatus !== "READY") {
      return socket.emit("cycles:detected", {
        error: "WhatsApp client is not ready.",
        cycles: [],
      });
    }
    try {
      const cycles = await detectSettlementCycles(groupId);
      if (save) {
        try {
          const { upsertDetectedCycles, loadSettlementCycles } = require("../services/library.cjs");
          const userCfg = loadUserConfig();
          const groupName =
            groupId === userCfg.defaultGroupId ? userCfg.defaultGroupName : "";
          const saved = await upsertDetectedCycles(groupId, groupName, cycles);
          socket.emit("cycles:list", { cycles: saved });
        } catch (saveErr) {
          console.warn("[Cycles] Could not save detected cycles:", saveErr.message);
        }
      }
      socket.emit("cycles:detected", { cycles });
    } catch (err) {
      socket.emit("cycles:detected", { error: err.message, cycles: [] });
    }
  });

  // Get available group chats
  socket.on("get:groups", async () => {
    const { client, clientStatus } = getConnection();
    if (!client || clientStatus !== "READY") {
      return socket.emit("groups:list", {
        error: "WhatsApp client is not ready. Please pair your device first.",
      });
    }

    try {
      // 1. Scroll through #pane-side to force WhatsApp Web virtual list to load ALL chats into memory
      if (client.pupPage) {
        try {
          await client.pupPage.evaluate(async () => {
            const pane = document.querySelector("#pane-side");
            if (pane) {
              for (let i = 0; i < 14; i++) {
                pane.scrollTop += 900;
                await new Promise((r) => setTimeout(r, 120));
              }
              pane.scrollTop = 0;
            }
          });
        } catch (scrollErr) {
          console.warn("[WhatsApp] Virtual scroll error:", scrollErr.message);
        }
      }

      let groups = [];
      try {
        const chats = await client.getChats();
        groups = (chats || [])
          .filter((c) => c && c.isGroup)
          .map((g) => {
            const id =
              g.id?._serialized ||
              g.id?.$1 ||
              (typeof g.id === "string" ? g.id : "");
            return {
              id,
              name: g.name || g.formattedTitle || "Unnamed Group",
              participantsCount: g.participants
                ? g.participants.length
                : g.groupMetadata?.participants?.length || 0,
              unreadCount: g.unreadCount || 0,
            };
          })
          .filter((g) => Boolean(g.id));
      } catch (err) {
        console.warn(
          "[WhatsApp] client.getChats() encountered error, falling back to direct page evaluation:",
          err.message,
        );
      }

      // 2. Direct page evaluation fallback from in-memory Chat collections
      if (client.pupPage) {
        try {
          const directGroups = await client.pupPage.evaluate(() => {
            try {
              const chatModels =
                window.require("WAWebCollections")?.Chat?.getModelsArray() ||
                [];
              const gMetaColl =
                window.require("WAWebCollections")?.GroupMetadata ||
                window.require("WAWebCollections")
                  ?.WAWebGroupMetadataCollection;

              return chatModels
                .filter((c) => {
                  if (!c) return false;
                  const idStr =
                    c.id?._serialized ||
                    c.id?.$1 ||
                    (typeof c.id === "string" ? c.id : "");
                  return (
                    Boolean(c.isGroup) ||
                    Boolean(c.groupMetadata) ||
                    idStr.endsWith("@g.us") ||
                    c.id?.server === "g.us"
                  );
                })
                .map((c) => {
                  const idStr =
                    c.id?._serialized ||
                    c.id?.$1 ||
                    (typeof c.id === "string" ? c.id : "");
                  let pCount = 0;
                  try {
                    const meta =
                      c.groupMetadata ||
                      (gMetaColl
                        ? gMetaColl.get(c.id) || gMetaColl.get(idStr)
                        : null);
                    const parts = meta?.participants;
                    if (Array.isArray(parts)) pCount = parts.length;
                    else if (parts?._models) pCount = parts._models.length;
                    else if (typeof parts?.getModelsArray === "function")
                      pCount = parts.getModelsArray().length;
                    else if (c.participantsCount) pCount = c.participantsCount;
                  } catch (e) {}
                  return {
                    id: idStr,
                    name: c.formattedTitle || c.name || "Unnamed Group",
                    participantsCount: pCount,
                    unreadCount: c.unreadCount || 0,
                  };
                })
                .filter((g) => Boolean(g.id));
            } catch (e) {
              return [];
            }
          });

          // Merge without duplicates
          const seen = new Set(groups.map((g) => g.id));
          (directGroups || []).forEach((dg) => {
            if (!seen.has(dg.id)) {
              seen.add(dg.id);
              groups.push(dg);
            }
          });
        } catch (evalErr) {
          console.error(
            "[WhatsApp] Direct page evaluation error:",
            evalErr.message,
          );
        }
      }

      const userCfg = loadUserConfig();
      groups.sort((a, b) => {
        const aIsDef =
          a.id === userCfg.defaultGroupId ||
          (a.name && a.name.toLowerCase().includes("rockdale"));
        const bIsDef =
          b.id === userCfg.defaultGroupId ||
          (b.name && b.name.toLowerCase().includes("rockdale"));
        if (aIsDef && !bIsDef) return -1;
        if (!aIsDef && bIsDef) return 1;
        return (a.name || "").localeCompare(b.name || "");
      });
      console.log(
        `[WhatsApp] Discovered a total of ${groups.length} group chats. Default group: ${userCfg.defaultGroupName}`,
      );
      socket.emit("groups:list", {
        groups,
        defaultGroupId: userCfg.defaultGroupId,
      });
    } catch (err) {
      console.error("Error fetching group chats:", err);
      socket.emit("groups:list", { error: err.message, groups: [] });
    }
  });
};
