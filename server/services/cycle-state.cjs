const CLEARANCE_PATTERN = /\b(clear(?:ed)?\s*(?:up\s*to|upto|till)|settled?\s*(?:up\s*to|upto|till)|all\s*cleared|all\s*settled|clear\s*date)\b/i;
const FUTURE_CLEARANCE_PATTERN = /\b(?:will|we['’]?ll|we\s+will|going\s+to|plan(?:ning)?\s+to|should|could|can)\s+(?:\w+\s+){0,3}(?:clear|settle)|\b(?:clear|settle)(?:\s+\w+){0,4}\s+(?:tomorrow|later|tonight)\b/i;
const SYDNEY_TIME_ZONE = "Australia/Sydney";

function sydneyDate(timestamp) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SYDNEY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(Number(timestamp) * 1000));
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function sydneyStartTimestamp(date) {
  const desiredMs = Date.parse(`${date}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SYDNEY_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let guessMs = desiredMs - 11 * 60 * 60 * 1000;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = formatter.formatToParts(new Date(guessMs));
    const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);
    const representedMs = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    guessMs += desiredMs - representedMs;
  }
  return Math.floor(guessMs / 1000);
}

function displayTime(timestamp) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(Number(timestamp) * 1000));
}

function isExplicitClearanceMessage(text) {
  if (typeof text !== "string") return false;
  const clean = text.trim();
  return CLEARANCE_PATTERN.test(clean) && !FUTURE_CLEARANCE_PATTERN.test(clean);
}

function isCalculationMessage(text) {
  if (!text || typeof text !== "string") return false;
  const clean = text.trim();
  if (!/\d/.test(clean)) return false;
  const addition = /\d+(?:\.\d+)?\s*\+\s*\d+(?:\.\d+)?/.test(clean);
  const members = clean.match(/\b(arjun|arpan|shiva|swasti|nani)\s*={1,2}\s*[\d+.]+/gi);
  const memberBreakdown = Boolean(members && members.length >= 2);
  const total = /total\s*={1,2}\s*\$?\s*[\d,]+(?:\.\d+)?/i.test(clean)
    && (/(each|\/\s*4|\$)/i.test(clean) || Boolean(members?.length));
  const keywordMath = /\b(calculation|calculated|breakdown|hisab|hisaab)\b/i.test(clean)
    && (/\d+(?:\.\d+)?\s*[+=]\s*[\d+.]+/i.test(clean) || addition || Boolean(members?.length));
  return memberBreakdown || total || keywordMath || (addition && /=/.test(clean));
}

function parseGroundTruth(text) {
  if (!text) return null;
  const result = { memberTotals: {}, totalPool: null, fairShare: null, rawText: text.trim().slice(0, 300) };
  const total = text.match(/total\s*={1,2}\s*[^=]*?=\s*([\d,]+\.?\d*)/i)
    || text.match(/total\s*={1,2}\s*([\d,]+\.?\d*)/i);
  if (total) result.totalPool = Number.parseFloat(total[1].replace(/,/g, ""));
  const share = text.match(/\$?\s*([\d,]+\.?\d*)\s*each/i);
  if (share) result.fairShare = Number.parseFloat(share[1].replace(/,/g, ""));
  else if (result.totalPool) result.fairShare = Math.round((result.totalPool / 4) * 100) / 100;
  const names = { arjun: "Arjun Bhurtel", arpan: "Arpan Bhurtel", shiva: "Shiva Kafle", swasti: "Swasti Adhikari", nani: "Swasti Adhikari" };
  for (const [shortName, fullName] of Object.entries(names)) {
    const match = text.match(new RegExp(`(?:^|\\s|\\n)${shortName}\\s*={1,2}(?:[^=\\n]*?=\\s*)?\\s*([\\d,]+\\.?\\d*)`, "i"));
    if (match) result.memberTotals[fullName] = Number.parseFloat(match[1].replace(/,/g, ""));
  }
  return result;
}

function uniqueMessages(messages = []) {
  const byId = new Map();
  for (const input of messages) {
    const id = String(input?.id || "").trim();
    const timestamp = Number(input?.timestamp);
    if (!id || !Number.isFinite(timestamp) || timestamp <= 0) continue;
    const message = { ...input, id, timestamp, body: String(input.body || "") };
    const existing = byId.get(id);
    if (!existing || (!existing.body && message.body) || (!existing.isMedia && message.isMedia)) byId.set(id, message);
  }
  return [...byId.values()].sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

function markerBoundary(message) {
  return {
    id: message.id, timestamp: message.timestamp, dateStr: sydneyDate(message.timestamp), timeStr: displayTime(message.timestamp),
    text: message.body.trim().replace(/\n+/g, " ").slice(0, 300), source: "marker", confidence: "HIGH",
  };
}

function firstBoundary(groupId, configuredDate, firstMessage) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(configuredDate || "")) {
    return { id: `configured-start:${groupId}:${configuredDate}`, timestamp: sydneyStartTimestamp(configuredDate) - 1, dateStr: configuredDate, text: "Configured group start", source: "configured", confidence: "HIGH" };
  }
  if (!firstMessage) return null;
  return { id: `history-start:${groupId}:${firstMessage.id}`, timestamp: firstMessage.timestamp - 1, dateStr: sydneyDate(firstMessage.timestamp), text: "First available WhatsApp message", source: "history", confidence: "HIGH" };
}

function messageView(message, aliases) {
  const author = String(message.author || "");
  const digits = author.split("@")[0].replace(/\D/g, "");
  return {
    id: message.id, timestamp: message.timestamp, timeStr: displayTime(message.timestamp), author,
    authorName: aliases[author] || aliases[digits] || aliases[`+${digits}`] || "Flatmate",
    preview: message.preview || "", classification: message.classification || "unclassified",
  };
}

function buildCycle({ id, messages, startBoundary, endBoundary, aliases, nowTs }) {
  const startTs = Number.isFinite(startBoundary?.timestamp) ? startBoundary.timestamp + 1 : messages[0]?.timestamp || nowTs;
  const endTs = endBoundary?.timestamp ?? null;
  const within = messages.filter((message) => message.timestamp >= startTs && (endTs === null || message.timestamp <= endTs));
  const calculation = within.filter((message) =>
    !message.isNotification &&
    !message.isMedia &&
    isCalculationMessage(message.body)
  ).at(-1) || null;
  const groceryMessages = [];
  const paymentMessages = [];
  const unclassifiedMessages = [];
  for (const message of within) {
    if (!message.isMedia) continue;
    const view = messageView(message, aliases);
    if (message.classification === "bank_transfer") paymentMessages.push(view);
    else if (message.classification === "grocery_receipt") groceryMessages.push(view);
    else unclassifiedMessages.push(view);
  }
  const status = endBoundary ? "SETTLED" : calculation ? "PENDING_SETTLEMENT" : "ACTIVE";
  const calculationMessage = calculation
    ? { id: calculation.id, text: calculation.body, timestamp: calculation.timestamp, timeStr: displayTime(calculation.timestamp), source: "calculation", confidence: "HIGH" }
    : null;
  const clearanceMessage = endBoundary
    ? { id: endBoundary.id, text: endBoundary.text, timestamp: endBoundary.timestamp, timeStr: displayTime(endBoundary.timestamp), source: "marker", confidence: "HIGH" }
    : null;
  return {
    id,
    title: status === "SETTLED" ? `Settlement: ${sydneyDate(startTs)} to ${sydneyDate(endTs)}`
      : status === "PENDING_SETTLEMENT" ? `Awaiting clearance (Since ${sydneyDate(startTs)})`
        : `Current Active Cycle (Since ${sydneyDate(startTs)})`,
    status, settlementConfirmed: Boolean(endBoundary), startBoundary, endBoundary: endBoundary || null,
    startCheckpoint: startBoundary, endCheckpoint: endBoundary || null, calculationMessage, clearanceMessage,
    groundTruth: calculation ? parseGroundTruth(calculation.body) : null,
    startTs, endTs, calcTs: calculation?.timestamp || null, startDate: sydneyDate(startTs),
    endDate: endTs === null ? null : sydneyDate(endTs),
    groceryCount: groceryMessages.length, paymentCount: paymentMessages.length, unclassifiedCount: unclassifiedMessages.length,
    groceryMessages, paymentMessages, unclassifiedMessages,
  };
}

function buildSettlementCycles({ groupId, aliases = {}, configuredGroupStart = null, messages = [], nowTs = Math.floor(Date.now() / 1000) }) {
  const sorted = uniqueMessages(messages);
  if (!sorted.length && !configuredGroupStart) return [];
  const markers = [];
  for (const message of sorted) {
    if (message.isNotification || message.isMedia || !isExplicitClearanceMessage(message.body)) continue;
    const boundary = markerBoundary(message);
    const previous = markers.at(-1);
    if (previous) {
      const meaningfulBetween = sorted.some((candidate) =>
        candidate.timestamp > previous.timestamp && candidate.timestamp < boundary.timestamp &&
        (candidate.isMedia || isCalculationMessage(candidate.body)),
      );
      if (!meaningfulBetween) continue;
    }
    markers.push(boundary);
  }
  const cycles = [];
  let startBoundary = firstBoundary(groupId, configuredGroupStart, sorted[0]);
  for (let index = 0; index < markers.length; index += 1) {
    cycles.push(buildCycle({ id: `cycle_hist_${index + 1}`, messages: sorted, startBoundary, endBoundary: markers[index], aliases, nowTs }));
    startBoundary = markers[index];
  }
  cycles.push(buildCycle({ id: "cycle_current", messages: sorted, startBoundary, endBoundary: null, aliases, nowTs }));
  return cycles.reverse();
}

function selectCycleForPeriod(cycles, periodStartDate) {
  const matches = (cycles || []).filter((cycle) =>
    cycle.startDate <= periodStartDate && (cycle.endDate === null || cycle.endDate >= periodStartDate),
  );
  return matches.length === 1 ? matches[0] : null;
}

function planPeriodRollover(cycles, period) {
  if (!period || period.status !== "CURRENT" || !/^\d{4}-\d{2}-\d{2}$/.test(period.start_date || "")) {
    throw new Error("A valid CURRENT Supabase period is required for cycle mapping.");
  }
  const matches = (cycles || []).filter((cycle) =>
    cycle.startDate <= period.start_date && (cycle.endDate === null || cycle.endDate >= period.start_date),
  );
  if (matches.length !== 1) throw new Error("The CURRENT period does not map to exactly one WhatsApp cycle.");
  const mappedCycle = matches[0];
  if (["ACTIVE", "PENDING_SETTLEMENT"].includes(mappedCycle.status)) {
    return { action: "continue", cycle: mappedCycle };
  }
  if (mappedCycle.status !== "SETTLED" || !mappedCycle.settlementConfirmed ||
    mappedCycle.clearanceMessage?.source !== "marker" || mappedCycle.clearanceMessage?.confidence !== "HIGH") {
    throw new Error("The mapped WhatsApp cycle is not closed by a verified explicit clearance marker.");
  }
  if (!period.end_date || period.end_date !== mappedCycle.endDate) {
    throw new Error("The period end date does not match the verified WhatsApp clearance date.");
  }
  const openCycles = (cycles || []).filter((cycle) => ["ACTIVE", "PENDING_SETTLEMENT"].includes(cycle.status));
  if (openCycles.length !== 1) throw new Error("The next open WhatsApp cycle is ambiguous.");
  const nextCycle = openCycles[0];
  const boundaryTimestamp = Number(mappedCycle.endBoundary?.timestamp);
  if (!Number.isFinite(boundaryTimestamp)) throw new Error("The verified clearance has no stable timestamp.");
  const expectedNextStartDate = sydneyDate(boundaryTimestamp + 1);
  if (!mappedCycle.endBoundary?.id || nextCycle.startBoundary?.id !== mappedCycle.endBoundary.id ||
    nextCycle.startDate !== expectedNextStartDate) {
    throw new Error("The next WhatsApp cycle does not begin at the verified clearance boundary.");
  }
  return {
    action: "rollover",
    closedCycle: mappedCycle,
    nextCycle,
    newPeriodId: `period_${nextCycle.startDate}`,
    newSettlementId: `settlement_${nextCycle.startDate}_current`,
  };
}

module.exports = { SYDNEY_TIME_ZONE, buildSettlementCycles, isCalculationMessage, isExplicitClearanceMessage, parseGroundTruth, planPeriodRollover, selectCycleForPeriod, sydneyDate, sydneyStartTimestamp };
