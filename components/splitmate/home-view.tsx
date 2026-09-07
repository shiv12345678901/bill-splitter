import type { ReactNode } from 'react';
import {
  Check,
  ImagePlus,
  Share2,
  ShieldCheck,
  WifiOff,
  ChevronRight,
  ReceiptText,
} from 'lucide-react';
import type { Expense, Member } from '@/lib/splitmate-models';
import type { Transfer } from '@/lib/settlements';
import { money } from '@/lib/splitmate-models';
import { Avatar } from './avatar';

type HomeViewProps = {
  cycleLabel: string;
  total: number;
  share: number;
  members: Member[];
  expenses: Expense[];
  activeExpenses: Expense[];
  online: boolean;
  transfers: Transfer[];
  isAdmin: boolean;
  saving: boolean;
  onUpload: () => void;
  onRetrySync: () => void;
  onShowReceipts: () => void;
  onShare: () => void;
  onReviewSettlement: () => void;
  renderReceipt: (expense: Expense) => ReactNode;
};

export function HomeView(props: HomeViewProps) {
  const {
    cycleLabel,
    total,
    share,
    members,
    expenses,
    activeExpenses,
    online,
    transfers,
    isAdmin,
    saving,
    onUpload,
    onRetrySync,
    onShowReceipts,
    onShare,
    onReviewSettlement,
    renderReceipt,
  } = props;
  return (
    <div className="content-grid">
      <section className="stack">
        <div className="balance-card">
          <p>{cycleLabel}</p>
          <strong>{money.format(total)}</strong>
          <span>
            {money.format(share)} each · {activeExpenses.length} receipts
          </span>
          <div className="member-stack">
            {members.map((member) => (
              <Avatar key={member.id} member={member} small />
            ))}
          </div>
        </div>
        <div className="source-actions">
          <button className="capture-button" onClick={onUpload}>
            <ImagePlus size={22} />
            <span>
              <strong>Choose bill from Photos</strong>
              <small>
                {online
                  ? 'Scanning image fills in the details'
                  : 'Save now and sync when online'}
              </small>
            </span>
            <ChevronRight size={20} />
          </button>
        </div>
        {expenses.some((expense) => expense.syncStatus === 'failed') && (
          <div className="attention-card">
            <WifiOff size={19} />
            <div>
              <strong>Receipt sync needs attention</strong>
              <span>Your bill is safe on this iPhone.</span>
            </div>
            <button disabled={!online} onClick={onRetrySync}>
              Retry
            </button>
          </div>
        )}
        <section>
          <div className="section-heading">
            <h2>Recent receipts</h2>
            <button onClick={onShowReceipts}>See all</button>
          </div>
          <div className="list-card">
            {activeExpenses.length ? (
              activeExpenses.slice(0, 3).map(renderReceipt)
            ) : (
              <div className="empty-state">
                <ReceiptText />
                <strong>No bills this cycle</strong>
                <p>Choose one from Photos to get started.</p>
              </div>
            )}
          </div>
        </section>
      </section>
      <section className="stack">
        <div className="section-heading">
          <h2>Settle up</h2>
          <span>{members.length} people</span>
        </div>
        <div className="settlement-card">
          {!activeExpenses.length ? (
            <div className="empty-state compact">
              <Check />
              <strong>Everything is settled</strong>
            </div>
          ) : transfers.length ? (
            transfers.map((transfer) => (
              <div
                className="transfer-row"
                key={`${transfer.fromId}-${transfer.toId}`}
              >
                <span>
                  <strong>{transfer.from}</strong> pays {transfer.to}
                </span>
                <b>{money.format(transfer.amount)}</b>
              </div>
            ))
          ) : (
            <div className="empty-state compact">
              <Check />
              <strong>Everyone is even</strong>
            </div>
          )}
          {isAdmin ? (
            <div className="settlement-actions">
              <button
                disabled={!activeExpenses.length || saving}
                onClick={onShare}
              >
                <Share2 size={18} /> Share
              </button>
              <button
                disabled={!activeExpenses.length || saving}
                onClick={onReviewSettlement}
              >
                <Check size={18} /> Review settlement
              </button>
            </div>
          ) : (
            <p className="permission-note">
              <ShieldCheck size={16} /> Only admins can share or settle this
              cycle.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
