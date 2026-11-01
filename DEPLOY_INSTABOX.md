# Deploy the SplitMate worker on InstaBox

This runbook prepares the worker but does not authorize production writes. The repository defaults to dry-run, the example compatibility contract is unapproved, and the database write switch defaults to false.

## Production blockers to resolve first

Neither repository contains the canonical migrations for `sync_requests`, `periods`, `receipts`, or `settlements`, and Muse's worker/validation source is unavailable. Do not turn on writes until you have reviewed a current schema export and confirmed:

- `sync_requests.status` is text and the frontend contract is `pending → processing → done/failed` with `stage`, `stage_message`, `stage_updated_at`, `result_summary`, and `error`.
- `receipts.id` is text and uniquely stores the stable WhatsApp message ID. Existing Muse rows must already use that identity or have a reviewed mapping. The migration intentionally does not backfill or guess source IDs.
- `periods.id` and `settlements.period_id` are compatible with text period IDs; receipt dates are PostgreSQL `date`; cent amounts are integers.
- Muse's canonical household members, aliases, UTC versus Sydney receipt-date convention, zero-amount policy, equal-share rounding, and settlement primary-key type.
- The legacy Muse poller is stopped, or changed to use the same claim/lease/finalize functions. An unmodified poller can bypass these locks.
- `bill-evidence` exists as a private bucket and authenticated household users have read-only object access.
- The production dependency audit is reviewed. At the time this branch was prepared, patched overrides remove the independently fixable `basic-ftp`, `qs`, and `zod` findings, but npm still reports upstream `extract-zip` and archive/glob advisories through the current `whatsapp-web.js`/Puppeteer chain. There is no newer `whatsapp-web.js` release or fixed `extract-zip` release in the registry. Re-run `npm audit --omit=dev`; either wait for upstream fixes or record a security-owner risk decision before setting `dependencyAuditReviewed`.

Until those checks are recorded in `worker-contract.json`, the process cannot claim a job. A second database switch must also be enabled after dry-run and pairing succeed.

## 1. Prepare Supabase safely

In the Supabase dashboard, copy the database connection string from **Project Settings → Database**. On a trusted workstation with `psql`, export it without committing it:

```sh
export SUPABASE_DB_URL='postgresql://postgres.PROJECT_REF:PASSWORD@HOST:5432/postgres?sslmode=require'
mkdir -p backup
pg_dump "$SUPABASE_DB_URL" --format=custom --file="backup/pre-instabox-$(date +%Y%m%d-%H%M%S).dump"
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/inspect_schema.sql > schema-review.txt
```

Review `schema-review.txt` and the private bucket/policies. Keep the schema report and dump outside Git; both paths are ignored. Apply migrations in this exact order:

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261101000000_instabox_sync_request_leases.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261101000001_instabox_production_safeguards.sql
```

Migration 00000 only adds lease fields, claim indexes/function, and creates the private bucket if absent. Migration 00001 aborts if the supported core types or unique receipt identity cannot be proven. It adds retry fields, source identity columns/indexes, audit/control tables, restrictive frontend RLS, service-role-only functions, and transactional finalization. It does not delete, backfill, reassign, or overwrite existing receipt details. The database write switch remains off:

```sql
select public.instabox_worker_capabilities();
select singleton, writes_enabled, review_reference from public.instabox_worker_control;
```

## 2. Prepare the InstaBox VM

Connect over SSH and install Docker Engine plus the Compose plugin using InstaBox's supported image/package method. Then:

```sh
git clone https://github.com/shiv12345678901/bill-splitter.git
cd bill-splitter
git switch feature/instabox-supabase-worker
cp .env.worker.example .env.worker
cp config/worker-contract.example.json worker-contract.json
chmod 600 .env.worker worker-contract.json
docker compose build --pull
docker compose config --quiet
```

Edit `.env.worker` with the checklist below. Keep `SUPABASE_WORKER_MODE=dry-run` and leave both confirmation variables empty. Edit `worker-contract.json` only from reviewed evidence. Set every review boolean to true, supply a durable review reference, the exact members and aliases, and the confirmed date/rounding/zero-amount/settlement-ID settings. `dependencyAuditReviewed` must only be enabled after reviewing the current `npm audit --omit=dev` output and the upstream WhatsApp/Puppeteer advisories described below. This file is mounted as a read-only Docker secret and is ignored by Git.

## 3. Run dry-run

Dry-run connects only to Supabase to verify columns, the private bucket, and migration version. It does not start WhatsApp, claim jobs, upload images, or write rows:

```sh
docker compose up -d worker
docker compose logs -f --tail=100 worker
docker compose exec -T worker node scripts/worker-health.cjs --show
```

The container may be `unhealthy` in dry-run because production readiness deliberately requires live mode and WhatsApp. The JSON diagnostic should show `schemaVerified: true`, `contractApproved: true`, and no schema error before proceeding.

## 4. Pair WhatsApp privately

No HTTP/admin port is published. Pairing is available only to someone already authenticated to the VM over SSH:

```sh
docker compose stop worker
sed -i 's/^SUPABASE_WORKER_MODE=.*/SUPABASE_WORKER_MODE=pair/' .env.worker
docker compose run -d --name splitmate-pair worker
sleep 8
docker exec splitmate-pair node scripts/worker-pair.cjs
```

On the phone, open WhatsApp **Settings → Linked devices → Link a device** and scan the terminal QR. It is stored with owner-only permissions inside the private persistent volume, expires after 60 seconds for display, is removed when WhatsApp becomes ready or the process stops, and is never printed in normal logs. Confirm readiness, then stop the temporary owner:

```sh
docker logs --tail=50 splitmate-pair
docker stop -t 45 splitmate-pair
docker rm splitmate-pair
```

For a later re-pair, stop the worker before repeating this section. The session-owner lock prevents two processes from sharing the profile.

## 5. Enable live processing

First disable the old Muse poller. Verify no unleased `processing` rows remain; the claim function deliberately refuses to steal them. Then enable the independent safeguards:

```sql
update public.instabox_worker_control
set writes_enabled = true, review_reference = 'YOUR CHANGE/REVIEW REFERENCE'
where singleton;
```

Set these values in `.env.worker`:

```text
SUPABASE_WORKER_MODE=live
SUPABASE_WORKER_SCHEMA_APPROVED=I_HAVE_CONFIRMED_SUPABASE_SCHEMA
SUPABASE_WORKER_WRITE_CONFIRM=I_UNDERSTAND_SUPABASE_WORKER_WRITES
```

Start and verify:

```sh
docker compose up -d worker
docker compose ps
docker compose logs -f --tail=100 worker
docker compose exec -T worker node scripts/worker-health.cjs --ready --show
```

The healthcheck is file-based and private. It reports process liveness, readiness, WhatsApp status, schema verification, the current job/stage, last poll, and last error without exposing secrets or a network listener. Compose restarts the process after a crash or VM restart. The named volume preserves WhatsApp authentication, SQLite scan jobs, OCR cache, images, and diagnostics. On restart, expired Supabase leases are reclaimed up to the retry limit; the deterministic local job ID reuses durable scan outcomes and cached OCR.

## 6. Test end to end

Before asking a household user to sync, run repository tests on a development machine:

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

Then create one request through the existing frontend **Sync now** button. Observe:

```sh
docker compose logs -f worker
```

Verify the request reaches `done`, its progress fields are populated, the receipt locator starts with `storage://bill-evidence/`, existing edited/excluded receipts are unchanged, and the period/settlement totals match the reviewed rule. The final database RPC writes new receipts, aggregate totals, audit backup, and `done` status in one transaction. A validation or database failure rolls back that transaction and schedules a bounded retry.

## 7. Operations

Useful commands:

```sh
docker compose ps
docker compose logs --since=30m worker
docker compose exec -T worker node scripts/worker-health.cjs --show
docker compose restart worker
docker volume inspect bill-splitter_worker_state
```

Update without losing state:

```sh
git fetch origin
git switch feature/instabox-supabase-worker
git pull --ff-only
docker compose build --pull
docker compose up -d --force-recreate worker
docker compose exec -T worker node scripts/worker-health.cjs --ready --show
```

Back up the named volume before updates:

```sh
docker compose stop worker
docker run --rm -v bill-splitter_worker_state:/state -v "$PWD/backup:/backup" alpine sh -c 'tar czf /backup/worker-state.tgz -C /state .'
docker compose start worker
```

## 8. Rollback

Stop new claims immediately without deleting data:

```sh
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/disable_worker.sql
docker compose stop worker
```

Re-enable Muse only after checking it will not race an existing leased job. To roll the container back while retaining the state volume:

```sh
git log --oneline -10
git switch --detach KNOWN_GOOD_COMMIT
docker compose build
docker compose up -d worker
```

The SQL migrations are additive and should normally remain installed with writes disabled. If database restoration is required, use the pre-deployment dump during a maintenance window; restoring it replaces database state created after that backup and therefore requires an explicit data-recovery decision.

## Environment checklist

- `SUPABASE_URL`: project URL, server only.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role/secret key, server only.
- `GEMINI_API_KEY` or numbered Gemini keys.
- `SPLITMATE_WHATSAPP_GROUP_ID`: explicit target group ID; live mode will not use the code default.
- `SPLITMATE_WHATSAPP_GROUP_NAME`: display label.
- `SPLITMATE_SUPABASE_POLL_MS=5000`.
- `SPLITMATE_SYNC_LEASE_SECONDS=900`.
- `SPLITMATE_SYNC_REQUESTED_BY=netlify-app`.
- `SUPABASE_WORKER_MODE`: `dry-run`, `pair`, then `live`.
- `SUPABASE_WORKER_SCHEMA_APPROVED` and `SUPABASE_WORKER_WRITE_CONFIRM`: exact values above, only after review.
- `SESSION_DATA_PATH`, `SPLITMATE_DATA_DIR`, `SPLITMATE_RUNTIME_DIR`, and `SPLITMATE_CONTRACT_FILE`: supplied by Compose.
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` and `TZ=Australia/Sydney`: supplied by the image/Compose.
