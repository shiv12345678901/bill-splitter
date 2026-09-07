import type { ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import type { Expense } from '@/lib/splitmate-models';

type ReceiptsViewProps = {
  search: string;
  filter: 'active' | 'settled';
  expenses: Expense[];
  filteredExpenses: Expense[];
  onSearch: (value: string) => void;
  onFilter: (value: 'active' | 'settled') => void;
  renderReceipt: (expense: Expense) => ReactNode;
};

export function ReceiptsView({
  search,
  filter,
  expenses,
  filteredExpenses,
  onSearch,
  onFilter,
  renderReceipt,
}: ReceiptsViewProps) {
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
      <div className="list-card">
        {filteredExpenses.length ? (
          filteredExpenses.map(renderReceipt)
        ) : (
          <div className="empty-state">
            <Search />
            <strong>No matching receipts</strong>
            <p>Try a different search.</p>
          </div>
        )}
      </div>
    </section>
  );
}
