const { loadUserConfig } = require("./config.cjs");
async function detectSettlementCycles(groupId, client) {
  if (!client || !client.pupPage) return [];

  const userCfg = loadUserConfig();
  const aliases = userCfg.aliases || {};
  const groupStartDate = userCfg.groupStartDates?.[groupId] || null;

  // Use the library's supported history loader first. The in-page collection
  // can otherwise contain only the most recent virtualised slice, which makes
  // older settlement boundaries disappear from cycle detection.
  try {
    const chat = await client.getChatById(groupId);
    await chat.fetchMessages({ limit: Infinity });
  } catch (err) {
    console.warn("[Cycles] Full history preload was incomplete:", err.message);
  }
  const searchedBoundaries = [];
  const searchedIds = new Set();
  for (const query of ["clear", "settled", "calculation", "total =="]) {
    try {
      const matches = await client.searchMessages(query, {
        chatId: groupId,
        limit: 100,
        page: 0,
      });
      for (const message of matches || []) {
        const id = message.id?._serialized || String(message.id || "");
        if (!id || searchedIds.has(id)) continue;
        searchedIds.add(id);
        searchedBoundaries.push({
          id,
          timestamp: message.timestamp || 0,
          body: message.body || "",
          isNotification: false,
        });
      }
    } catch (err) {
      console.warn(`[Cycles] History search for "${query}" failed:`, err.message);
    }
  }

  return await client.pupPage.evaluate(
    async (gId, userAliases, configuredGroupStart, remoteBoundaries) => {
      try {
        const chatColl = window.require("WAWebCollections")?.Chat;
        let c = chatColl?.get(gId);
        if (!c && chatColl) {
          const all = chatColl.getModelsArray
            ? chatColl.getModelsArray()
            : chatColl._models || [];
          c = all.find((m) => (m.id?._serialized || m.id?.$1 || m.id) === gId);
        }
        if (!c) return [];

        // Open chat if not open
        try {
          const openJob = window.require("WAWebChatOpenJob");
          if (openJob && typeof openJob.openChat === "function") {
            await openJob.openChat({ chat: c });
          }
        } catch (e) {}

        // Deep scroll / load earlier messages until the chat's beginning is
        // reached (batches stop returning rows), so every historical
        // settlement cycle is mapped, not just recent ones.
        const loader = window.require("WAWebChatLoadMessages");
        if (loader && typeof loader.loadEarlierMsgs === "function") {
          for (let i = 0; i < 400; i++) {
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
        const knownIds = new Set(
          allMsgs.map(
            (message) =>
              message.id?._serialized || message.id?.$1 || message.id,
          ),
        );
        const sorted = [
          ...allMsgs,
          ...(remoteBoundaries || []).filter(
            (message) => !knownIds.has(message.id),
          ),
        ].sort(
          (a, b) => (a.t || a.timestamp || 0) - (b.t || b.timestamp || 0),
        );

        const checkpointRegex =
          /\b(clear(?:ed)?\s*(?:up\s*to|upto|till)|settled?\s*(?:up\s*to|upto|till)|all\s*cleared|all\s*settled|clear\s*date)\b/i;

        function isCalculationMessage(text) {
          if (!text || typeof text !== "string") return false;
          const clean = text.trim();

          // 1. MUST NOT match casual text conversations like "today evening is calculation"
          // Without digits/amounts, it can NEVER be a calculation!
          if (!/\d/.test(clean)) return false;

          // 2. Arithmetic addition chain: e.g. "12.3+2.6+26", "11.14 + 8.10 + 25.30"
          const hasAdditionChain = /\d+(?:\.\d+)?\s*\+\s*\d+(?:\.\d+)?/.test(
            clean,
          );

          // 3. Member calculations: e.g. "Shiva == 11.14+8.10" or "Arjun == 497.40"
          const memberMatches = clean.match(
            /\b(arjun|arpan|shiva|swasti|nani)\s*={1,2}\s*[\d+.]+/gi,
          );
          const hasMultipleMemberBreakdown =
            memberMatches && memberMatches.length >= 2;

          // 4. Total calculation equation: "Total == 1,237.38 $309.35 each" or "Total = 1237.38"
          const hasTotalEquation =
            /total\s*={1,2}\s*\$?\s*[\d,]+(?:\.\d+)?/i.test(clean) &&
            (/(each|\/4|\/ 4|\$)/i.test(clean) ||
              Boolean(memberMatches && memberMatches.length >= 1));

          // 5. Keyword like "calculation" / "hisab" MUST be accompanied by actual math/equations:
          // E.g. "calculation = 12.3+2.6+26" or "calculation: 12.3+4.5" or "calculation Shiva == ..."
          const hasCalcKeywordWithMath =
            /\b(calculation|calculated|breakdown|hisab|hisaab)\b/i.test(
              clean,
            ) &&
            (/\d+(?:\.\d+)?\s*[\+=]\s*[\d+.]+/i.test(clean) ||
              hasAdditionChain ||
              (memberMatches && memberMatches.length >= 1));

          // 6. Direct arithmetic with an equals sign: e.g. "12.3+2.6+26 = 40.9" or "12.3+25.36=37.66"
          const hasEquationWithEquals = hasAdditionChain && /=/.test(clean);

          return Boolean(
            hasMultipleMemberBreakdown ||
            hasTotalEquation ||
            hasCalcKeywordWithMath ||
            hasEquationWithEquals,
          );
        }

        function parseGroundTruth(text) {
          if (!text) return null;
          const gt = {
            memberTotals: {},
            totalPool: null,
            fairShare: null,
            rawText: text.trim().substring(0, 300),
          };

          const totalMatch =
            text.match(/total\s*={1,2}\s*[^=]*?=\s*([\d,]+\.?\d*)/i) ||
            text.match(/total\s*={1,2}\s*([\d,]+\.?\d*)/i);
          if (totalMatch) {
            gt.totalPool = parseFloat(totalMatch[1].replace(/,/g, ""));
          }

          const shareMatch = text.match(/\$?\s*([\d,]+\.?\d*)\s*each/i);
          if (shareMatch) {
            gt.fairShare = parseFloat(shareMatch[1].replace(/,/g, ""));
          } else if (gt.totalPool) {
            gt.fairShare = Math.round((gt.totalPool / 4) * 100) / 100;
          }

          const members = ["Arjun", "Arpan", "Shiva", "Swasti", "Nani"];
          members.forEach((m) => {
            const regex = new RegExp(
              `(?:^|\\s|\\n)${m}\\s*={1,2}(?:[^=\\n]*?=\\s*)?\\s*([\\d,]+\\.?\\d*)`,
              "i",
            );
            const match = text.match(regex);
            if (match) {
              const canonical =
                m.toLowerCase() === "nani"
                  ? "Swasti Adhikari"
                  : m.toLowerCase() === "arjun"
                    ? "Arjun Bhurtel"
                    : m.toLowerCase() === "arpan"
                      ? "Arpan Bhurtel"
                      : "Shiva Kafle";
              gt.memberTotals[canonical] = parseFloat(
                match[1].replace(/,/g, ""),
              );
            }
          });

          return gt;
        }

        function resolveAuthorName(authorWid) {
          if (!authorWid) return "Flatmate";
          const numOnly = authorWid.split("@")[0].replace(/\D/g, "");
          return (
            userAliases[numOnly] ||
            userAliases[`+${numOnly}`] ||
            userAliases[authorWid] ||
            "Flatmate"
          );
        }

        function messageId(message) {
          const raw = message?.id;
          if (typeof raw === "string") return raw;
          const direct = raw?._serialized || raw?.$1;
          if (typeof direct === "string") return direct;
          try {
            const stringified = raw?.toString?.();
            if (stringified && stringified !== "[object Object]") return stringified;
          } catch (e) {}
          return "";
        }

        // A completed cycle is normally followed by a "clear up to date"
        // marker. Older chat history also contains settlement calculations
        // without that exact phrase, so use those as fallback boundaries.
        const boundaryCandidates = [];
        sorted.forEach((m) => {
          if (!m.isNotification) {
            const body = m.body || m.caption || (m._data && m._data.body) || "";
            const marker =
              typeof body === "string" && checkpointRegex.test(body);
            const calculation = !marker && isCalculationMessage(body);
            if (marker || calculation) {
              const ts = m.t || m.timestamp || 0;
              boundaryCandidates.push({
                id: messageId(m),
                timestamp: ts,
                dateStr: new Date(ts * 1000).toISOString().split("T")[0],
                timeStr: new Date(ts * 1000).toLocaleDateString("en-AU", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }),
                text: marker
                  ? body.trim().replace(/\n+/g, " ")
                  : "Settlement calculation posted",
                source: marker ? "marker" : "calculation",
                confidence: marker ? "HIGH" : "LOW",
              });
            }
          }
        });
        // Every explicit marker is an immutable boundary. A calculation is
        // only a low-confidence fallback when no marker exists nearby; it is
        // never silently allowed to replace or collapse a marker.
        const uniqueBoundaryMap = new Map();
        for (const item of boundaryCandidates) {
          const evidenceKey = `${item.timestamp}|${item.text.toLowerCase()}`;
          const previous = uniqueBoundaryMap.get(evidenceKey);
          if (!previous || (!previous.id && item.id))
            uniqueBoundaryMap.set(evidenceKey, item);
        }
        const uniqueBoundaries = [...uniqueBoundaryMap.values()].filter(
          (item) => item.id,
        );
        const markers = uniqueBoundaries.filter((item) => item.source === "marker");
        const checkpoints = [
          ...markers,
          ...uniqueBoundaries.filter(
            (item) =>
              item.source === "calculation" &&
              !markers.some(
                (marker) =>
                  Math.abs(marker.timestamp - item.timestamp) <= 4 * 86400,
              ),
          ),
        ].sort((a, b) => a.timestamp - b.timestamp);

        const cycles = [];

        // Historical Cycles between adjacent checkpoints
        for (let i = 0; i < checkpoints.length; i++) {
          const configuredBoundary =
            i === 0 && configuredGroupStart
              ? {
                  id: `configured-start:${gId}:${configuredGroupStart}`,
                  timestamp: Math.floor(
                    new Date(`${configuredGroupStart}T00:00:00Z`).getTime() /
                      1000,
                  ),
                  dateStr: configuredGroupStart,
                  text: "Configured group start",
                  source: "configured",
                  confidence: "HIGH",
                }
              : null;
          const startCp = i > 0 ? checkpoints[i - 1] : configuredBoundary;
          const endCp = checkpoints[i];

          const configuredStartTs = configuredGroupStart
            ? Math.floor(
                new Date(`${configuredGroupStart}T00:00:00Z`).getTime() / 1000,
              )
            : 0;
          const firstMessageTs = sorted.find(
            (message) => (message.t || message.timestamp || 0) > 0,
          );
          const startTs = startCp
            ? startCp.timestamp + 1
            : configuredStartTs > 0 && configuredStartTs <= endCp.timestamp
              ? configuredStartTs
              : firstMessageTs
                ? firstMessageTs.t || firstMessageTs.timestamp
                : endCp.timestamp;
          const endTs = endCp.timestamp;

          const cycleMsgs = sorted.filter((m) => {
            const ts = m.t || m.timestamp || 0;
            return ts >= startTs && ts <= endTs;
          });

          let calcMsg = null;
          for (let j = cycleMsgs.length - 1; j >= 0; j--) {
            const body =
              cycleMsgs[j].body ||
              cycleMsgs[j].caption ||
              (cycleMsgs[j]._data && cycleMsgs[j]._data.body) ||
              "";
            if (isCalculationMessage(body)) {
              calcMsg = cycleMsgs[j];
              break;
            }
          }

          const calcTs = calcMsg
            ? calcMsg.t || calcMsg.timestamp || endTs
            : endTs;
          const calcBody = calcMsg ? calcMsg.body || calcMsg.caption || "" : "";
          const groundTruth = calcMsg ? parseGroundTruth(calcBody) : null;

          const groceryMessages = [];
          const paymentMessages = [];

          cycleMsgs.forEach((m) => {
            const isMedia = Boolean(
              m.isMedia ||
              m.mediaData ||
              m.type === "image" ||
              (m.mimetype && m.mimetype.startsWith("image/")),
            );
            if (!isMedia) return;

            const ts = m.t || m.timestamp || 0;
            let preview = "";
            if (m.mediaData && (m.mediaData.preview || m.mediaData._preview)) {
              let p = m.mediaData.preview || m.mediaData._preview;
              if (p && p._b64) p = p._b64;
              if (typeof p === "string" && p.length > 20) {
                preview = `data:image/jpeg;base64,${p}`;
              }
            }

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
            const authorName = resolveAuthorName(authorStr);

            if (!preview && idStr) {
              preview = `/api/media?id=${encodeURIComponent(idStr)}&groupId=${encodeURIComponent(gId)}`;
            }

            const itemData = {
              id: idStr,
              timestamp: ts,
              timeStr: new Date(ts * 1000).toLocaleString("en-AU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
              author: authorStr,
              authorName,
              preview,
            };

            if (ts < calcTs) {
              groceryMessages.push(itemData);
            } else {
              paymentMessages.push(itemData);
            }
          });

          const startDateStr = new Date(startTs * 1000)
            .toISOString()
            .split("T")[0];
          const endDateStr = new Date(endTs * 1000).toISOString().split("T")[0];

          cycles.push({
            id: `cycle_hist_${i + 1}`,
            title: `Settlement: ${startDateStr} to ${endDateStr}`,
            status: "SETTLED",
            startBoundary: startCp,
            endBoundary: endCp,
            startCheckpoint: startCp,
            endCheckpoint: endCp,
            calculationMessage: calcMsg
              ? {
                  text: calcBody,
                  timestamp: calcTs,
                  timeStr: new Date(calcTs * 1000).toLocaleString("en-AU", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                }
              : null,
            groundTruth,
            startTs,
            endTs,
            calcTs,
            startDate: startDateStr,
            endDate: endDateStr,
            groceryCount: groceryMessages.length,
            paymentCount: paymentMessages.length,
            groceryMessages,
            paymentMessages,
          });
        }

        // Active Current Cycle (since last checkpoint)
        if (checkpoints.length > 0) {
          const lastCp = checkpoints[checkpoints.length - 1];
          const startTs = lastCp.timestamp + 1;
          const nowTs = Math.floor(Date.now() / 1000);

          const currentCycleMsgs = sorted.filter((m) => {
            const ts = m.t || m.timestamp || 0;
            return ts >= startTs;
          });

          let calcMsg = null;
          for (let j = currentCycleMsgs.length - 1; j >= 0; j--) {
            const body =
              currentCycleMsgs[j].body || currentCycleMsgs[j].caption || "";
            if (isCalculationMessage(body)) {
              calcMsg = currentCycleMsgs[j];
              break;
            }
          }

          const calcTs = calcMsg
            ? calcMsg.t || calcMsg.timestamp || nowTs
            : nowTs;
          const calcBody = calcMsg ? calcMsg.body || calcMsg.caption || "" : "";
          const groundTruth = calcMsg ? parseGroundTruth(calcBody) : null;

          const groceryMessages = [];
          const paymentMessages = [];

          currentCycleMsgs.forEach((m) => {
            const isMedia = Boolean(
              m.isMedia ||
              m.mediaData ||
              m.type === "image" ||
              (m.mimetype && m.mimetype.startsWith("image/")),
            );
            if (!isMedia) return;

            const ts = m.t || m.timestamp || 0;
            let preview = "";
            if (m.mediaData && (m.mediaData.preview || m.mediaData._preview)) {
              let p = m.mediaData.preview || m.mediaData._preview;
              if (p && p._b64) p = p._b64;
              if (typeof p === "string" && p.length > 20) {
                preview = `data:image/jpeg;base64,${p}`;
              }
            }

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
            const authorName = resolveAuthorName(authorStr);

            if (!preview && idStr) {
              preview = `/api/media?id=${encodeURIComponent(idStr)}&groupId=${encodeURIComponent(gId)}`;
            }

            const itemData = {
              id: idStr,
              timestamp: ts,
              timeStr: new Date(ts * 1000).toLocaleString("en-AU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
              author: authorStr,
              authorName,
              preview,
            };

            if (ts < calcTs) {
              groceryMessages.push(itemData);
            } else {
              paymentMessages.push(itemData);
            }
          });

          const startDateStr = new Date(startTs * 1000)
            .toISOString()
            .split("T")[0];
          const endDateStr = new Date(nowTs * 1000).toISOString().split("T")[0];

          cycles.push({
            id: "cycle_current",
            title: `Current Active Cycle (Since ${lastCp.dateStr})`,
            status: "ACTIVE",
            startBoundary: lastCp,
            endBoundary: null,
            startCheckpoint: lastCp,
            endCheckpoint: null,
            calculationMessage: calcMsg
              ? {
                  text: calcBody,
                  timestamp: calcTs,
                  timeStr: new Date(calcTs * 1000).toLocaleString("en-AU", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                }
              : null,
            groundTruth,
            startTs,
            endTs: nowTs,
            calcTs,
            startDate: startDateStr,
            endDate: endDateStr,
            groceryCount: groceryMessages.length,
            paymentCount: paymentMessages.length,
            groceryMessages,
            paymentMessages,
          });
        }

        return cycles.reverse();
      } catch (err) {
        console.error("In-page cycle detection error:", err);
        return [];
      }
    },
    groupId,
    aliases,
    groupStartDate,
    searchedBoundaries,
  );
}

module.exports = { detectSettlementCycles };
