const GEMINI_OCR_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_GEMINI_REQUEST_TIMEOUT_MS = 30000;
const MAX_GEMINI_REQUEST_TIMEOUT_MS = 45000;

function requestTimeoutMs(value = process.env.SPLITMATE_GEMINI_REQUEST_TIMEOUT_MS) {
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_GEMINI_REQUEST_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(configured), 1), MAX_GEMINI_REQUEST_TIMEOUT_MS);
}

function cleanAndParseJson(text) {
  let cleaned = (text || "").trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }
  const parsed = JSON.parse(cleaned);
  let amount = parseFloat(parsed.amount);
  if (isNaN(amount) || amount < 0) amount = 0;

  const isBankTransfer = Boolean(parsed.isBankTransfer);
  if (isBankTransfer) {
    amount = 0;
  }

  const validCategories = [
    "Groceries",
    "Utilities",
    "Dining",
    "Household Supplies",
    "Other",
  ];
  let category = parsed.category || "Other";
  if (!validCategories.includes(category)) {
    category = "Other";
  }

  const confidence = ["HIGH", "MEDIUM", "LOW"].includes(parsed.confidence)
    ? parsed.confidence
    : amount > 0
      ? "HIGH"
      : "LOW";
  const isBlurry = Boolean(parsed.isBlurry);
  const transactionDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.transactionDate || ""))
    ? String(parsed.transactionDate)
    : null;
  const receiptNumber = String(parsed.receiptNumber || parsed.referenceNumber || "")
    .trim()
    .slice(0, 100) || null;
  const parsedTransferAmount = Number(parsed.transferAmount);
  const transferAmount = isBankTransfer && Number.isFinite(parsedTransferAmount) && parsedTransferAmount >= 0
    ? Math.round(parsedTransferAmount * 100) / 100
    : null;
  const transferRecipient = isBankTransfer
    ? String(parsed.transferRecipient || "").trim().slice(0, 150) || null
    : null;
  const transferReference = isBankTransfer
    ? String(parsed.transferReference || receiptNumber || "").trim().slice(0, 150) || null
    : null;

  return {
    merchant: String(
      parsed.merchant || (isBankTransfer ? "Bank Transfer" : "Unknown Store"),
    ).trim(),
    amount: Math.round(amount * 100) / 100,
    category,
    isBankTransfer,
    confidence,
    isBlurry,
    transactionDate,
    receiptNumber,
    transferAmount,
    transferRecipient,
    transferReference,
  };
}

async function parseReceiptWithGemini(
  base64Data,
  mimeType,
  apiKey,
  _geminiApiKeys = [],
  { signal, timeoutMs, clientFactory, logger = console } = {},
) {
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please add your key in .env or the Settings drawer.",
    );
  }

  const prompt = `You are an expert Australian bill and receipt auditor for a flatmate grocery and household group.
Your task is to identify and extract VALID grocery, supermarket, and household bills, and STRICTLY EXCLUDE bank transfers, peer-to-peer payments, or settlement transaction screenshots.

CRITICAL NEGATIVE FILTER (EXCLUDE ONLY FLATMATES P2P TRANSFERS):
- STRICTLY EXCLUDE PEER-TO-PEER TRANSFERS: Images showing money transfers sent to another individual/flatmate (e.g. "Sent to Arjun", "Transfer to Shiva", "PayID payment to [Person]", "Osko payment to Arjun", "Transfer Successful to [Name]", "Account Transfer to [Name]").
  Set: isBankTransfer: true, amount: 0, merchant: "Bank Transfer", category: "Other".
  These are flatmate reimbursement transfers, not grocery expenses!

- VALID RETAIL CARD PAYMENTS (EVEN IF SHOWN IN A BANKING APP):
  If an image is a mobile banking app transaction screenshot showing a card purchase paid to a STORE, MERCHANT, or RESTAURANT (e.g. "Nepal House -$9.19", "Woolworths -$45.20", "Country Fresh -$15.00", "FoodWorks", "Primeline Butchery", "Indreni Supermarket"):
  This IS a valid expense!
  Set: isBankTransfer: false, merchant: Store name (e.g. "Nepal House"), amount: the positive purchase amount (e.g. 9.19), category: "Groceries" or "Dining".

RETAIL MERCHANTS & HOUSEHOLD BILLS:
- Supermarkets and grocery stores (Woolworths, Coles, Aldi, Indian Grocers, Costco, IGA, Asian supermarkets, butchers, fruit & veg).
- Utilities (Electricity, Gas, Internet, Water).
- Restaurant/Takeaway food dockets for the household (e.g. Nepal House, Bhok & Bhojan).
- General household supplies (Kmart, Target, Bunnings, Chemist Warehouse).

Output properties:
- merchant: Store name (e.g. "Woolworths", "Coles", "Aldi", "Indian Grocer").
- amount: The final grand total paid as a clean positive float (e.g. 45.20). If not a retail receipt, use 0.
- transactionDate: The purchase date printed on the receipt in YYYY-MM-DD form, or null when it is unavailable or uncertain.
- receiptNumber: The receipt, invoice, order, docket, or transaction reference printed on the receipt, or null when unavailable. Do not invent one.
- category: One of ["Groceries", "Utilities", "Dining", "Household Supplies", "Other"].
- isBankTransfer: true if bank transfer confirmation/screenshot, false if retail receipt.
- transferAmount: For a bank transfer only, the positive amount shown in the transfer confirmation, or null if unreadable. This is evidence metadata and never a grocery expense.
- transferRecipient: For a bank transfer only, the displayed recipient/payee name, or null if unavailable. Do not invent a person.
- transferReference: For a bank transfer only, the displayed bank transaction/reference ID, or null if unavailable.
- confidence: "HIGH" if numbers and store name are crisp and clear; "MEDIUM" if partially wrinkled; "LOW" if blurry/faded.
- isBlurry: true if image is low-resolution, out of focus, or numbers are hard to read; false otherwise.`;

  const structuredSchema = {
    type: "OBJECT",
    properties: {
      merchant: { type: "STRING" },
      amount: { type: "NUMBER" },
      transactionDate: { type: "STRING", nullable: true },
      receiptNumber: { type: "STRING", nullable: true },
      category: {
        type: "STRING",
        enum: [
          "Groceries",
          "Utilities",
          "Dining",
          "Household Supplies",
          "Other",
        ],
      },
      isBankTransfer: { type: "BOOLEAN" },
      transferAmount: { type: "NUMBER", nullable: true },
      transferRecipient: { type: "STRING", nullable: true },
      transferReference: { type: "STRING", nullable: true },
      confidence: { type: "STRING", enum: ["HIGH", "MEDIUM", "LOW"] },
      isBlurry: { type: "BOOLEAN" },
    },
    required: [
      "merchant",
      "amount",
      "transactionDate",
      "receiptNumber",
      "category",
      "isBankTransfer",
      "transferAmount",
      "transferRecipient",
      "transferReference",
      "confidence",
      "isBlurry",
    ],
  };

  if (signal?.aborted) {
    const error = new Error("Receipt recognition cancelled.");
    error.code = "SCAN_CANCELLED";
    throw error;
  }

  const maximumMs = requestTimeoutMs(timeoutMs);
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, maximumMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const startedAt = Date.now();
  try {
    const { GoogleGenAI } = require("@google/genai");
    const ai = clientFactory ? clientFactory(apiKey) : new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: GEMINI_OCR_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Data } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: structuredSchema,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingLevel: "MINIMAL" },
        abortSignal: requestSignal,
      },
    });
    const parsed = cleanAndParseJson(response.text || "");
    logger.log?.(`[Gemini OCR] model=${GEMINI_OCR_MODEL} duration_ms=${Date.now() - startedAt} status=success`);
    return parsed;
  } catch (cause) {
    const duration = Date.now() - startedAt;
    const status = Number(cause?.status || cause?.statusCode || cause?.response?.status) || null;
    logger.warn?.(`[Gemini OCR] model=${GEMINI_OCR_MODEL} duration_ms=${duration} status=error code=${status || cause?.code || cause?.name || "unknown"}`);
    if (timedOut) {
      const error = new Error(`Gemini OCR request timed out after ${maximumMs}ms.`);
      error.code = "GEMINI_REQUEST_TIMEOUT";
      error.cause = cause;
      throw error;
    }
    if (signal?.aborted) {
      const error = new Error("Receipt recognition cancelled.");
      error.code = "SCAN_CANCELLED";
      error.cause = cause;
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_GEMINI_REQUEST_TIMEOUT_MS,
  GEMINI_OCR_MODEL,
  MAX_GEMINI_REQUEST_TIMEOUT_MS,
  cleanAndParseJson,
  parseReceiptWithGemini,
  requestTimeoutMs,
};
