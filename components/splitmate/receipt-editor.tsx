'use client';

import { useRef } from 'react';
import Image from 'next/image';
import { ArrowRight, Check, RefreshCw, Trash2, WifiOff, X } from 'lucide-react';
import type {
  Draft,
  Expense,
  Member,
  ReceiptFlag,
} from '@/lib/splitmate-models';
import { localDate } from '@/lib/splitmate-models';

type ReceiptEditorProps = {
  open: boolean;
  expanded: boolean;
  saving: boolean;
  analyzing: boolean;
  online: boolean;
  isAdmin: boolean;
  userId: string;
  draft: Draft;
  detail: Expense | null;
  flags: ReceiptFlag[];
  members: Member[];
  categories: string[];
  flagReason: string;
  onExpandedChange: (expanded: boolean) => void;
  onDraftChange: (draft: Draft) => void;
  onFlagReasonChange: (reason: string) => void;
  onClose: () => void;
  onDelete: (expense: Expense) => void;
  onResolveFlag: (flag: ReceiptFlag) => void;
  onReportIncorrect: () => void;
  onRescan: () => void;
  onSave: () => void;
  onOpenDuplicate: (expenseId: string) => void;
};

export function ReceiptEditor(props: ReceiptEditorProps) {
  const {
    open,
    expanded,
    saving,
    analyzing,
    online,
    isAdmin,
    userId,
    draft,
    detail,
    flags,
    members,
    categories,
    flagReason,
    onExpandedChange,
    onDraftChange,
    onFlagReasonChange,
    onClose,
    onDelete,
    onResolveFlag,
    onReportIncorrect,
    onRescan,
    onSave,
    onOpenDuplicate,
  } = props;
  const touchStart = useRef(0);
  if (!open) return null;

  const readOnly = Boolean(detail && (detail.settled || !isAdmin));
  const alreadyReported = flags.some((flag) => flag.reported_by === userId);
  const amount = Number(draft.amount);
  const merchantError = !draft.merchant.trim()
    ? 'Enter the merchant name.'
    : draft.merchant.trim().length > 80
      ? 'Use 80 characters or fewer.'
      : '';
  const amountError = !draft.amount
    ? 'Enter the receipt total.'
    : !(amount > 0)
      ? 'Enter a total greater than zero.'
      : amount > 999999.99
        ? 'Enter a total below $1,000,000.'
        : '';
  const dateError = !draft.receiptDate
    ? 'Choose the receipt date.'
    : draft.receiptDate > localDate()
      ? 'Receipt date cannot be in the future.'
      : '';
  const canSave =
    !analyzing &&
    !saving &&
    !merchantError &&
    !amountError &&
    !dateError &&
    Boolean(draft.payerId);

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <dialog
        open
        className={`receipt-sheet ${expanded ? 'sheet-expanded' : ''}`}
        aria-labelledby="receipt-title"
      >
        <button
          className="sheet-handle"
          aria-label={
            expanded ? 'Make receipt panel smaller' : 'Expand receipt panel'
          }
          onClick={() => onExpandedChange(!expanded)}
          onTouchStart={(event) => {
            touchStart.current = event.touches[0].clientY;
          }}
          onTouchEnd={(event) => {
            const distance =
              event.changedTouches[0].clientY - touchStart.current;
            if (distance < -24) onExpandedChange(true);
            if (distance > 24) onExpandedChange(false);
          }}
        >
          <span className="grabber" />
        </button>
        <header>
          <button className="sheet-close" onClick={onClose} disabled={saving}>
            <X />
          </button>
          <div>
            <p>
              {detail
                ? 'Receipt details'
                : analyzing
                  ? 'Scanning image'
                  : 'Review details'}
            </p>
            <h2 id="receipt-title">
              {detail?.settled
                ? 'Settled receipt'
                : detail && isAdmin
                  ? 'Edit receipt'
                  : detail
                    ? 'Receipt details'
                    : 'New receipt'}
            </h2>
          </div>
          {detail && !detail.settled && isAdmin ? (
            <button className="sheet-delete" onClick={() => onDelete(detail)}>
              <Trash2 size={18} /> Delete
            </button>
          ) : (
            <span />
          )}
        </header>
        {draft.image && (
          <Image
            unoptimized
            width={1200}
            height={1600}
            className="receipt-preview"
            src={draft.image}
            alt="Selected receipt"
          />
        )}
        {analyzing && (
          <output className="scan-status" aria-live="polite">
            <span className="loader small" />
            Scanning image… You can review the fields while it finishes.
          </output>
        )}
        {!online && !detail && (
          <div className="scan-status offline-status">
            <WifiOff size={16} />
            Saved on this iPhone until you reconnect
          </div>
        )}
        {draft.lowConfidence && (
          <div className="warning-banner">
            Some details may be unclear. Please check the highlighted result.
          </div>
        )}
        {draft.duplicate && (
          <div className="warning-banner duplicate-warning">
            <span>This matches a receipt already saved.</span>
            {draft.duplicateExpenseId && (
              <button onClick={() => onOpenDuplicate(draft.duplicateExpenseId)}>
                Open existing
              </button>
            )}
          </div>
        )}
        {flags.map((flag) => (
          <div className="flag-banner" key={flag.id}>
            <div>
              <strong>Marked as incorrect</strong>
              <span>{flag.reason || 'No details were added.'}</span>
            </div>
            {isAdmin && (
              <button onClick={() => onResolveFlag(flag)}>Resolve</button>
            )}
          </div>
        ))}
        <div className="editor-fields">
          <label className="field-label">
            Merchant
            <input
              disabled={readOnly}
              className="field-input"
              value={draft.merchant}
              maxLength={81}
              aria-invalid={Boolean(merchantError)}
              onChange={(event) =>
                onDraftChange({ ...draft, merchant: event.target.value })
              }
            />
            {merchantError && (
              <span className="field-error">{merchantError}</span>
            )}
          </label>
          <div className="two-columns">
            <label className="field-label">
              Total (AUD)
              <input
                disabled={readOnly}
                className="field-input"
                inputMode="decimal"
                value={draft.amount}
                aria-invalid={Boolean(amountError)}
                onChange={(event) =>
                  onDraftChange({ ...draft, amount: event.target.value })
                }
              />
              {amountError && (
                <span className="field-error">{amountError}</span>
              )}
            </label>
            <label className="field-label">
              Category
              <select
                disabled={readOnly}
                className="field-input"
                value={draft.category}
                onChange={(event) =>
                  onDraftChange({ ...draft, category: event.target.value })
                }
              >
                {categories.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="two-columns">
            <label className="field-label">
              Receipt date
              <input
                disabled={readOnly}
                className="field-input"
                type="date"
                value={draft.receiptDate}
                max={localDate()}
                aria-invalid={Boolean(dateError)}
                onChange={(event) =>
                  onDraftChange({ ...draft, receiptDate: event.target.value })
                }
              />
              {dateError && <span className="field-error">{dateError}</span>}
            </label>
            <label className="field-label">
              Paid by
              <select
                disabled={readOnly}
                className="field-input"
                value={draft.payerId}
                onChange={(event) =>
                  onDraftChange({ ...draft, payerId: event.target.value })
                }
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field-label">
            Note <span className="optional">Optional</span>
            <textarea
              disabled={readOnly}
              className="field-input field-textarea"
              maxLength={300}
              value={draft.notes}
              onChange={(event) =>
                onDraftChange({ ...draft, notes: event.target.value })
              }
              placeholder="What was this bill for?"
            />
          </label>
          <p className="privacy-note">
            Scanning sends this image securely to the receipt-reading service.
            All household members share the expense equally.
          </p>
          {detail && !isAdmin ? (
            <div className="incorrect-report">
              <label className="field-label">
                Found a mistake?{' '}
                <span className="optional">Optional detail</span>
                <textarea
                  className="field-input field-textarea"
                  maxLength={300}
                  value={flagReason}
                  onChange={(event) => onFlagReasonChange(event.target.value)}
                  placeholder="Tell an admin what looks wrong"
                />
              </label>
              <button disabled={alreadyReported} onClick={onReportIncorrect}>
                {alreadyReported
                  ? 'Already marked for review'
                  : 'Mark as incorrect'}
              </button>
            </div>
          ) : detail?.settled ? (
            <div className="settled-note">
              <Check size={17} /> Included in a completed settlement
            </div>
          ) : (
            <>
              {online && isAdmin && (draft.file || detail?.imagePath) && (
                <button
                  className="rescan-button"
                  disabled={analyzing || saving}
                  onClick={onRescan}
                >
                  <RefreshCw size={17} /> Scan image again
                </button>
              )}
              <button
                className="primary-button"
                disabled={!canSave}
                onClick={onSave}
              >
                {saving
                  ? 'Saving…'
                  : !online && !detail
                    ? 'Save offline'
                    : detail
                      ? 'Save changes'
                      : draft.duplicate
                        ? 'Save anyway'
                        : 'Add receipt'}{' '}
                {!saving && <ArrowRight size={18} />}
              </button>
            </>
          )}
        </div>
      </dialog>
    </div>
  );
}
