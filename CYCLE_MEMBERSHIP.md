# Settlement-cycle membership contract

This feature is additive to the existing Supabase queue and WhatsApp worker. It does not change stable receipt IDs, cycle boundaries, source ownership, deletion evidence, bank verification, historical settlements, `is_excluded`, or `settlements.owes`.

## Modes and calculations

- `enabled`: receipts are visible and eligible; paid cents are credited; the member receives an exact integer-cent share obligation.
- `keep_receipts`: receipts are visible and eligible; paid cents are credited; share obligation is zero.
- `disabled`: stored receipts remain but are hidden and financially ineligible; new images from the verified WhatsApp sender are excluded before cache/media/OCR work.

`equal_share_cents` is the reviewed `round(total/enabledCount)` display value. Actual `share_cents` use floor plus a deterministic one-cent remainder assigned in `C`-locale member-name order. Therefore actual shares sum exactly to the eligible total and all `net_cents` sum to zero. No RPC in this feature writes payment obligations.

## RPC contract

All period IDs and member names are authoritative database values. Browser-supplied dates, emails and display names are not authorization inputs.

### `get_settlement_cycle_membership_permissions(p_period_id text) -> jsonb`

Available to `authenticated` and `service_role`; anonymous callers have no execute permission. For a mapped household user, permissions are derived from `auth.uid()`, the immutable UUID mapping, the administrator role, period status, and the latest settlement's obligation status. An unmapped authenticated user receives all `false` without learning membership data. These are UI hints only; every mutation repeats authorization and lifecycle checks.

```json
{
  "can_view": true,
  "can_edit": true,
  "can_review_disabled_receipts": true
}
```

All three fields are required, boolean, and never `null`. `can_edit` is true only for a verified Shiva or Arjun administrator on a `CURRENT` period whose latest settlement is `UNINITIALIZED`. Ordinary members receive `can_view: true` and both other fields false. Service-role reads receive view/review capability but never membership-edit capability.

### `get_settlement_cycle_membership(p_period_id text) -> jsonb`

Available to a UUID mapped in `household_auth_identities` and to `service_role`.

```json
{
  "period_id": "period_2026-10-31",
  "revision": 3,
  "status": "CURRENT",
  "members": [
    { "member_name": "Arjun Bhurtel", "participation_mode": "enabled" },
    { "member_name": "Arpan Bhurtel", "participation_mode": "enabled" },
    { "member_name": "Shiva Kafle", "participation_mode": "enabled" },
    { "member_name": "Swasti Adhikari", "participation_mode": "keep_receipts" }
  ],
  "permissions": {
    "can_view": true,
    "can_edit": true,
    "can_review_disabled_receipts": true
  }
}
```

Every field is required and non-null. `revision` is an integer of at least 1. `status` is the database period status. `members` always contains the four fixed identities, sorted by member name; `participation_mode` is exactly `enabled`, `keep_receipts`, or `disabled`. Unmapped users do not receive this structure: the RPC raises `UNAUTHORIZED_MEMBERSHIP_ACCESS`.

### `set_settlement_cycle_member_mode(p_period_id, p_member_name, p_participation_mode, p_expected_revision) -> jsonb`

Available only to authenticated UUID mappings for Shiva Kafle or Arjun Bhurtel with `household_role='admin'`. It serializes with worker finalization, checks optimistic revision, rejects closed cycles and reviewed obligations, recalculates receipt-derived display aggregates, increments the revision and returns exactly the same non-null structure as `get_settlement_cycle_membership`, including the new revision and current permissions.

```ts
const { data, error } = await supabase.rpc("set_settlement_cycle_member_mode", {
  p_period_id: "period_2026-10-31",
  p_member_name: "Swasti Adhikari",
  p_participation_mode: "keep_receipts",
  p_expected_revision: 3,
});
```

All four arguments are required and non-null. Do not send a JavaScript display name, email, or user ID as `p_member_name`; it must be one of the four canonical member names selected from the read response.

### `preview_settlement_cycle_membership(p_period_id text) -> jsonb`

Available to verified household identities and `service_role`. Returns `period_id`, `revision`, `total_cents`, `receipt_count`, `equal_share_cents`, and four member objects containing mode, `paid_cents`, exact `share_cents`, and `net_cents`.

```json
{
  "period_id": "period_2026-10-31",
  "revision": 4,
  "total_cents": 93931,
  "receipt_count": 26,
  "equal_share_cents": 31310,
  "members": [
    {
      "member_name": "Arjun Bhurtel",
      "participation_mode": "enabled",
      "paid_cents": 30000,
      "share_cents": 31311,
      "net_cents": -1311
    },
    {
      "member_name": "Arpan Bhurtel",
      "participation_mode": "enabled",
      "paid_cents": 26000,
      "share_cents": 31310,
      "net_cents": -5310
    },
    {
      "member_name": "Shiva Kafle",
      "participation_mode": "enabled",
      "paid_cents": 25931,
      "share_cents": 31310,
      "net_cents": -5379
    },
    {
      "member_name": "Swasti Adhikari",
      "participation_mode": "keep_receipts",
      "paid_cents": 12000,
      "share_cents": 0,
      "net_cents": 12000
    }
  ],
  "permissions": {
    "can_view": true,
    "can_edit": true,
    "can_review_disabled_receipts": true
  }
}
```

All fields are required and non-null. Cent fields are integer cents. `members` always has four entries and its `net_cents` values sum to zero. `equal_share_cents` is the reviewed rounded display value; exact `share_cents` include deterministic remainder allocation.

## Error contract

Database validation uses `raise exception '<CODE>'`. Supabase returns these as an RPC error object whose `message` contains the exact code; PostgreSQL normally reports `error.code === "P0001"`. Frontend code must classify the exact `message`, not treat every `P0001` as the same condition. Anonymous execute denial normally arrives as PostgreSQL code `42501` rather than an application code.

| Frontend category | Actual database message | Handling |
| --- | --- | --- |
| `UNAUTHORIZED` | `UNAUTHORIZED_MEMBERSHIP_ACCESS` | Clear membership data and show no membership UI. |
| `UNAUTHORIZED` | `UNAUTHORIZED_MEMBERSHIP_CHANGE` | Keep the UI read-only and refetch permissions. |
| `UNAUTHORIZED` | PostgreSQL `42501` | Treat as signed-out/forbidden; never retry as an edit. |
| `MEMBERSHIP_REVISION_REQUIRED` | `MEMBERSHIP_REVISION_REQUIRED` | Worker/deployment mismatch; browser should not call worker RPCs. |
| `STALE_MEMBERSHIP_REVISION` | `STALE_MEMBERSHIP_REVISION` | Refetch membership and preview before another edit. |
| `INVALID_MEMBER` | `INVALID_MEMBER_IDENTITY` | Reject the local selection and refetch canonical members. |
| `INVALID_MODE` | `INVALID_PARTICIPATION_MODE` | Reject the local selection; valid values are the three documented modes. |
| `CYCLE_CLOSED` | `CLOSED_CYCLE_MEMBERSHIP_CHANGE` | Disable editing for that period and refetch periods. |
| `OBLIGATIONS_FINALIZED` | `FINALIZED_OBLIGATIONS` | Disable editing; an authorized correction workflow is required. |
| `NO_ENABLED_MEMBERS` | `ZERO_ENABLED_MEMBERS` | Keep the prior configuration and require at least one enabled member. |
| configuration | `MEMBERSHIP_NOT_INITIALIZED` | Stop editing and escalate deployment/schema verification. |
| configuration | `INVALID_PERIOD` | Refetch periods; do not substitute browser dates. |
| `NETWORK_FAILURE` | No PostgreSQL message | Generated by the Supabase client/fetch layer. Preserve current UI state and offer a connectivity retry. |

An unmapped authenticated user can safely call only the permissions RPC and receives all-false permissions. Membership and preview calls still fail with `UNAUTHORIZED_MEMBERSHIP_ACCESS`. Network failures must be detected separately when no authoritative RPC response was received.

## Production UUID mapping

Use a trusted database administration connection to list Auth UUIDs, then independently verify each account with the household owner. Email may be displayed as supporting context but must never be the authorization decision or an automatic join key.

```sql
select id,email,created_at,raw_user_meta_data from auth.users order by created_at;
```

After verification, insert explicit UUID-to-member rows into `household_auth_identities`; assign `admin` only to Shiva and Arjun and record a durable change-ticket reference in `verified_by`. Never run an email-based `insert ... select`, never infer UUIDs from metadata, and never ship these mappings in frontend code. The migration intentionally inserts no production identity mappings.

### `get_effective_receipt_visibility(p_period_id text) -> setof record`

Admin/service diagnostic only. Returns `receipt_id`, `payer`, mode, `visible`, `eligible`, and `manually_excluded`; it does not return merchant, amount, evidence locator, or image data. Normal frontend receipt reads are filtered by restrictive RLS.

### `get_disabled_settlement_receipts(p_period_id text) -> setof record`

Admin/service diagnostic only. Returns disabled receipts using the existing frontend fields: `id`, `period_id`, `captured_at`, `merchant`, `amount_cents`, `payer`, `category`, `date`, `is_excluded`, and `image_url`. Its SECURITY DEFINER authorization checks the immutable auth-UUID mapping; ordinary members and unknown authenticated users are rejected. A restrictive Storage policy permits admins to resolve these private evidence locators while denying disabled receipt objects to other members.

### Next-cycle initialization

`rollover_settlement_period(..., p_membership_revision bigint)` initializes all four members as `enabled` with revision 1 in the same transaction. There is no browser-callable initialization RPC; initialization remains inside the lease-validated rollover operation.

Worker-only service-role RPC signatures are:

- `prepare_instabox_whatsapp_sources(uuid,text,text,jsonb,bigint)`
- `record_period_cycle_state(uuid,text,text,text,jsonb,jsonb,bigint)`
- `record_whatsapp_bank_evidence(uuid,text,text,jsonb,bigint)`
- `finalize_sync_request(uuid,text,text,jsonb,text[],text,text,bigint)`
- `reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text,bigint)`
- `rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[],bigint)`

The final `bigint` argument is the membership revision. Their capability-v7 signatures remain callable only by `service_role` and always raise `MEMBERSHIP_REVISION_REQUIRED`; the renamed v7 implementations are not executable by API roles.

## Frontend integration

1. Authenticate normally with Supabase Auth.
2. Read the CURRENT period, then call `get_settlement_cycle_membership_permissions`. If `can_view` is false, clear membership state and stop.
3. Call `get_settlement_cycle_membership` and `preview_settlement_cycle_membership`; require their permissions objects to match the standalone permissions response.
4. Show all four fixed identities and the three modes. Render edit controls only when `can_edit` is true. Render disabled-receipt review only when `can_review_disabled_receipts` is true.
5. Send the last returned revision with every change. On `STALE_MEMBERSHIP_REVISION`, refetch permissions, membership and preview before allowing another edit.
6. Disable changes for non-CURRENT periods and when `FINALIZED_OBLIGATIONS` is returned.
7. Refresh periods, settlement, receipts, membership and preview after success. Existing `receipts` queries automatically hide disabled-member rows through RLS; do not rewrite `is_excluded` in the browser.
8. For an administrator-only disabled-receipt review screen, call `get_disabled_settlement_receipts`; never attempt to weaken the normal receipt query or Storage policy.
9. Never use a service-role or `sb_secret_` key in the browser.

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
