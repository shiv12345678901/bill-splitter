const { PRODUCTION_MEMBERS } = require("./worker-runtime.cjs");

const PARTICIPATION_MODES = Object.freeze(["enabled", "keep_receipts", "disabled"]);

function normalizeCycleMembership(value, members = PRODUCTION_MEMBERS) {
  const rows = Array.isArray(value?.members) ? value.members : Array.isArray(value) ? value : [];
  const byName = new Map(rows.map((row) => [String(row?.member_name || ""), row]));
  const normalized = members.map((memberName) => {
    const row = byName.get(memberName);
    const mode = row?.participation_mode || "enabled";
    if (!PARTICIPATION_MODES.includes(mode)) throw new Error(`Invalid participation mode for ${memberName}.`);
    return { member_name: memberName, participation_mode: mode };
  });
  if (rows.some((row) => !members.includes(String(row?.member_name || ""))))
    throw new Error("Membership contains an unknown household identity.");
  if (!normalized.some((row) => row.participation_mode === "enabled"))
    throw new Error("ZERO_ENABLED_MEMBERS");
  const revision = Number(value?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid settlement membership revision.");
  return { periodId: String(value?.period_id || ""), revision, members: normalized };
}

function disabledCycleMembers(membership) {
  return membership.members
    .filter((row) => row.participation_mode === "disabled")
    .map((row) => row.member_name);
}

function membershipSettlementForReceipts(receipts = [], membership) {
  const normalized = normalizeCycleMembership(membership);
  const modes = new Map(normalized.members.map((row) => [row.member_name, row.participation_mode]));
  const enabled = normalized.members
    .filter((row) => row.participation_mode === "enabled")
    .map((row) => row.member_name)
    .sort((a, b) => a.localeCompare(b));
  const paidCents = Object.fromEntries(normalized.members.map((row) => [row.member_name, 0]));
  let totalCents = 0;
  let receiptCount = 0;
  for (const receipt of receipts) {
    const payer = String(receipt?.payer || "");
    const amount = Number(receipt?.amount_cents);
    if (!modes.has(payer)) throw new Error(`Invalid saved receipt payer ${payer || "(missing)"}.`);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`Invalid saved receipt ${receipt?.id || "(unknown)"}.`);
    if (receipt.is_excluded || modes.get(payer) === "disabled") continue;
    totalCents += amount;
    paidCents[payer] += amount;
    receiptCount++;
  }
  if (!Number.isSafeInteger(totalCents)) throw new Error("Settlement exceeds safe integer cents.");

  const displayEqualShareCents = Math.round(totalCents / enabled.length);
  const baseShare = Math.floor(totalCents / enabled.length);
  const remainder = totalCents - baseShare * enabled.length;
  const shareCents = Object.fromEntries(normalized.members.map((row) => [row.member_name, 0]));
  enabled.forEach((memberName, index) => {
    shareCents[memberName] = baseShare + (index < remainder ? 1 : 0);
  });
  const netCents = Object.fromEntries(normalized.members.map((row) => [
    row.member_name,
    paidCents[row.member_name] - shareCents[row.member_name],
  ]));
  if (Object.values(netCents).reduce((sum, value) => sum + value, 0) !== 0)
    throw new Error("Settlement cent allocation is not balanced.");
  return {
    revision: normalized.revision,
    totalCents,
    displayEqualShareCents,
    receiptCount,
    paidCents,
    shareCents,
    netCents,
  };
}

module.exports = {
  PARTICIPATION_MODES,
  normalizeCycleMembership,
  disabledCycleMembers,
  membershipSettlementForReceipts,
};
