module.exports = function registerGroups(
  socket,
  getConnection,
  { loadUserConfig, detectSettlementCycles, downloadMediaBuffer },
) {
  // Get group participants (for auto-populating alias manager)
  socket.on("get:group_participants", async ({ groupId }) => {
    const { client, clientStatus } = getConnection();
    if (!client || clientStatus !== "READY") return;
    try {
      console.log(`[WhatsApp] Fetching participants for group: ${groupId}`);
      let participants = [];

      // Primary: In-page direct server-query for accurate group metadata
      if (client.pupPage) {
        try {
          participants = await client.pupPage.evaluate(async (gId) => {
            try {
              let wid = null;
              try {
                wid = window.require("WAWebWidFactory").createWid(gId);
              } catch (e) {}

              // 1. Force WhatsApp Web to sync metadata from server
              try {
                const queryJob = window.require("WAWebGroupQueryJob");
                if (
                  queryJob &&
                  typeof queryJob.queryAndUpdateGroupMetadataById ===
                    "function" &&
                  wid
                ) {
                  await queryJob.queryAndUpdateGroupMetadataById({ id: wid });
                }
              } catch (qErr) {}

              try {
                const gMetaColl =
                  window.require("WAWebCollections")?.GroupMetadata ||
                  window.require("WAWebCollections")
                    ?.WAWebGroupMetadataCollection;
                if (
                  gMetaColl &&
                  typeof gMetaColl.update === "function" &&
                  wid
                ) {
                  await gMetaColl.update(wid);
                }
              } catch (e) {}

              // 2. Locate the chat model
              const chatColl = window.require("WAWebCollections")?.Chat;
              let chatModel = null;
              if (wid && chatColl) {
                try {
                  chatModel = chatColl.get(wid);
                } catch (e) {}
              }
              if (!chatModel && chatColl) {
                try {
                  chatModel = chatColl.get(gId);
                } catch (e) {}
              }
              if (!chatModel && chatColl) {
                const all = chatColl.getModelsArray() || [];
                chatModel = all.find((m) => {
                  const idStr =
                    m.id?._serialized ||
                    m.id?.$1 ||
                    (typeof m.id === "string" ? m.id : "");
                  return idStr === gId;
                });
              }

              // 3. Locate group metadata
              const gMetaColl =
                window.require("WAWebCollections")?.GroupMetadata ||
                window.require("WAWebCollections")
                  ?.WAWebGroupMetadataCollection;
              let meta = chatModel?.groupMetadata;
              if (!meta && gMetaColl && wid) {
                try {
                  meta = gMetaColl.get(wid);
                } catch (e) {}
              }
              if (!meta && gMetaColl) {
                try {
                  meta = gMetaColl.get(gId);
                } catch (e) {}
              }

              if (!meta) return [];

              // 4. Extract participants
              let rawParts = [];
              if (meta.participants) {
                if (Array.isArray(meta.participants)) {
                  rawParts = meta.participants;
                } else if (
                  typeof meta.participants.getModelsArray === "function"
                ) {
                  rawParts = meta.participants.getModelsArray();
                } else if (meta.participants._models) {
                  rawParts = meta.participants._models;
                } else if (typeof meta.participants.serialize === "function") {
                  rawParts = meta.participants.serialize();
                }
              }

              const toPn = window.require("WAWebLidMigrationUtils")?.toPn;
              const getPhoneNumber =
                window.require("WAWebApiContact")?.getPhoneNumber;
              const contactColl = window.require("WAWebCollections")?.Contact;

              return rawParts.map((p) => {
                const pId = p.id || p;
                const isLid =
                  pId?.server === "lid" ||
                  (typeof pId === "string" && pId.endsWith("@lid"));
                let phoneWid = pId;
                if (isLid) {
                  if (getPhoneNumber) {
                    try {
                      phoneWid = getPhoneNumber(pId) || phoneWid;
                    } catch (e) {}
                  }
                  if (phoneWid === pId && toPn) {
                    try {
                      phoneWid = toPn(pId) || phoneWid;
                    } catch (e) {}
                  }
                }

                const idStr =
                  phoneWid?._serialized ||
                  phoneWid?.$1 ||
                  (typeof phoneWid === "string"
                    ? phoneWid
                    : pId?._serialized || pId?.$1 || "");
                const userNum =
                  phoneWid?.user ||
                  (typeof idStr === "string"
                    ? idStr.split("@")[0]
                    : pId?.user || "");

                let contact = null;
                if (contactColl) {
                  try {
                    contact =
                      contactColl.get(phoneWid) ||
                      contactColl.get(pId) ||
                      contactColl.get(idStr);
                  } catch (e) {}
                }

                const pushname =
                  contact?.pushname ||
                  contact?.name ||
                  contact?.formattedName ||
                  p.contact?.pushname ||
                  p.contact?.name ||
                  p.name ||
                  "";

                return {
                  id: idStr,
                  number: userNum,
                  name: pushname || userNum || "Flatmate",
                };
              });
            } catch (err) {
              return [];
            }
          }, groupId);
        } catch (pageErr) {
          console.warn(
            "[WhatsApp] In-page participant evaluation error:",
            pageErr.message,
          );
        }
      }

      // If in-page evaluation was empty, fallback to client.getChatById
      if (!participants || participants.length === 0) {
        try {
          const chat = await client.getChatById(groupId);
          if (
            chat &&
            chat.isGroup &&
            chat.participants &&
            chat.participants.length > 0
          ) {
            for (const p of chat.participants) {
              const pId = p.id?._serialized || p.id?.$1 || p.id;
              const userNum =
                p.id?.user ||
                (typeof pId === "string" ? pId.split("@")[0] : "");
              try {
                const contact = await client.getContactById(pId);
                participants.push({
                  id: pId,
                  number: contact?.number || userNum,
                  name:
                    contact?.pushname ||
                    contact?.name ||
                    contact?.number ||
                    userNum,
                });
              } catch (e) {
                participants.push({
                  id: pId,
                  number: userNum,
                  name: userNum,
                });
              }
            }
          }
        } catch (e) {}
      }

      console.log(
        `[WhatsApp] Successfully found ${participants.length} members for ${groupId}:`,
        participants.map((p) => p.name),
      );
      socket.emit("group:participants", { groupId, participants });
    } catch (err) {
      console.error("Error fetching group participants:", err);
      socket.emit("group:participants", { groupId, participants: [] });
    }
  });
};
