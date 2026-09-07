import { useRef } from 'react';
import Image from 'next/image';
import { ChevronRight, ReceiptText, Trash2 } from 'lucide-react';
import type { Expense, Member } from '@/lib/splitmate-models';
import { money } from '@/lib/splitmate-models';

type ReceiptRowProps = {
  expense: Expense;
  payer?: Member | null;
  isAdmin: boolean;
  hasFlag: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onCloseSwipe: () => void;
  onOpenSwipe: () => void;
  onDelete: () => void;
};

export function ReceiptRow({
  expense,
  payer,
  isAdmin,
  hasFlag,
  isOpen,
  onOpen,
  onCloseSwipe,
  onOpenSwipe,
  onDelete,
}: ReceiptRowProps) {
  const touchStart = useRef(0);
  return (
    <div
      className={`swipe-shell ${expense.settled || !isAdmin ? 'swipe-disabled' : ''}`}
    >
      {!expense.settled && isAdmin && (
        <button
          className="swipe-delete"
          onClick={onDelete}
          aria-label={`Delete ${expense.merchant}`}
        >
          <Trash2 size={19} />
          <span>Delete</span>
        </button>
      )}
      <button
        className={`receipt-row ${isOpen ? 'receipt-row-swiped' : ''}`}
        onTouchStart={(event) => {
          touchStart.current = event.touches[0].clientX;
        }}
        onTouchEnd={(event) => {
          if (expense.settled || !isAdmin) return;
          const distance = event.changedTouches[0].clientX - touchStart.current;
          if (distance < -45) onOpenSwipe();
          if (distance > 35) onCloseSwipe();
        }}
        onClick={() => {
          if (isOpen) onCloseSwipe();
          else onOpen();
        }}
      >
        <div className="receipt-thumb">
          {expense.image ? (
            <Image
              unoptimized
              width={72}
              height={72}
              src={expense.image}
              alt=""
            />
          ) : (
            <ReceiptText size={21} />
          )}
        </div>
        <div className="receipt-main">
          <h3>
            {expense.merchant}
            {hasFlag && <span className="flag-pill">Check</span>}
          </h3>
          <p>
            {expense.syncStatus === 'failed'
              ? 'Sync failed · retry required'
              : expense.syncStatus
                ? 'Waiting to sync'
                : `${expense.category} · ${new Date(`${expense.receiptDate}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`}
          </p>
        </div>
        <div className="receipt-amount">
          <strong>{money.format(expense.amount)}</strong>
          <span>
            {payer && <i style={{ background: payer.color }} />}
            {expense.payerName}
          </span>
        </div>
        <ChevronRight size={17} className="row-chevron" />
      </button>
    </div>
  );
}
