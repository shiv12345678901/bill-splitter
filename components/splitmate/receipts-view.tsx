import type { ReactNode } from 'react';
import { SlidersHorizontal, Search, X } from 'lucide-react';
import type { Expense, Member } from '@/lib/splitmate-models';
import { money } from '@/lib/splitmate-models';

export type ReceiptSort = 'newest' | 'oldest' | 'highest' | 'lowest';
export type ReceiptFilters = {
  category: string;
  memberId: string;
  from: string;
  to: string;
  sort: ReceiptSort;
};

type Props = {
  search: string;
  filter: 'active' | 'settled';
  expenses: Expense[];
  filteredExpenses: Expense[];
  categories: string[];
  members: Member[];
  filters: ReceiptFilters;
  visibleCount: number;
  canLoadMore: boolean;
  onSearch: (value: string) => void;
  onFilter: (value: 'active' | 'settled') => void;
  onFilters: (filters: ReceiptFilters) => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  renderReceipt: (expense: Expense) => ReactNode;
};

const monthLabel = (date: string) =>
  new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(
    new Date(`${date}T12:00:00`),
  );

export function ReceiptsView(props: Props) {
  const {
    search,
    filter,
    expenses,
    filteredExpenses,
    categories,
    members,
    filters,
    visibleCount,
    canLoadMore,
    onSearch,
    onFilter,
    onFilters,
    onClearFilters,
    onLoadMore,
    renderReceipt,
  } = props;
  const visible = filteredExpenses.slice(0, visibleCount);
  const groups = visible.reduce<Record<string, Expense[]>>(
    (result, expense) => {
      const label = monthLabel(expense.receiptDate);
      (result[label] ??= []).push(expense);
      return result;
    },
    {},
  );
  const filtered = Boolean(
    filters.category ||
    filters.memberId ||
    filters.from ||
    filters.to ||
    filters.sort !== 'newest',
  );
  const resultTotal = filteredExpenses.reduce(
    (sum, expense) => sum + expense.amount,
    0,
  );

  return (
    <section className="single-column">
      <div className="search-field">
        <Search size={18} />
        <input
          aria-label="Search receipts"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search merchant, category or person"
        />
        {search && (
          <button
            className="search-clear"
            onClick={() => onSearch('')}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div className="segmented">
        <button
          aria-pressed={filter === 'active'}
          className={filter === 'active' ? 'selected' : ''}
          onClick={() => onFilter('active')}
        >
          Current · {expenses.filter((expense) => !expense.settled).length}
        </button>
        <button
          aria-pressed={filter === 'settled'}
          className={filter === 'settled' ? 'selected' : ''}
          onClick={() => onFilter('settled')}
        >
          History · {expenses.filter((expense) => expense.settled).length}
        </button>
      </div>
      <details className="receipt-filters">
        <summary>
          <SlidersHorizontal size={17} /> Filter and sort {filtered && <i />}
        </summary>
        <div className="filter-grid">
          <label>
            Category
            <select
              value={filters.category}
              onChange={(event) =>
                onFilters({ ...filters, category: event.target.value })
              }
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label>
            Paid by
            <select
              value={filters.memberId}
              onChange={(event) =>
                onFilters({ ...filters, memberId: event.target.value })
              }
            >
              <option value="">All members</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(event) =>
                onFilters({ ...filters, from: event.target.value })
              }
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(event) =>
                onFilters({ ...filters, to: event.target.value })
              }
            />
          </label>
          <label>
            Sort
            <select
              value={filters.sort}
              onChange={(event) =>
                onFilters({
                  ...filters,
                  sort: event.target.value as ReceiptSort,
                })
              }
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="highest">Highest total</option>
              <option value="lowest">Lowest total</option>
            </select>
          </label>
          {filtered && (
            <button className="clear-filters" onClick={onClearFilters}>
              Clear filters
            </button>
          )}
        </div>
      </details>
      <div className="receipt-results">
        <span>
          {filteredExpenses.length} receipt
          {filteredExpenses.length === 1 ? '' : 's'}
        </span>
        <strong>{money.format(resultTotal)}</strong>
      </div>
      {visible.length ? (
        Object.entries(groups).map(([month, items]) => (
          <section className="receipt-month" key={month}>
            <h2>{month}</h2>
            <div className="list-card">{items.map(renderReceipt)}</div>
          </section>
        ))
      ) : (
        <div className="list-card">
          <div className="empty-state">
            <Search />
            <strong>No matching receipts</strong>
            <p>Try a different search or clear the filters.</p>
          </div>
        </div>
      )}
      {(visibleCount < filteredExpenses.length || canLoadMore) && (
        <button className="load-more" onClick={onLoadMore}>
          Show more receipts
        </button>
      )}
    </section>
  );
}
