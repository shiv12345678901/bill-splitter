const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadMediaBuffer(client, msgId, groupId) {
  if (!client) return null;

  const first = await attemptDownload(client, msgId, groupId);
  if (first && first.data) return first;

  // Media resolution is asynchronous inside the page; a patient retry
  // regularly succeeds after the first attempt primed the download.
  await sleep(1500);
  const second = await attemptDownload(client, msgId, groupId);
  if (second && second.data) return second;
  if (second && second.error)
    console.warn(
      `[Media] All extractors failed for ${msgId}: ${second.error}${second.attempts?.length ? ` | ${second.attempts.join(" | ")}` : ""}`,
    );
  return first || second || null;
}

async function attemptDownload(client, msgId, groupId) {
  // Attempt 1: Node.js Message wrapper via client.getMessageById
  try {
    const msgInstance = await client.getMessageById(msgId);
    if (msgInstance && typeof msgInstance.downloadMedia === "function") {
      const downloaded = await msgInstance.downloadMedia();
      if (downloaded && downloaded.data) {
        console.log(
          `[Media] Extracted via Message.downloadMedia() for ${msgId}`,
        );
        return {
          data: downloaded.data.includes("base64,")
            ? downloaded.data.split("base64,")[1]
            : downloaded.data,
          mimetype: downloaded.mimetype || "image/jpeg",
          filename: downloaded.filename || "receipt.jpg",
          method: "wwebjs_Message",
        };
      }
    }
  } catch (sdkErr) {
    // Fall through to in-page evaluation
  }

  // Attempt 2: In-page direct memory extraction across collections
  if (!client.pupPage) return null;

  try {
    const res = await client.pupPage.evaluate(
      async (id, gId) => {
        const attempts = [];
        try {
          let msg = null;

          // A. Search in target chat collection first
          if (gId) {
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
              if (c && c.msgs) {
                msg =
                  (typeof c.msgs.get === "function" ? c.msgs.get(id) : null) ||
                  (c.msgs.getModelsArray
                    ? c.msgs
                        .getModelsArray()
                        .find(
                          (m) => (m.id?._serialized || m.id?.$1 || m.id) === id,
                        )
                    : null) ||
                  (c.msgs._models || []).find(
                    (m) => (m.id?._serialized || m.id?.$1 || m.id) === id,
                  );
              }
            } catch (e) {}
          }

          // B. Search in global Msg collection
          if (!msg) {
            try {
              const msgColl = window.require("WAWebCollections")?.Msg;
              if (msgColl) {
                msg =
                  (typeof msgColl.get === "function"
                    ? msgColl.get(id)
                    : null) ||
                  (msgColl.getModelsArray
                    ? msgColl
                        .getModelsArray()
                        .find(
                          (m) => (m.id?._serialized || m.id?.$1 || m.id) === id,
                        )
                    : null);
                if (!msg && typeof msgColl.getMessagesById === "function") {
                  const fetched = await msgColl.getMessagesById([id]);
                  msg = fetched?.messages?.[0];
                }
              }
            } catch (e) {}
          }

          // C. Search across all chats msgs
          if (!msg) {
            try {
              const chatColl = window.require("WAWebCollections")?.Chat;
              const chats = chatColl?.getModelsArray
                ? chatColl.getModelsArray()
                : chatColl?._models || [];
              for (const ch of chats) {
                if (ch && ch.msgs) {
                  const ms = ch.msgs.getModelsArray
                    ? ch.msgs.getModelsArray()
                    : ch.msgs._models || [];
                  msg = ms.find(
                    (m) => (m.id?._serialized || m.id?.$1 || m.id) === id,
                  );
                  if (msg) break;
                }
              }
            } catch (e) {}
          }

          if (!msg) {
            return { error: "Message not found in collections", attempts };
          }

          const fetchRenderable = async () => {
            if (msg.mediaData && msg.mediaData.renderableUrl) {
              try {
                const resp = await fetch(msg.mediaData.renderableUrl);
                const blob = await resp.blob();
                const reader = new FileReader();
                const b64Promise = new Promise((resolve) => {
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = () => resolve(null);
                });
                reader.readAsDataURL(blob);
                const dataUrl = await b64Promise;
                if (dataUrl && typeof dataUrl === "string") {
                  const parts = dataUrl.split("base64,");
                  return {
                    data: parts[1] || parts[0],
                    mimetype: blob.type || msg.mimetype || "image/jpeg",
                    filename: msg.filename || "receipt.jpg",
                    method: "renderableUrl",
                  };
                }
              } catch (e) {
                attempts.push(`renderableUrl: ${e.message}`);
              }
            } else {
              attempts.push("renderableUrl: not present");
            }
            return null;
          };

          // Step 1: If blob renderableUrl exists, fetch it directly
          const direct = await fetchRenderable();
          if (direct) return { ...direct, attempts };

          const md = msg.mediaData || {};

          // Step 2: Force WhatsApp's own pipeline to resolve the media, then
          // look for the freshly produced blob URL / blob object.
          if (typeof msg.downloadMedia === "function") {
            try {
              await msg.downloadMedia({
                downloadEvenIfExpensive: true,
                rmrReason: 1,
              });
              attempts.push(
                `forced resolve: done (stage=${md.mediaStage})`,
              );
            } catch (e) {
              attempts.push(`forced resolve: ${e.message}`);
            }
            const primed = await fetchRenderable();
            if (primed) return { ...primed, attempts };
            try {
              const blobObj =
                md.mediaBlob instanceof Blob
                  ? md.mediaBlob
                  : md.mediaBlob?._blob instanceof Blob
                    ? md.mediaBlob._blob
                    : null;
              if (blobObj) {
                const reader = new FileReader();
                const dataUrl = await new Promise((resolve) => {
                  reader.onloadend = () => resolve(reader.result);
                  reader.onerror = () => resolve(null);
                  reader.readAsDataURL(blobObj);
                });
                if (typeof dataUrl === "string" && dataUrl.includes("base64,")) {
                  return {
                    data: dataUrl.split("base64,")[1],
                    mimetype: blobObj.type || md.fullMimetype || msg.mimetype || "image/jpeg",
                    filename: msg.filename || "receipt.jpg",
                    method: "mediaBlob",
                    attempts,
                  };
                }
              } else {
                attempts.push("mediaBlob: not present");
              }
            } catch (e) {
              attempts.push(`mediaBlob: ${e.message}`);
            }
          }

          // Step 3: Decrypt with WAWebDownloadManager. The media attributes
          // live on mediaData in current builds; fall back to top-level fields.
          try {
            const downloadMgr = window.require(
              "WAWebDownloadManager",
            )?.downloadManager;
            if (
              downloadMgr &&
              typeof downloadMgr.downloadAndMaybeDecrypt === "function"
            ) {
              const mockQpl = {
                addAnnotations: () => {},
                addPoint: () => {},
                start: () => {},
                end: () => {},
                success: () => {},
                fail: () => {},
                annotate: () => {},
                increment: () => {},
                flush: () => {},
              };
              const decryptedMedia = await downloadMgr.downloadAndMaybeDecrypt({
                directPath: md.directPath || msg.directPath,
                encFilehash: md.encFilehash || msg.encFilehash,
                filehash: md.filehash || msg.filehash,
                mediaKey: md.mediaKey || msg.mediaKey,
                mediaKeyTimestamp: md.mediaKeyTimestamp || msg.mediaKeyTimestamp,
                mimetype: md.fullMimetype || msg.mimetype,
                type: msg.type,
                signal: new AbortController().signal,
                downloadQpl: mockQpl,
              });

              if (decryptedMedia) {
                let b64 = "";
                if (
                  window.WWebJS &&
                  typeof window.WWebJS.arrayBufferToBase64Async === "function"
                ) {
                  b64 =
                    await window.WWebJS.arrayBufferToBase64Async(
                      decryptedMedia,
                    );
                } else {
                  let binary = "";
                  const bytes = new Uint8Array(decryptedMedia);
                  for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                  }
                  b64 = btoa(binary);
                }

                if (b64) {
                  return {
                    data: b64,
                    mimetype: md.fullMimetype || msg.mimetype || "image/jpeg",
                    filename: msg.filename || "receipt.jpg",
                    method: "downloadAndMaybeDecrypt",
                    attempts,
                  };
                }
              }
              attempts.push("downloadAndMaybeDecrypt: empty result");
            } else {
              attempts.push("downloadAndMaybeDecrypt: manager unavailable");
            }
          } catch (e) {
            attempts.push(`downloadAndMaybeDecrypt: ${e.message}`);
          }

          // Step 4: Fallback to preview thumbnail
          if (md.preview || md._preview) {
            let p = md.preview || md._preview;
            if (p && p._b64) p = p._b64;
            if (typeof p === "string" && p.length > 50) {
              return {
                data: p.includes("base64,") ? p.split("base64,")[1] : p,
                mimetype: md.fullMimetype || msg.mimetype || "image/jpeg",
                filename: "receipt.jpg",
                method: "preview",
                attempts,
              };
            }
            attempts.push("preview: too short");
          } else {
            attempts.push("preview: not present");
          }

          // Step 5: Fallback to body
          if (
            msg.body &&
            typeof msg.body === "string" &&
            msg.body.length > 100
          ) {
            return {
              data: msg.body.includes("base64,")
                ? msg.body.split("base64,")[1]
                : msg.body,
              mimetype: msg.mimetype || "image/jpeg",
              filename: "receipt.jpg",
              method: "body",
              attempts,
            };
          }

          return {
            error: "No media extractor succeeded for this message",
            attempts,
          };
        } catch (err) {
          return { error: err.message, attempts };
        }
      },
      msgId,
      groupId,
    );

    if (res && res.data) {
      console.log(
        `[Media] Extracted via in-page ${res.method} for ${msgId} (${res.data.length} chars)`,
      );
      return res;
    } else if (res && res.error) {
      console.warn(`[Media] In-page warning for ${msgId}:`, res.error);
    }
    return res || null;
  } catch (evalErr) {
    console.warn("[Media] Evaluation error:", evalErr.message);
  }

  return null;
}

module.exports = { downloadMediaBuffer };
