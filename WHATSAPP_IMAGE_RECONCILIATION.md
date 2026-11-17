# WhatsApp image reconciliation

## Confirmed behavior and root cause

`whatsapp-web.js` 1.34.7 emits `message_revoke_everyone(message, revokedMessage)` when the connected page observes a delete-for-everyone type change. The second argument can be absent; `protocolMessageKey` is the supported fallback identity. `message_revoke_me` is a local removal and is not treated as authoritative delete-for-everyone evidence.

`fetchMessages()`, the WhatsApp Web collection, and older-history loading do not guarantee a complete authoritative inventory. A missing ID is therefore `UNCONFIRMED_MISSING` (or `UNVERIFIED_HISTORY` after a failed retrieval), never `CONFIRMED_DELETED`. Only an explicit revocation event or a revoked placeholder carrying the original protocol message ID creates a durable tombstone.

The 17 November incident combined two defects: the worker had no persistent revocation tracking, and JavaScript allowed a cached bank result to reach SQL even though SQL rejected its old transaction date. Invalid bank evidence then failed the whole automatic job repeatedly. The worker now validates Sydney period dates consistently and quarantines review-only bank results while valid groceries continue.

## Safety model

- SQLite tombstones are keyed by immutable WhatsApp message ID and survive restart.
- Confirmed IDs are excluded before discovery and again before OCR/cache reuse.
- Missing IDs from incomplete history are preserved for manual review.
- The Supabase migration registers only sources explicitly prepared by a currently leased InstaBox job and inserted after the migration. Registration binds each source to a hashed WhatsApp group identity and immutable cycle-start boundary. Existing Muse rows are not eligible for automatic deletion.
- The reconciliation RPC accepts only `CURRENT`/`ACTIVE` periods with `UNINITIALIZED` payment obligations, an active lease, enabled production writes, exact period/source/group/boundary identities, supported deletion evidence, and deterministic idempotency keys.
- Reconciliation accepts exactly the reviewed four members: Shiva Kafle, Arjun Bhurtel, Arpan Bhurtel and Swasti Adhikari. Three-member cycles require a separate future membership migration.
- Reconciliation requires the reviewed `shareRounding=round` rule; callers cannot select `floor`. Normal `finalize_sync_request` behavior is unchanged.
- `receipt_deleted`, `bank_evidence_deleted`, and `protected_reviewed` audit outcomes are terminal. `protected_legacy` and `not_found` retain their audit history but can be reconsidered only after the managed-source trigger records a later authoritative activation. Existing legacy rows cannot be registered retroactively.
- Grocery deletion, audit insertion and aggregate recalculation are one PostgreSQL transaction. `settlements.owes`, payment obligations and verification fields are never updated.
- Pending bank evidence may be removed. Reviewed evidence, historical rows and unregistered legacy rows are protected.
- Local image/cache cleanup happens only after the database RPC succeeds. Shared image files are retained.

## Deployment order

1. Back up PostgreSQL and the persistent InstaBox data volume.
2. Review a fresh production schema export, especially foreign keys referencing `receipts` and all settlement status values.
3. Keep `instabox_worker_control.writes_enabled=false`.
4. Apply existing migrations in timestamp order, ending with `20261117000000_whatsapp_image_reconciliation.sql`.
5. Run the verification queries below.
6. Build and deploy the worker image while writes remain disabled; verify health and WhatsApp readiness.
7. Enable writes only through the separately reviewed production handover.

## Supabase verification

```sql
select public.instabox_worker_capabilities(); -- version 7, writes_enabled unchanged

select has_function_privilege('authenticated',
  'public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)','execute'); -- false
select has_function_privilege('service_role',
  'public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)','execute'); -- true

select count(*) from public.instabox_managed_whatsapp_sources; -- initially 0
select count(*) from public.whatsapp_image_reconciliation_audit; -- initially 0

select id,status,whatsapp_cycle_status,whatsapp_start_boundary
from public.periods where id='period_2026-10-31';
select id,payment_obligations_status,total_cents,per_person_cents,receipt_count,owes
from public.settlements where id='settlement_2026-10-31_current';

select id,total_cents,per_person_cents,receipt_count from public.periods order by start_date;
select id,period_id,total_cents,per_person_cents,member_totals,receipt_count,owes
from public.settlements order by calculated_at;
```

## InstaBox verification

```bash
docker compose config
docker compose build worker
docker compose run --rm worker npm run check
docker compose run --rm worker npm test
docker compose up -d worker
docker compose ps
docker compose logs --tail=200 worker
docker compose exec worker cat /app/data/run/health.json
```

Logs report only hashed group labels and error categories. They must not contain message bodies, bank references, Supabase keys or Gemini keys.

## Rollback

1. Set `instabox_worker_control.writes_enabled=false` and stop the worker through the normal Docker command.
2. Roll back the application image to the previous tested commit.
3. Normally retain the additive tables and audit records; an older worker will fail the version-7 capability check rather than write.
4. Do not drop audit/ownership tables after any reconciliation. If database restoration is required, use the reviewed pre-deployment backup and treat it as a data-recovery operation.
5. Local tombstones are audit data. Do not delete them or the Docker volume. A false-positive tombstone requires a separately authorized correction, not cache recreation.

## Frontend contract

No frontend change is required for automatic sync. Existing `sync_requests` fields continue to report `processing`, stage `reconciling_images`, a redacted stage message, and the existing final `done`/`failed` result. A future review UI may read a server-mediated, authenticated projection containing only message ID, availability state, detected time, period, evidence source and reconciliation status. It must not expose service-role credentials or allow browser-created `CONFIRMED_DELETED` evidence.

## Remaining limitation

If the worker was disconnected when an older image was deleted and WhatsApp no longer exposes a revoked placeholder with `protocolMessageKey`, the installed library cannot prove deletion. Such a source remains `UNCONFIRMED_MISSING`; financial records are preserved and an authorized manual correction is required. The November 17 production source must not be force-marked from its cached OCR fields alone.
