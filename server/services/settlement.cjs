function tagFuzzyDuplicates(expenses = []) {
  const n = expenses.length;
  for (let i = 0; i < n; i++) {
    const e1 = expenses[i];
    if (!e1 || parseFloat(e1.amount) <= 0) continue;
    const t1 = new Date(e1.date).getTime();

    for (let j = i + 1; j < n; j++) {
      const e2 = expenses[j];
      if (!e2 || parseFloat(e2.amount) <= 0) continue;
      const t2 = new Date(e2.date).getTime();

      // Same amount down to the cent
      const sameAmount =
        Math.abs(parseFloat(e1.amount) - parseFloat(e2.amount)) < 0.009;
      // Within 24 hours of each other
      const within24h = Math.abs(t1 - t2) <= 24 * 60 * 60 * 1000;
      // Same merchant OR same payer
      const samePayer =
        e1.paidBy &&
        e2.paidBy &&
        e1.paidBy.toLowerCase() === e2.paidBy.toLowerCase();
      const sameMerchant =
        e1.merchant &&
        e2.merchant &&
        e1.merchant.toLowerCase() === e2.merchant.toLowerCase();

      if (sameAmount && within24h && (samePayer || sameMerchant)) {
        e2.isDuplicate = true;
        e2.duplicateRefId = e1.id;
        e2.duplicateReason = `Matches ${e1.merchant} ($${parseFloat(e1.amount).toFixed(2)}) by ${e1.paidBy}`;
        if (typeof e2.isExcluded === "undefined") {
          e2.isExcluded = false;
        }
      }
    }
  }
  return expenses;
}

function calculateSettlement(
  expenses = [],
  memberAliases = {},
  groupMembers = [],
) {
  tagFuzzyDuplicates(expenses);
  const participantsSet = new Set();

  // 1. Group members strictly
  if (groupMembers && groupMembers.length > 0) {
    groupMembers.forEach((m) => {
      const id = typeof m === "string" ? m : m.id || m.number || m.name;
      const cleanNum =
        typeof m === "object" && m.number ? m.number.replace(/\D/g, "") : "";
      const resolved =
        (cleanNum && memberAliases[cleanNum]) ||
        (cleanNum && memberAliases[`+${cleanNum}`]) ||
        memberAliases[id] ||
        (typeof m === "object" && m.name && memberAliases[m.name]) ||
        (typeof m === "object" ? m.name || m.number : m);
      if (resolved && resolved.trim()) {
        participantsSet.add(resolved.trim());
      }
    });
  } else {
    // 4 canonical members for Rockdale Homies Grocery
    [
      "Arjun Bhurtel",
      "Arpan Bhurtel",
      "Shiva Kafle",
      "Swasti Adhikari",
    ].forEach((name) => {
      participantsSet.add(name);
    });
  }

  // 2. Any active payer in expenses
  expenses.forEach((e) => {
    if (e.paidBy && parseFloat(e.amount) > 0 && !e.isExcluded) {
      participantsSet.add(e.paidBy.trim());
    }
  });

  const participants = Array.from(participantsSet);
  if (participants.length === 0) {
    return {
      totalPool: 0,
      fairShare: 0,
      memberTotals: {},
      netBalances: {},
      transfers: [],
      reportText: "No valid expenses or participants found.",
    };
  }

  // Calculate totals per member
  const memberTotals = {};
  participants.forEach((p) => (memberTotals[p] = 0));
  let totalPool = 0;

  expenses.forEach((e) => {
    const amt = parseFloat(e.amount) || 0;
    if (amt > 0 && e.paidBy && !e.isExcluded) {
      memberTotals[e.paidBy] = (memberTotals[e.paidBy] || 0) + amt;
      totalPool += amt;
    }
  });

  totalPool = Math.round(totalPool * 100) / 100;
  const memberCount = participants.length;
  const fairShare =
    memberCount > 0 ? Math.round((totalPool / memberCount) * 100) / 100 : 0;

  // Net Balance: paid - fairShare
  const netBalances = {};
  const debtors = [];
  const creditors = [];

  participants.forEach((p) => {
    const paid = memberTotals[p] || 0;
    const net = Math.round((paid - fairShare) * 100) / 100;
    netBalances[p] = net;
    if (net < -0.009) {
      debtors.push({ name: p, amount: Math.abs(net) });
    } else if (net > 0.009) {
      creditors.push({ name: p, amount: net });
    }
  });

  // Sort descending by magnitude for greedy settlement
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let dIdx = 0;
  let cIdx = 0;

  while (dIdx < debtors.length && cIdx < creditors.length) {
    const debtor = debtors[dIdx];
    const creditor = creditors[cIdx];
    const transferAmt = Math.min(debtor.amount, creditor.amount);

    if (transferAmt > 0.009) {
      transfers.push({
        from: debtor.name,
        to: creditor.name,
        amount: Math.round(transferAmt * 100) / 100,
      });
    }

    debtor.amount = Math.round((debtor.amount - transferAmt) * 100) / 100;
    creditor.amount = Math.round((creditor.amount - transferAmt) * 100) / 100;

    if (debtor.amount <= 0.009) dIdx++;
    if (creditor.amount <= 0.009) cIdx++;
  }

  const centralSettlement = calculateCentralSettlement(
    memberTotals,
    fairShare,
    "Arjun Bhurtel",
  );

  return {
    totalPool,
    fairShare,
    memberTotals,
    netBalances,
    transfers,
    centralSettlement,
  };
}

function calculateCentralSettlement(
  memberTotals = {},
  fairShare = 0,
  treasurerName = "Arjun Bhurtel",
) {
  const canonicalMembers = [
    "Arjun Bhurtel",
    "Arpan Bhurtel",
    "Shiva Kafle",
    "Swasti Adhikari",
  ];

  // Step 1: Inflow to Arjun (Everyone else sends 1/4th fair share to Arjun)
  const inflowTransfers = [];
  canonicalMembers.forEach((m) => {
    if (m !== treasurerName && fairShare > 0) {
      inflowTransfers.push({
        from: m,
        to: treasurerName,
        amount: fairShare,
        description: "1/4th share contribution",
      });
    }
  });

  // Step 2: Outflow / reimbursement from Arjun (Arjun sends each member their bill spend)
  const outflowTransfers = [];
  canonicalMembers.forEach((m) => {
    const spent = memberTotals[m] || 0;
    if (m !== treasurerName && spent > 0) {
      outflowTransfers.push({
        from: treasurerName,
        to: m,
        amount: spent,
        description: "Bill spend reimbursement",
      });
    }
  });

  // Net shortcut: Direct net difference with Arjun
  const netTransfers = [];
  canonicalMembers.forEach((m) => {
    if (m === treasurerName) return;
    const spent = memberTotals[m] || 0;
    const net = Math.round((spent - fairShare) * 100) / 100;
    if (net < -0.009) {
      netTransfers.push({
        from: m,
        to: treasurerName,
        amount: Math.abs(net),
        type: "pays",
      });
    } else if (net > 0.009) {
      netTransfers.push({
        from: treasurerName,
        to: m,
        amount: net,
        type: "pays",
      });
    }
  });

  return {
    treasurer: treasurerName,
    fairShare,
    inflowTransfers,
    outflowTransfers,
    netTransfers,
  };
}

function formatWhatsAppReport({
  startDate,
  endDate,
  totalPool,
  fairShare,
  transfers,
  memberBreakdown,
  memberTotals,
  checkpointText,
}) {
  const period =
    startDate && endDate ? `${startDate} to ${endDate}` : "Billing Cycle";
  const members = [
    "Arjun Bhurtel",
    "Arpan Bhurtel",
    "Shiva Kafle",
    "Swasti Adhikari",
  ];

  const totals = {};
  members.forEach((m) => {
    totals[m] =
      memberBreakdown && memberBreakdown[m]
        ? memberBreakdown[m].total
        : memberTotals
          ? memberTotals[m] || 0
          : 0;
  });

  const billLines = members
    .map((m) => {
      const count =
        memberBreakdown && memberBreakdown[m] ? memberBreakdown[m].count : 0;
      return `• *${m}*: $${totals[m].toFixed(2)} (${count} bill${count === 1 ? "" : "s"})`;
    })
    .join("\n");

  const central = calculateCentralSettlement(
    totals,
    fairShare,
    "Arjun Bhurtel",
  );

  const step1List = central.inflowTransfers
    .map((t) => `   • *${t.from}* sends *$${t.amount.toFixed(2)}* ➡️ Arjun`)
    .join("\n");

  const step2List =
    central.outflowTransfers.length > 0
      ? central.outflowTransfers
          .map(
            (t) =>
              `   • Arjun sends *$${t.amount.toFixed(2)}* ➡️ *${t.to}* (reimbursement)`,
          )
          .join("\n")
      : "   • (No reimbursements needed)";

  const arjunRetains = totals["Arjun Bhurtel"] || 0;

  let netShortcutText = "";
  if (central.netTransfers.length === 0) {
    netShortcutText = "• All member balances are even!";
  } else {
    netShortcutText = central.netTransfers
      .map((t) => `• *${t.from}* pays *${t.to}*: *$${t.amount.toFixed(2)}*`)
      .join("\n");
  }

  const todayStr = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const checkpointHeader = checkpointText
    ? `📍 *Cycle Start Checkpoint:* "${checkpointText}"\n`
    : "";

  return `🛒 *ROCKDALE HOMIES GROCERY SETTLEMENT*
📅 *Period:* ${period}
${checkpointHeader}
💰 *Individual Member Bills:*
${billLines}
────────────────────────
💵 *Total Pool Spent:* $${totalPool.toFixed(2)}
➗ *1/4th Share Each:* $${fairShare.toFixed(2)}

🏦 *Settlement via Arjun Bhurtel's Account:*
*Step 1: Everyone sends 1/4th share ($${fairShare.toFixed(2)}) to Arjun:*
${step1List}
   *(Arjun holds the full pool: $${totalPool.toFixed(2)})*

*Step 2: Arjun sends each member their bill spend reimbursement:*
${step2List}
   *(Arjun retains his own spent contribution: $${arjunRetains.toFixed(2)})*

⚡ *1-Step Net Shortcut (Direct with Arjun):*
${netShortcutText}

✨ *Payment plan prepared: ${todayStr}*`;
}

module.exports = {
  tagFuzzyDuplicates,
  calculateSettlement,
  calculateCentralSettlement,
  formatWhatsAppReport,
};
