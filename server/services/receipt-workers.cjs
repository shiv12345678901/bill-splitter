const fs = require("node:fs");
const path = require("node:path");
const {
  MEDIA_CACHE_DIR,
  loadReceiptCache,
  upsertReceiptCacheEntry,
} = require("./storage.cjs");
const library = require("./library.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const classifyScanError = (error) => {
  const message = String(error?.message || error || "").toLowerCase();
  if (error?.code === "SCAN_CANCELLED") return "cancelled";
  if (error?.code === "OCR_TIMEOUT" || /timed? out|timeout/.test(message))
    return "timeout";
  if (/\b429\b|quota|resource exhausted|rate.?limit/.test(message))
    return "quota";
  if (/download|media|image data/.test(message)) return "download";
  return "api";
};
const isRetryable = (code) => ["timeout", "quota", "download", "api"].includes(code);
const withOcrTimeout = (promise, { controller, isAborted }) => {
  const configured = Number(process.env.SPLITMATE_OCR_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0
    ? configured
    : 60000;
  let timer;
  let cancellationPoll;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          const error = new Error("Receipt recognition timed out.");
          error.code = "OCR_TIMEOUT";
          reject(error);
        },
        timeoutMs,
      );
      cancellationPoll = setInterval(() => {
        if (!isAborted()) return;
        controller.abort();
        const error = new Error("Scan cancelled.");
        error.code = "SCAN_CANCELLED";
        reject(error);
      }, 100);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    clearInterval(cancellationPoll);
  });
};
module.exports = async function processReceipts({
  client,
  groupId,
  candidateMessages,
  activeKeys,
  concurrency,
  effectiveAliases,
  filterMember,
  socket,
  isAborted,
  downloadMediaBuffer,
  parseReceiptWithGemini,
  onOutcome = async () => {},
  maxAttempts = 3,
  retryBaseMs = Number(process.env.SPLITMATE_RETRY_BASE_MS) || 1000,
}) {
  const parsedExpenses = [];
  let completedCount = 0;
  let nextCandidateIndex = 0;

  const waitForRetry = async (attempt) => {
    const delay = Math.max(0, retryBaseMs) * 2 ** Math.max(0, attempt - 1);
    const end = Date.now() + delay;
    while (Date.now() < end) {
      if (isAborted()) {
        const error = new Error("Scan cancelled.");
        error.code = "SCAN_CANCELLED";
        throw error;
      }
      await sleep(Math.min(250, end - Date.now()));
    }
  };

  const emitOcrProgress = () => {
    const done = Math.min(completedCount, candidateMessages.length);
    const speedTag =
      concurrency > 1 ? ` (⚡ ${concurrency}x Multi-Key Turbo)` : "";
    socket.emit("scan:progress", {
      stage: "analyzing",
      message: `Audited ${done} of ${candidateMessages.length} photos${speedTag}...`,
      current: done,
      total: candidateMessages.length,
    });
  };

  async function resolveSender(msg) {
    const authorId = msg.author || msg.from || "";
    const authorUser =
      typeof authorId === "string" ? authorId.split("@")[0] : "";
    const cleanAuthorNumber = authorUser.replace(/\D/g, "");

    let contactName = "";
    try {
      const contact = await client.getContactById(authorId);
      contactName = contact?.pushname || contact?.name || "";
    } catch (e) {}

    return (
      (cleanAuthorNumber && effectiveAliases[cleanAuthorNumber]) ||
      (cleanAuthorNumber && effectiveAliases[`+${cleanAuthorNumber}`]) ||
      (authorUser && effectiveAliases[authorUser]) ||
      (authorId && effectiveAliases[authorId]) ||
      (contactName && effectiveAliases[contactName]) ||
      contactName ||
      authorUser ||
      "Flatmate"
    );
  }

  async function ocrWorker(workerId) {
    while (nextCandidateIndex < candidateMessages.length) {
      if (isAborted()) break;
      const currentIndex = nextCandidateIndex++;
      const msg = candidateMessages[currentIndex];
      let outcomeRecorded = false;
      let attempts = 0;
      let apiCalls = 0;
      let source = "api";
      const recordOutcome = async (status, extra = {}) => {
        outcomeRecorded = true;
        await onOutcome({
          messageId: msg.id,
          status,
          attempts,
          apiCalls,
          source,
          ...extra,
        });
      };

      try {
        const senderName = await resolveSender(msg);

        if (
          filterMember &&
          filterMember !== "all" &&
          senderName !== filterMember
        ) {
          console.log(
            `[Scan:Worker ${workerId + 1}] Skipping photo from ${senderName} (filter: ${filterMember})`,
          );
          await recordOutcome("skipped", {
            reason: `Filtered to ${filterMember}`,
          });
          continue;
        }

        // 1. Check OCR cache first for instant retrieval
        const ocrCache = loadReceiptCache();
        const cacheKey = msg.id;
        let ocrResult = null;
        // The message id whose cached file holds the image bytes (differs
        // from cacheKey when identical content was deduplicated).
        let thumbId = cacheKey;
        let thumbGroup = groupId;

        if (ocrCache[cacheKey]) {
          ocrResult = ocrCache[cacheKey];
          source = "cache";
          console.log(
            `[OCR:Cache Hit ⚡] Instantly loaded cached receipt for message ${cacheKey} (${ocrResult.merchant}, $${(ocrResult.amount || 0).toFixed(2)})`,
          );
          // Images scanned before the library existed already have their
          // file in the image folder — register them there too.
          if (!library.findById(cacheKey)) {
            await library.recordImage({
              id: cacheKey,
              groupId,
              mimetype: "image/jpeg",
              ocr: ocrResult,
              senderName,
              timestamp: msg.timestamp,
            });
          }
        }

        // 2. Already scanned and saved in the library? Reuse its data and
        // image file without touching WhatsApp.
        if (!ocrResult) {
          const known = library.findById(cacheKey);
          if (known && known.merchant) {
            source = "library";
            ocrResult = {
              merchant: known.merchant,
              amount: known.amount,
              category: known.category,
              isBankTransfer: known.isBankTransfer,
              confidence: known.confidence,
              isBlurry: known.isBlurry,
            };
            thumbId = known.fileId || known.id;
            thumbGroup = known.fileGroupId || groupId;
            console.log(
              `[OCR:Library ⚡] Reused saved scan for ${known.fileName} (${known.merchant}, $${(known.amount || 0).toFixed(2)})`,
            );
          }
        }

        if (!ocrResult) {
          // 3. Download media buffer (WhatsApp only needed for new images)
          let media;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            attempts = attempt;
            try {
              media = await downloadMediaBuffer(client, msg.id, groupId);
              if (!media?.data)
                throw new Error("Receipt image could not be downloaded.");
              break;
            } catch (error) {
              const code = classifyScanError(error);
              if (attempt >= maxAttempts || !isRetryable(code)) throw error;
              await waitForRetry(attempt);
            }
          }
          if (!media || !media.data) {
            console.warn(
              `[OCR:Worker ${workerId + 1}] Could not download image data for message ${msg.id}`,
            );
            throw new Error("Receipt image could not be downloaded.");
          }

          const mime = media.mimetype || "image/jpeg";
          // Only photos are receipts here; documents (PDFs) and other files are ignored.
          if (!mime.startsWith("image/")) {
            await recordOutcome("skipped", {
              reason: `Unsupported media type: ${mime}`,
            });
            continue;
          }
          const buffer = Buffer.from(media.data, "base64");
          const contentHash = library.hashBuffer(buffer);

          // 4. Identical image scanned before? Reuse that result and file.
          const duplicate = library.findByContentHash(contentHash);
          if (duplicate && duplicate.merchant) {
            source = "duplicate";
            ocrResult = {
              merchant: duplicate.merchant,
              amount: duplicate.amount,
              category: duplicate.category,
              isBankTransfer: duplicate.isBankTransfer,
              confidence: duplicate.confidence,
              isBlurry: duplicate.isBlurry,
            };
            thumbId = duplicate.fileId || duplicate.id;
            thumbGroup = duplicate.fileGroupId || duplicate.groupId || groupId;
            console.log(
              `[OCR:Duplicate ⚡] Identical image already saved as ${duplicate.fileName}; reusing its scanned data.`,
            );
            await library.recordImage({
              id: cacheKey,
              groupId,
              mimetype: mime,
              contentHash,
              ocr: ocrResult,
              senderName,
              timestamp: msg.timestamp,
              dedupOf: duplicate,
            });
          } else {
            // 5. Fresh Gemini OCR, then save image + scanned data locally.
            console.log(
              `[OCR:Worker ${workerId + 1} (Key ${(workerId % activeKeys.length) + 1})] Analyzing photo from ${senderName} (${currentIndex + 1}/${candidateMessages.length})...`,
            );
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              attempts = attempt;
              apiCalls++;
              try {
                const key = activeKeys[(workerId + attempt - 1) % activeKeys.length];
                const controller = new AbortController();
                ocrResult = await withOcrTimeout(
                  parseReceiptWithGemini(media.data, mime, key, {
                    signal: controller.signal,
                  }),
                  { controller, isAborted },
                );
                break;
              } catch (error) {
                const code = classifyScanError(error);
                error.scanErrorCode = code;
                if (attempt >= maxAttempts || !isRetryable(code)) throw error;
                await waitForRetry(attempt);
              }
            }
            await library.recordImage({
              id: cacheKey,
              groupId,
              buffer,
              mimetype: mime,
              contentHash,
              ocr: ocrResult,
              senderName,
              timestamp: msg.timestamp,
            });
          }

          // Cache the result permanently to disk (image bytes themselves
          // live in the library image folder, not in this JSON).
          if (ocrResult) {
            const cached = {
              ...ocrResult,
              cachedAt: new Date().toISOString(),
            };
            upsertReceiptCacheEntry(cacheKey, cached);
          }
        }

        if (ocrResult && ocrResult.amount > 0 && !ocrResult.isBankTransfer) {
          console.log(
            `[OCR:Worker ${workerId + 1}] Identified: ${ocrResult.merchant}, $${ocrResult.amount.toFixed(2)} (${ocrResult.category}) for ${senderName}`,
          );
          const expenseItem = {
            id:
              msg.id ||
              `exp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            date: new Date(msg.timestamp * 1000).toISOString(),
            paidBy: senderName,
            merchant: ocrResult.merchant,
            amount: ocrResult.amount,
            category: ocrResult.category,
            confidence: ocrResult.confidence || "HIGH",
            isBlurry: Boolean(ocrResult.isBlurry),
            needsReview: false,
            thumbnail: `/api/media?id=${encodeURIComponent(thumbId)}&groupId=${encodeURIComponent(thumbGroup)}`,
          };

          parsedExpenses.push(expenseItem);

          // Stream newly parsed receipt to frontend in real-time
          socket.emit("scan:receipt_found", {
            receipt: expenseItem,
            currentCount: parsedExpenses.length,
          });
          await recordOutcome("processed", { receipt: expenseItem });
        } else if (ocrResult && ocrResult.isBankTransfer) {
          console.log(
            `[OCR:Worker ${workerId + 1}] Transfer proof from ${senderName} — excluded from the split, flagged for review.`,
          );
          const transferItem = {
            id:
              msg.id ||
              `exp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            date: new Date(msg.timestamp * 1000).toISOString(),
            paidBy: senderName,
            merchant: ocrResult.merchant || "Payment Transfer",
            amount: ocrResult.amount || 0,
            category: "Other",
            confidence: ocrResult.confidence || "LOW",
            isBlurry: Boolean(ocrResult.isBlurry),
            isBankTransfer: true,
            isExcluded: true,
            needsReview: true,
            thumbnail: `/api/media?id=${encodeURIComponent(thumbId)}&groupId=${encodeURIComponent(thumbGroup)}`,
          };

          parsedExpenses.push(transferItem);

          socket.emit("scan:receipt_found", {
            receipt: transferItem,
            currentCount: parsedExpenses.length,
          });
          await recordOutcome("excluded", {
            reason: "Bank transfer or payment proof",
            receipt: transferItem,
          });
        } else {
          // Unverified docket: Gemini returned 0 or could not read amount (blurry / handwritten / crumpled)
          console.log(
            `[OCR:Worker ${workerId + 1}] Docket from ${senderName} needs review (amount: 0). Preserving for manual review.`,
          );
          const unverifiedItem = {
            id:
              msg.id ||
              `exp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            date: new Date(msg.timestamp * 1000).toISOString(),
            paidBy: senderName,
            merchant:
              ocrResult?.merchant &&
              ocrResult.merchant !== "Unknown" &&
              ocrResult.merchant !== "Bank Transfer"
                ? ocrResult.merchant
                : "Needs Review (Unclear Docket)",
            amount: 0,
            category: ocrResult?.category || "Groceries",
            confidence: "LOW",
            isBlurry: true,
            needsReview: true,
            thumbnail: `/api/media?id=${encodeURIComponent(thumbId)}&groupId=${encodeURIComponent(thumbGroup)}`,
          };

          parsedExpenses.push(unverifiedItem);

          socket.emit("scan:receipt_found", {
            receipt: unverifiedItem,
            currentCount: parsedExpenses.length,
          });
          await recordOutcome("processed", {
            reason: "Needs manual review",
            receipt: unverifiedItem,
          });
        }
      } catch (msgError) {
        console.warn(
          `[OCR:Worker ${workerId + 1}] Error processing message ${msg.id}:`,
          msgError.message,
        );
        const receipt = {
          id: msg.id,
          date: new Date(msg.timestamp * 1000).toISOString(),
          merchant: "Receipt could not be read",
          paidBy: await resolveSender(msg),
          amount: 0,
          category: "Other",
          needsReview: true,
          confidence: "LOW",
          thumbnail: `/api/media?id=${encodeURIComponent(msg.id)}&groupId=${encodeURIComponent(groupId)}`,
        };
        parsedExpenses.push(receipt);
        socket.emit("scan:receipt_found", { receipt });
        if (!outcomeRecorded) {
          const errorCode = msgError.scanErrorCode || classifyScanError(msgError);
          await recordOutcome(errorCode === "cancelled" ? "skipped" : "failed", {
            errorCode,
            errorMessage: msgError.message,
            receipt,
          });
        }
      } finally {
        completedCount++;
        emitOcrProgress();
      }

      // Gentle pacing per worker to avoid local network congestion
      if (concurrency > 1) {
        await sleep(150);
      } else {
        await sleep(350);
      }
    }
  }

  // Launch parallel workers
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push(ocrWorker(w));
  }
  await Promise.all(workers);
  return parsedExpenses;
};

module.exports.classifyScanError = classifyScanError;
