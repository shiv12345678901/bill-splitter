export type SettlementMember = { id: string; name: string };
export type SettlementExpense = { amount: number; payerId: string };
export type Transfer = {
  fromId: string;
  from: string;
  toId: string;
  to: string;
  amount: number;
};

export function calculateTransfers(
  members: SettlementMember[],
  expenses: SettlementExpense[],
): Transfer[] {
  if (members.length < 2 || expenses.length === 0) return [];
  const totalCents = expenses.reduce(
    (sum, expense) => sum + Math.round(expense.amount * 100),
    0,
  );
  const baseShare = Math.floor(totalCents / members.length);
  const remainder = totalCents % members.length;
  const paid = new Map(members.map((member) => [member.id, 0]));
  for (const expense of expenses)
    paid.set(
      expense.payerId,
      (paid.get(expense.payerId) ?? 0) + Math.round(expense.amount * 100),
    );

  const balances = members.map((member, index) => ({
    ...member,
    cents: (paid.get(member.id) ?? 0) - baseShare - (index < remainder ? 1 : 0),
  }));
  const debtors = balances
    .filter((member) => member.cents < 0)
    .map((member) => ({ ...member, cents: -member.cents }));
  const creditors = balances
    .filter((member) => member.cents > 0)
    .map((member) => ({ ...member }));
  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const cents = Math.min(debtor.cents, creditor.cents);
    if (cents > 0)
      transfers.push({
        fromId: debtor.id,
        from: debtor.name,
        toId: creditor.id,
        to: creditor.name,
        amount: cents / 100,
      });
    debtor.cents -= cents;
    creditor.cents -= cents;
    if (debtor.cents === 0) debtorIndex += 1;
    if (creditor.cents === 0) creditorIndex += 1;
  }
  return transfers;
}
