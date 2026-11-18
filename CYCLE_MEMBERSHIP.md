# Settlement-cycle membership contract

This feature is additive to the existing Supabase queue and WhatsApp worker. It does not change stable receipt IDs, cycle boundaries, source ownership, deletion evidence, bank verification, historical settlements, `is_excluded`, or `settlements.owes`.

## Modes and calculations

- `enabled`: receipts are visible and eligible; paid cents are credited; the member receives an exact integer-cent share obligation.
- `keep_receipts`: receipts are visible and eligible; paid cents are credited; share obligation is zero.
- `disabled`: stored receipts remain but are hidden and financially ineligible; new images from the verified WhatsApp sender are excluded before cache/media/OCR work.

`equal_share_cents` is the reviewed `round(total/enabledCount)` display value. Actual `share_cents` use floor plus a deterministic one-cent remainder assigned in `C`-locale member-name order. Therefore actual shares sum exactly to the eligible total and all `net_cents` sum to zero. No RPC in this feature writes payment obligations.

## RPC contract

All period IDs and member names are authoritative database values. Browser-supplied dates, emails and display names are not authorization inputs.

### `get_settlement_cycle_membership(p_period_id text) -> jsonb`

Available to a UUID mapped in `household_auth_identities` and to `service_role`.

```json
{
  "period_id": "period_2026-10-31",
  "revision": 3,
  "status": "CURRENT",
  "members": [
    { "member_name": "Shiva Kafle", "participation_mode": "enabled" }
  ]
}
```

### `set_settlement_cycle_member_mode(p_period_id, p_member_name, p_participation_mode, p_expected_revision) -> jsonb`

Available only to authenticated UUID mappings for Shiva Kafle or Arjun Bhurtel with `household_role='admin'`. It serializes with worker finalization, checks optimistic revision, rejects closed cycles and reviewed obligations, recalculates receipt-derived display aggregates, increments the revision and returns the membership payload.

Structured error messages include `UNAUTHORIZED_MEMBERSHIP_CHANGE`, `CLOSED_CYCLE_MEMBERSHIP_CHANGE`, `INVALID_MEMBER_IDENTITY`, `INVALID_PARTICIPATION_MODE`, `ZERO_ENABLED_MEMBERS`, `STALE_MEMBERSHIP_REVISION`, `FINALIZED_OBLIGATIONS`, and `MEMBERSHIP_NOT_INITIALIZED`.

### `preview_settlement_cycle_membership(p_period_id text) -> jsonb`

Available to verified household identities and `service_role`. Returns `period_id`, `revision`, `total_cents`, `receipt_count`, `equal_share_cents`, and four member objects containing mode, `paid_cents`, exact `share_cents`, and `net_cents`.

### `get_effective_receipt_visibility(p_period_id text) -> setof record`

Admin/service diagnostic only. Returns `receipt_id`, `payer`, mode, `visible`, `eligible`, and `manually_excluded`; it does not return merchant, amount, evidence locator, or image data. Normal frontend receipt reads are filtered by restrictive RLS.

### Next-cycle initialization

`rollover_settlement_period(..., p_membership_revision bigint)` initializes all four members as `enabled` with revision 1 in the same transaction. There is no browser-callable initialization RPC; initialization remains inside the lease-validated rollover operation.

## Frontend integration

1. Authenticate normally with Supabase Auth.
2. Read the CURRENT period, then call `get_settlement_cycle_membership` and `preview_settlement_cycle_membership`.
3. Show all four fixed identities and the three modes. Only show controls when the signed-in UUID has admin authority; treat `UNAUTHORIZED_MEMBERSHIP_CHANGE` as read-only.
4. Send the last returned revision with every change. On `STALE_MEMBERSHIP_REVISION`, refetch membership and preview before allowing another edit.
5. Disable changes for non-CURRENT periods and when `FINALIZED_OBLIGATIONS` is returned.
6. Refresh periods, settlement, receipts, membership and preview after success. Existing `receipts` queries automatically hide disabled-member rows through RLS; do not rewrite `is_excluded` in the browser.
7. Never use a service-role or `sb_secret_` key in the browser.

## Deployment and rollback

Deployment order: back up and inspect schema; pause new queue creation; wait for leases to finish; apply migrations through `20261118000000`; verify four CURRENT membership rows and revision 1; manually seed four reviewed auth UUID mappings; run SQL tests/queries; deploy capability-v8 worker; verify dry-run/health; resume queue creation; then release frontend controls.

Rollback is forward-only because production migrations are additive. Pause new queue creation and the worker, restore the capability-v7 application only together with a reviewed database follow-up that keeps old RPC signatures fenced, or restore the pre-migration database backup. Do not drop membership tables while the v8 worker or frontend is active. Membership rows can be reset only through the authorized RPC while obligations are `UNINITIALIZED`; never edit historical rows to simulate rollback.

## Production readiness checks

- Four reviewed auth UUID mappings exist; exactly Shiva and Arjun have `admin`.
- CURRENT period has four membership rows and one revision row; historical rows were not changed.
- Capability reports version 8 and `writes_enabled` retains its previous value.
- Receipt RLS hides disabled payers and re-enabling restores visibility without changing `is_excluded`.
- Preview nets sum to zero in integer cents and `equal_share_cents` uses round.
- `settlements.owes`, `payment_obligations_status`, bank verification, source registry, tombstones and audits are unchanged.
- A scan crossing a membership revision fails with `STALE_MEMBERSHIP_REVISION` before source preparation/finalization and retries under a revision-specific local job ID.
