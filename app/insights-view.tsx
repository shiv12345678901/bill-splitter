'use client';

import { useState } from 'react';
import {
  ChartNoAxesColumnIncreasing,
  ChevronLeft,
  ChevronRight,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { Cycle, Expense, Member } from '@/lib/splitmate-models';
type InsightsProps = {
  expenses: Expense[];
  members: Member[];
  cycles: Cycle[];
};

const money = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});
const chartConfig = {
  total: { label: 'Spent', color: 'var(--blue)' },
} satisfies ChartConfig;
const monthKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

function Avatar({ member }: { member: Member }) {
  const initials = member.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className="avatar avatar-small"
      style={{ background: member.color }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

export default function InsightsView({
  expenses,
  members,
  cycles,
}: InsightsProps) {
  const [monthOffset, setMonthOffset] = useState(0);
  const now = new Date();
  const selectedDate = new Date(
    now.getFullYear(),
    now.getMonth() + monthOffset,
    1,
  );
  const selectedKey = monthKey(selectedDate);
  const previousKey = monthKey(
    new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1),
  );
  const selectedExpenses = expenses.filter((expense) =>
    expense.receiptDate.startsWith(selectedKey),
  );
  const monthTotal = selectedExpenses.reduce(
    (sum, expense) => sum + expense.amount,
    0,
  );
  const previousTotal = expenses
    .filter((expense) => expense.receiptDate.startsWith(previousKey))
    .reduce((sum, expense) => sum + expense.amount, 0);
  const change =
    previousTotal > 0
      ? Math.round(((monthTotal - previousTotal) / previousTotal) * 100)
      : null;
  const average = selectedExpenses.length
    ? monthTotal / selectedExpenses.length
    : 0;
  const categoryTotals = Object.entries(
    selectedExpenses.reduce<Record<string, number>>(
      (totals, expense) => ({
        ...totals,
        [expense.category]: (totals[expense.category] ?? 0) + expense.amount,
      }),
      {},
    ),
  ).sort((a, b) => b[1] - a[1]);
  const merchantTotals = Object.entries(
    selectedExpenses.reduce<Record<string, number>>(
      (totals, expense) => ({
        ...totals,
        [expense.merchant]: (totals[expense.merchant] ?? 0) + expense.amount,
      }),
      {},
    ),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const memberTotals = members
    .map((member) => ({
      ...member,
      total: selectedExpenses
        .filter((expense) => expense.payerId === member.id)
        .reduce((sum, expense) => sum + expense.amount, 0),
    }))
    .sort((a, b) => b.total - a.total);
  const trendData = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth() - 5 + index,
      1,
    );
    const key = monthKey(date);
    return {
      month: new Intl.DateTimeFormat('en-AU', { month: 'short' }).format(date),
      total: expenses
        .filter((expense) => expense.receiptDate.startsWith(key))
        .reduce((sum, expense) => sum + expense.amount, 0),
    };
  });
  const largestCategory = categoryTotals[0]?.[1] || 1;
  const largestMemberTotal = memberTotals[0]?.total || 1;
  const label = new Intl.DateTimeFormat('en-AU', {
    month: 'long',
    year: 'numeric',
  }).format(selectedDate);

  return (
    <section className="single-column insights-page">
      <div className="insight-period">
        <button
          onClick={() => setMonthOffset((value) => value - 1)}
          aria-label="Previous month"
        >
          <ChevronLeft size={19} />
        </button>
        <div>
          <strong>{label}</strong>
          <span>
            {selectedExpenses.length} receipt
            {selectedExpenses.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          disabled={monthOffset >= 0}
          onClick={() => setMonthOffset((value) => Math.min(0, value + 1))}
          aria-label="Next month"
        >
          <ChevronRight size={19} />
        </button>
      </div>
      <div className="insight-hero">
        <span>Total household spend</span>
        <strong>{money.format(monthTotal)}</strong>
        <div>
          <span>
            {money.format(members.length ? monthTotal / members.length : 0)}{' '}
            each
          </span>
          {change === null ? (
            <span>No prior comparison</span>
          ) : (
            <span className={change <= 0 ? 'positive' : 'negative'}>
              {change <= 0 ? (
                <TrendingDown size={14} />
              ) : (
                <TrendingUp size={14} />
              )}
              {Math.abs(change)}% vs previous month
            </span>
          )}
        </div>
      </div>
      <div className="insight-metrics">
        <div>
          <span>Average bill</span>
          <strong>{money.format(average)}</strong>
        </div>
        <div>
          <span>Largest bill</span>
          <strong>
            {selectedExpenses.length
              ? money.format(
                  Math.max(
                    ...selectedExpenses.map((expense) => expense.amount),
                  ),
                )
              : money.format(0)}
          </strong>
        </div>
      </div>
      <div className="insight-card trend-card">
        <div className="section-heading">
          <h2>Six-month trend</h2>
          <span>
            {money.format(trendData.reduce((sum, item) => sum + item.total, 0))}{' '}
            total
          </span>
        </div>
        <ChartContainer config={chartConfig} className="spend-chart">
          <AreaChart
            data={trendData}
            margin={{ top: 8, right: 4, left: 4, bottom: 0 }}
          >
            <defs>
              <linearGradient id="spending-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--blue)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--blue)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              vertical={false}
              stroke="var(--line)"
              strokeDasharray="3 4"
            />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tick={{ fill: 'var(--muted)', fontSize: 11 }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  className="insight-tooltip"
                  hideLabel
                  formatter={(value) => (
                    <span>{money.format(Number(value))}</span>
                  )}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke="var(--blue)"
              strokeWidth={3}
              fill="url(#spending-fill)"
              activeDot={{ r: 5 }}
            />
          </AreaChart>
        </ChartContainer>
      </div>
      <div className="insight-card">
        <div className="section-heading">
          <h2>Where it went</h2>
          <span>{categoryTotals.length} categories</span>
        </div>
        {categoryTotals.length ? (
          categoryTotals.map(([category, amount]) => (
            <div className="category-row" key={category}>
              <div>
                <span>{category}</span>
                <b>
                  {money.format(amount)} ·{' '}
                  {monthTotal ? Math.round((amount / monthTotal) * 100) : 0}%
                </b>
              </div>
              <i>
                <span
                  style={{
                    width: `${Math.max(5, (amount / largestCategory) * 100)}%`,
                  }}
                />
              </i>
            </div>
          ))
        ) : (
          <div className="empty-state compact">
            <ChartNoAxesColumnIncreasing />
            <strong>No spending this month</strong>
            <p>Choose a different month or add a receipt.</p>
          </div>
        )}
      </div>
      {selectedExpenses.length > 0 && (
        <div className="insight-card">
          <div className="section-heading">
            <h2>Paid by</h2>
            <span>Before equal split</span>
          </div>
          {memberTotals.map((member) => (
            <div className="member-spend" key={member.id}>
              <Avatar member={member} />
              <div>
                <span>
                  <strong>{member.name}</strong>
                  <b>{money.format(member.total)}</b>
                </span>
                <i>
                  <span
                    style={{
                      width: `${member.total ? Math.max(5, (member.total / largestMemberTotal) * 100) : 0}%`,
                      background: member.color,
                    }}
                  />
                </i>
              </div>
            </div>
          ))}
        </div>
      )}
      {merchantTotals.length > 0 && (
        <div className="insight-card">
          <div className="section-heading">
            <h2>Top merchants</h2>
            <span>Highest spend</span>
          </div>
          {merchantTotals.map(([merchant, amount], index) => (
            <div className="merchant-rank" key={merchant}>
              <span>{index + 1}</span>
              <strong>{merchant}</strong>
              <b>{money.format(amount)}</b>
            </div>
          ))}
        </div>
      )}
      {cycles.length > 0 && monthOffset === 0 && (
        <div className="insight-card">
          <div className="section-heading">
            <h2>Recent settlements</h2>
            <span>Completed cycles</span>
          </div>
          {cycles.slice(0, 3).map((cycle) => (
            <div className="history-row" key={cycle.id}>
              <div>
                <strong>
                  {new Date(cycle.settled_at).toLocaleDateString('en-AU', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </strong>
                <span>{cycle.member_count} people</span>
              </div>
              <b>{money.format(cycle.total_amount)}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
