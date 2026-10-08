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

  return {
    merchant: String(
      parsed.merchant || (isBankTransfer ? "Bank Transfer" : "Unknown Store"),
    ).trim(),
    amount: Math.round(amount * 100) / 100,
    category,
    isBankTransfer,
    confidence,
    isBlurry,
  };
}

async function parseReceiptWithGemini(
  base64Data,
  mimeType,
  apiKey,
  geminiApiKeys = [],
  { signal } = {},
) {
  const keysToTry = [];
  if (apiKey) keysToTry.push(apiKey);
  geminiApiKeys.forEach((k) => {
    if (k && !keysToTry.includes(k)) keysToTry.push(k);
  });

  if (keysToTry.length === 0) {
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
- category: One of ["Groceries", "Utilities", "Dining", "Household Supplies", "Other"].
- isBankTransfer: true if bank transfer confirmation/screenshot, false if retail receipt.
- confidence: "HIGH" if numbers and store name are crisp and clear; "MEDIUM" if partially wrinkled; "LOW" if blurry/faded.
- isBlurry: true if image is low-resolution, out of focus, or numbers are hard to read; false otherwise.`;

  const structuredSchema = {
    type: "OBJECT",
    properties: {
      merchant: { type: "STRING" },
      amount: { type: "NUMBER" },
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
      confidence: { type: "STRING", enum: ["HIGH", "MEDIUM", "LOW"] },
      isBlurry: { type: "BOOLEAN" },
    },
    required: [
      "merchant",
      "amount",
      "category",
      "isBankTransfer",
      "confidence",
      "isBlurry",
    ],
  };

  const candidateModels = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash",
  ];
  let lastError = null;

  for (const key of keysToTry) {
    for (const modelName of candidateModels) {
      if (signal?.aborted) throw new Error("Receipt recognition cancelled.");
      // 1. Try official @google/genai SDK with Structured Schema
      try {
        const { GoogleGenAI } = require("@google/genai");
        const ai = new GoogleGenAI({ apiKey: key });
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: structuredSchema,
            abortSignal: signal,
          },
        });
        const text = response.text || "";
        return cleanAndParseJson(text);
      } catch (sdkError) {
        if (signal?.aborted) throw sdkError;
        lastError = sdkError;
      }

      // 2. Fallback to @google/generative-ai SDK
      try {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { responseMimeType: "application/json" },
        });
        const result = await model.generateContent(
          [
            prompt,
            {
              inlineData: {
                data: base64Data,
                mimeType,
              },
            },
          ],
          { signal },
        );
        const text = result.response.text();
        return cleanAndParseJson(text);
      } catch (fallbackError) {
        if (signal?.aborted) throw fallbackError;
        lastError = fallbackError;
      }
    }
  }

  throw new Error(
    `Gemini Vision extraction failed across ${keysToTry.length} key(s): ${lastError?.message || "Unsupported model or API key error"}`,
  );
}

module.exports = { cleanAndParseJson, parseReceiptWithGemini };
