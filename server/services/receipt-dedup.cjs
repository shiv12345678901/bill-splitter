const jpeg = require("jpeg-js");

const normaliseText = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[^a-z0-9]/gi, "")
  .toLowerCase();

function normaliseReference(value) {
  const cleaned = normaliseText(value);
  return cleaned.length >= 5 ? cleaned : "";
}

function validDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]
    ? ""
    : match[0];
}

function jpegPerceptualHash(buffer) {
  try {
    const image = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    if (!image?.width || !image?.height || !image.data?.length) return null;
    const values = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        const sourceX = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / 9));
        const sourceY = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / 8));
        const offset = (sourceY * image.width + sourceX) * 4;
        values.push(Math.round(
          image.data[offset] * 0.299 +
          image.data[offset + 1] * 0.587 +
          image.data[offset + 2] * 0.114,
        ));
      }
    }
    let bits = "";
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const offset = y * 9 + x;
        bits += values[offset] > values[offset + 1] ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

function perceptualSimilarity(left, right) {
  if (!/^[0-9a-f]{16}$/i.test(left || "") || !/^[0-9a-f]{16}$/i.test(right || "")) return null;
  let difference = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let changed = 0;
  while (difference) {
    changed += Number(difference & 1n);
    difference >>= 1n;
  }
  return 1 - changed / 64;
}

function duplicateEvidence(left, right) {
  if (!left || !right || left.isBankTransfer || right.isBankTransfer) return null;
  const leftAmount = Math.round((Number(left.amount) || 0) * 100);
  const rightAmount = Math.round((Number(right.amount) || 0) * 100);
  if (leftAmount <= 0 || rightAmount <= 0) return null;

  if (left.contentHash && left.contentHash === right.contentHash) {
    return { kind: "identical-file", similarity: 1 };
  }

  const merchantMatch = normaliseText(left.merchant) &&
    normaliseText(left.merchant) === normaliseText(right.merchant);
  const amountMatch = leftAmount === rightAmount;
  const leftDate = validDate(left.transactionDate);
  const rightDate = validDate(right.transactionDate);
  const transactionDateMatch = leftDate && leftDate === rightDate;
  const leftReference = normaliseReference(left.receiptNumber || left.referenceNumber);
  const rightReference = normaliseReference(right.receiptNumber || right.referenceNumber);
  const referenceMatch = leftReference && leftReference === rightReference;
  const similarity = perceptualSimilarity(left.perceptualHash, right.perceptualHash);

  if (referenceMatch && ((merchantMatch && amountMatch) || (amountMatch && transactionDateMatch))) {
    return { kind: "receipt-reference", similarity };
  }
  if (similarity !== null && similarity >= 0.9 && merchantMatch && amountMatch && transactionDateMatch) {
    return { kind: "receipt-image", similarity };
  }
  if (similarity !== null && similarity >= 0.97 && merchantMatch && amountMatch && (!leftDate || !rightDate || transactionDateMatch)) {
    return { kind: "receipt-image-strong", similarity };
  }
  return null;
}

function tagReceiptDuplicates(receipts = []) {
  const ordered = receipts
    .map((receipt, index) => ({ receipt, index }))
    .sort((left, right) =>
      (Date.parse(left.receipt?.date || "") || 0) - (Date.parse(right.receipt?.date || "") || 0) ||
      String(left.receipt?.id || "").localeCompare(String(right.receipt?.id || "")),
    );
  const canonical = [];
  for (const item of ordered) {
    const receipt = item.receipt;
    if (!receipt || receipt.isBankTransfer || receipt.duplicateReviewResolved || receipt.reviewed) {
      canonical.push(receipt);
      continue;
    }
    const match = canonical.find((candidate) => duplicateEvidence(candidate, receipt));
    if (!match) {
      canonical.push(receipt);
      continue;
    }
    const evidence = duplicateEvidence(match, receipt);
    receipt.isDuplicate = true;
    receipt.needsReview = true;
    receipt.isExcluded = true;
    receipt.duplicateRefId = match.id;
    receipt.duplicateEvidence = evidence.kind;
    receipt.imageSimilarity = evidence.similarity;
    receipt.duplicateReason = `Possible duplicate of ${match.merchant || "another receipt"}; excluded until reviewed.`;
  }
  return receipts;
}

module.exports = {
  duplicateEvidence,
  jpegPerceptualHash,
  perceptualSimilarity,
  tagReceiptDuplicates,
};
