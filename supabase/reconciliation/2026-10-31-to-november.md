# One-time 31 October to November reconciliation plan

This is an operator-reviewed plan, not an automatic migration. Do not execute it until a fresh production backup and schema export have been reviewed. Keep `instabox_worker_control.writes_enabled = false` throughout preflight.

## Expected facts

- Old period: `period_2026-10-10`, currently `CURRENT`, ending `2026-10-31`.
- Clearance: an explicit WhatsApp marker on 31 October 2026 in `Australia/Sydney`.
- Next cycle boundary: the same immutable WhatsApp message ID.
- New open period ID proposed by the deterministic adapter: `period_2026-10-31`.
- New placeholder settlement ID: `settlement_2026-10-31_current`.
- Receipts dated 2 November 2026 must remain outside the October period.

## Read-only preflight

1. Take a database backup and export the current schema and policies.
2. Record counts and full rows for `period_2026-10-10`, its receipts, and all settlements for that period. Preserve the exact `owes` JSON and settlement ID.
3. Confirm there is exactly one non-`CURRENT` period status value; the rollover function derives that existing convention instead of guessing `CLOSED` or another label.
4. Confirm no receipt assigned to `period_2026-10-10` has `date > '2026-10-31'`.
5. Confirm neither `period_2026-10-31` nor `settlement_2026-10-31_current` exists.
6. Run cycle detection read-only and record the clearance message ID, timestamp and Sydney date. Confirm the following open cycle uses that same message ID as its start boundary and contains the 2 November receipts.

Any mismatch stops reconciliation. Do not edit receipt dates, period IDs, settlement IDs, exclusions, manual values or `settlements.owes` to make the checks pass.

## Explicit approval

After migrations are reviewed and applied with writes still disabled, insert one approval using an administrator connection, replacing the message ID and reviewer with verified values:

```sql
insert into public.instabox_rollover_approvals(
  old_period_id, clearance_message_id, new_period_id, reviewed_by
) values (
  'period_2026-10-10', '<verified WhatsApp clearance message ID>',
  'period_2026-10-31', '<reviewer/change reference>'
);
```

This table is not writable by `anon`, `authenticated`, or the worker API role. The approval must exactly match the old period, clearance message and proposed new period.

## Controlled execution and verification

During a separately approved handover window, submit one sync request after enabling the already-reviewed worker controls. The leased rollover RPC performs the period closure, new open period creation and empty settlement initialization in one transaction. A failed check rolls back the whole operation.

Immediately verify:

- only `period_2026-10-31` is `CURRENT`, with `end_date is null`;
- `period_2026-10-10.end_date` remains `2026-10-31`;
- every old receipt row is byte-for-byte unchanged and no receipt moved periods;
- the old settlement ID, totals, balances and `owes` are unchanged;
- the new settlement has `owes is null` and `payment_obligations_status = 'UNINITIALIZED'`;
- 2 November receipts are inserted only into `period_2026-10-31` by normal idempotent finalization;
- the job reports `done` only after receipt finalization succeeds.

Do not synthesize payment obligations. A separate reviewed workflow must calculate and approve them before changing `payment_obligations_status` to `REVIEWED`.
