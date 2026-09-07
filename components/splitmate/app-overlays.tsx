import { Check, Trash2 } from 'lucide-react';
import type { Expense, ToastState } from '@/lib/splitmate-models';
import type { Transfer } from '@/lib/settlements';
import { money } from '@/lib/splitmate-models';

export function SettlementReview({
  open,
  expenses,
  total,
  transfers,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  expenses: Expense[];
  total: number;
  transfers: Transfer[];
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="confirm-backdrop" role="presentation">
      <div
        className="confirm-card settlement-review"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settlement-title"
      >
        <span className="confirm-icon settle-icon">
          <Check size={24} />
        </span>
        <h2 id="settlement-title">Review settlement</h2>
        <p>
          This closes {expenses.length} receipt
          {expenses.length === 1 ? '' : 's'} totalling {money.format(total)} for
          everyone.
        </p>
        <div className="settlement-review-list">
          {transfers.length ? (
            transfers.map((transfer) => (
              <span key={`${transfer.fromId}-${transfer.toId}`}>
                <b>{transfer.from}</b> pays {transfer.to}
                <strong>{money.format(transfer.amount)}</strong>
              </span>
            ))
          ) : (
            <span>
              <b>Everyone is even</b>
              <strong>{money.format(0)}</strong>
            </span>
          )}
        </div>
        <div className="confirm-actions">
          <button disabled={saving} onClick={onCancel}>
            Go back
          </button>
          <button
            className="settle-confirm"
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? 'Settling…' : 'Confirm settlement'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeleteConfirmation({
  expense,
  onCancel,
  onConfirm,
}: {
  expense: Expense | null;
  onCancel: () => void;
  onConfirm: (expense: Expense) => void;
}) {
  if (!expense) return null;
  return (
    <div className="confirm-backdrop" role="presentation">
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
      >
        <span className="confirm-icon">
          <Trash2 size={24} />
        </span>
        <h2 id="delete-title">Delete this receipt?</h2>
        <p>
          {expense.merchant} will be removed for everyone in the household. You
          can undo immediately after deleting.
        </p>
        <div>
          <button onClick={onCancel}>Cancel</button>
          <button className="destructive" onClick={() => onConfirm(expense)}>
            Delete Receipt
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppToast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <output className="toast" aria-live="polite">
      <Check size={16} />
      <span>{toast.message}</span>
      {toast.action && (
        <button onClick={toast.action.run}>{toast.action.label}</button>
      )}
    </output>
  );
}
