# SplitMate

A local, personal desktop workspace for shared household expenses. Designed for desktop widths of 1024px and above.

## Run

```sh
npm install
npm start
```

Node.js 22.5 or newer is required. Open http://localhost:3000 and keep the terminal running. The server listens only on this computer. Existing `.env` keys, `user_config.json`, `data/`, and `.wwebjs_auth/` are reused. Configure WhatsApp and receipt recognition in Settings. Keys entered in Settings remain in server memory until restart; environment keys persist across starts.

## Workflow

1. Edit settlement details: choose the period and everyone sharing the costs, including people who have not bought anything.
2. Collect receipt images from WhatsApp or add an expense manually.
   Before recognition starts, the app shows the number of images found, how many are already saved and the maximum Gemini requests required. Confirm **Start scan** after reviewing that estimate.
   Use **Sync receipts** to refresh the current settlement cycle. A calculation changes the cycle to `PENDING_SETTLEMENT` but does not close it. Only an explicit clearance message closes the cycle; images remain in that open cycle until then. Loading failures are reported instead of silently showing an incomplete result.
   By default, **Collect receipts** shows every settlement cycle found in the chat and scans the one you pick; the custom date-range option still searches for the newest marker itself. PDFs and other documents are ignored — only photos are collected.
3. Review uncertain receipts in the list and detail workspace. Correct details, exclude duplicates, and undo accidental deletions. Unfinished edits survive navigation and reload. Re-scanning repairs receipts whose image previously failed to download. Filter the list by person or type (transfers, needs review, excluded), and open any receipt in a full-screen preview with next/previous navigation.
4. Review the payment plan. Whole-cent calculations distribute remaining cents in alphabetical order. Confirm a payment only after money has changed hands. "Copy calculation" produces the household's chat format with each person's receipts added up.
5. Close the completed settlement and save it to local history. Copying a summary or saving a plan does not confirm payments.

Financial edits clear payment confirmations. Closed settlements and history records are read-only. Viewing history preserves the active workspace. Start another settlement in Settings; Restore previous recovers the preceding workspace.

## Settlement cycles

The **Cycles** page runs a full scan of the group chat and maps each settlement using immutable WhatsApp boundary message IDs. `ACTIVE` means no calculation is present, `PENDING_SETTLEMENT` means a calculation exists but final clearance has not arrived, and `SETTLED` requires an explicit clearance message. Calculation messages are events, never boundaries. Existing calculation-inferred historical records remain preserved but migrate to `UNCONFIRMED`. Every record stores explicit boundaries plus expected, processed, failed, excluded and unclassified media counts. Gaps, overlaps and legacy records without IDs are marked **Boundary review**; they are never silently accepted.

"Scan receipts" loads a cycle's media and records its calculation. Re-scanning the same immutable cycle overwrites that cycle only when its receipts or totals changed; frequent scans do not create new cycles. Boundary repairs clear unsafe totals until the affected period is scanned again.

## Receipt library

Every image collected from WhatsApp is saved locally with its scanned data:

- `data/media_cache/` — one image file per message, deduplicated by content hash so an identical photo is never stored twice.
- `data/splitmate.sqlite` — transactional receipt, OCR cache, cycle, scan-job and settlement-history records.
- `data/backups/` — daily verified SQLite backups; the five newest backups are retained.
- `data/json-backup-pre-sqlite/` — verified copies of legacy JSON stores created during the one-time migration.

SQLite uses foreign keys, unique message/cycle constraints, full synchronous commits and write-ahead logging. Startup runs integrity and foreign-key checks. Scans reuse the library automatically: already-saved images are never downloaded again, already-read images are never sent to Gemini again, and totals stay visible in the **Receipt library** tab without a WhatsApp connection. Recognition runs up to four receipts in parallel (one per Gemini API key), with each result committed independently.

## Data and recovery

- Browser drafts: `splitmate-desktop-v2` in local storage, including previous workspace, unfinished edits and staged scan results. The earlier `splitmate-workspace-v1` format migrates on first load and remains intact.
- Operational records: `data/splitmate.sqlite`. Related changes use transactions; invalid writes roll back without partially replacing existing records.
- Recognition images: `data/media_cache/`. Image files are written through a temporary file before becoming visible.
- WhatsApp session: `.wwebjs_auth/`.
- Export/import: workspace JSON backups in Settings. They contain receipts and payment records, never API keys or authentication data. Image references require the original local media cache or connected WhatsApp session.
- Scans are durable server jobs with queued, running, partial, failed, cancelled and complete states. Each image records its own outcome. Progress survives browser disconnects, unfinished work resumes after a server restart once WhatsApp is ready, and cancellation stops new image work while safely recording work already in flight.
- **InstaBox/Supabase worker:** run `npm run worker:sync` as a separate background process. It owns the persistent WhatsApp session, polls `sync_requests` every five seconds, atomically claims leased jobs from the frontend (`requested_by = netlify-app`), reuses the WhatsApp/Gemini scan pipeline, uploads private evidence to `bill-evidence`, preserves existing receipt edits and exclusions, and updates `receipts`, `periods`, and `settlements` idempotently. The normal web server and this worker cannot share the same WhatsApp profile at the same time; the session-owner lock makes that failure explicit.
- Timeouts, quota limits, download failures and recognition errors are classified and retried with exponential backoff. The final reconciliation card shows processed, excluded, failed and skipped counts with reasons; **Retry failed images** leaves successful images untouched.
- After the first successful load, the cached shell supports offline reload. Editing, calculations and exports work offline; scanning and local history require the server.

Recognition sends selected images to Google Gemini. The app does not send WhatsApp messages or initiate payments.

## Structure

```text
server.js                   Express startup and WhatsApp lifecycle
server/services/            Recognition, media, discovery, workers, storage, calculations
server/worker-sync.cjs      Standalone InstaBox Supabase worker entrypoint
supabase/migrations/        Additive lease/RPC migration (review before applying)
server/sockets/             Groups, participants, context, scan and history handlers
public/index.html           Desktop shell
public/js/app.mjs           Navigation and rendering
public/js/store.mjs         Persistent workspace and recovery
public/js/domain.mjs        Cent-based calculation and receipt rules
public/js/connection.mjs    Connection state and staged scans
public/js/actions.mjs       Workspace and payment actions
public/js/dialogs.mjs       Collection, setup and expense forms
public/js/views/            Overview, receipt review, payment plan, history, settings
public/styles/              Layout and reusable controls
public/sw.js                Offline shell cache
tests/                      Accounting, persistence, recovery and desktop flows
```

The frontend uses native browser modules and CSS, with no framework runtime, styling CDN or required bundling step. Existing WhatsApp compatibility fallbacks remain behind smaller service modules.

## Validation

```sh
npm run check
npm run build
npm test
```

`build` validates the source; native modules are served directly. For browser checks, start `npm run preview:ui` in another terminal, then run `npm run test:ui`. Port 4173 has no WhatsApp client or production data-writing handlers. Tests use fictional data and temporary directories.

Live WhatsApp authentication and group discovery were verified. Live receipt scanning/OCR and real payment transfers were not exercised during the rebuild.

## InstaBox Supabase worker

Production Docker, private WhatsApp pairing, migration, operations, update and rollback commands are in [DEPLOY_INSTABOX.md](DEPLOY_INSTABOX.md). The pending-settlement metadata migration is required before this version can enter live mode; it leaves the write switch off and never rotates periods or changes settlement obligations.

The worker is deliberately locked to `dry-run` by default:

```sh
npm run worker:sync
```

In dry-run it verifies the configured Supabase REST schema and performs no job claim, database write, storage upload, WhatsApp login, or Gemini request. For production, review all three ordered migrations under `supabase/migrations/`, then use a server-only `.env` with:

```text
SUPABASE_WORKER_MODE=live
SUPABASE_WORKER_SCHEMA_APPROVED=I_HAVE_CONFIRMED_SUPABASE_SCHEMA
SUPABASE_WORKER_WRITE_CONFIRM=I_UNDERSTAND_SUPABASE_WORKER_WRITES
```

The worker also requires `SUPABASE_URL`, preferably a modern `SUPABASE_SECRET_KEY` (`sb_secret_...`) or the legacy `SUPABASE_SERVICE_ROLE_KEY` fallback, at least one `GEMINI_API_KEY` value, and a WhatsApp group ID (or the existing `user_config.json` default). When both Supabase credentials exist, the modern secret key wins. `SPLITMATE_SUPABASE_POLL_MS` defaults to 5000 and `SPLITMATE_SYNC_LEASE_SECONDS` defaults to 900. Never put either server key, the WhatsApp session directory, local SQLite database, image cache, or `user_config.json` in Git.

Before enabling live mode, confirm the actual database types and policies rather than relying on names alone:

- No canonical `periods`/`receipts`/`settlements`/`sync_requests` table migration was present in either repository during this implementation. The frontend repository supplies the read/write field contract and only includes the bank-transfer and private-access SQL files, so the worker refuses live writes until the runtime schema check and the two explicit confirmations pass.
- `sync_requests` contains the frontend fields `requested_by`, `status`, `stage`, `stage_message`, `stage_updated_at`, `result_summary`, `error`, `created_at`, plus the additive lease fields from the migration. The `claim_sync_request` RPC must be available to `service_role`.
- `periods`, `receipts`, and `settlements` expose the fields listed in `REQUIRED_COLUMNS` in `server/services/supabase-worker.cjs`, with `receipts.amount_cents` and settlement totals represented as integer AUD cents. The worker does not overwrite an existing receipt row; it only fills a missing private image locator.
- The private `bill-evidence` Storage bucket exists and the frontend's authenticated read policy is in place. Stored locators use `storage://bill-evidence/<period>/<message-id>.<extension>`.
- The available SplitMate OCR rules use five categories and exclude transfer proofs. Muse's own worker and additional validation rules were not available in these repositories. Confirm its payer membership, period/date/timezone rules, zero-amount treatment and equal-share rounding before production. `createSupabaseWorker({ adapter })` explicitly accepts `validateReceipt(expense, periodId, aliases)` and `settlementForReceipts(rows, members)` replacements for a reviewed mapping; the bundled adapter preserves zero-amount review records and normalizes unknown categories to Other.
- `SUPABASE_SETTLEMENT_ID_MODE=existing-only` is the default. First insertion requires confirming `settlements.id` and selecting `text` or `uuid`; both create deterministic IDs so an ambiguous network response cannot create another settlement on retry. Confirm `receipts.id` accepts stable WhatsApp message IDs and has a unique constraint; otherwise provide a reviewed ID adapter and source-ID mapping migration first.

The worker claims one request at a time, renews its lease while scanning, retries an expired `processing` lease through the database RPC, and reports `pending`, `processing`, `done`, or `failed` together with `stage`, `stage_message`, `stage_updated_at`, `result_summary`, and `error`. The SQL file is additive and was not applied to any live project during development.

All cooperating consumers must use `claim_sync_request`. Disable the legacy Muse poller during handover unless it adopts the same lease protocol: a new RPC cannot prevent an unmodified old poller from writing. Unleased `processing` jobs are left alone for operator review. Periods must already exist; this worker does not invent, close, extend or rotate Supabase periods. It refuses a non-`CURRENT` target and refuses an ambiguous WhatsApp-cycle mapping. WhatsApp day boundaries are explicitly evaluated in `Australia/Sydney`; the reviewed contract must still confirm the database receipt-date convention.

The worker records only factual WhatsApp cycle metadata on the existing `CURRENT` period. A fixed Supabase `end_date` that ends before a still-open WhatsApp cycle is a deliberate production blocker: receipts outside that date fail validation instead of being moved into a closed period. Period rotation remains a separately reviewed Muse/operator action. The worker never guesses payment-step mappings or writes `bank_transfer_receipts`; recognized proofs are published only as excluded receipt evidence (when the reviewed zero-amount rule permits it), retain their source message IDs/private locators, and remain unverified until a separate review explicitly verifies a payment.

Receipt inserts ignore existing IDs, evidence uploads never overwrite objects, and missing image locators are filled only while still null. Pagination reads all saved period receipts for recomputation. Period and settlement refreshes are separate retryable requests, not one database transaction; after an interrupted refresh the next sync repairs totals from saved receipts. Database-side fencing/transactional finalization must be reviewed with the actual schema if independent writers will remain active. Failed image work and rejected records mark the request failed while retaining successful receipts; a new frontend sync reuses the local image/OCR cache.

On the InstaBox VM, install Node 22.5+ and Chrome's Linux runtime dependencies, check out this branch, run `npm ci`, store `.env` outside Git, and keep `SESSION_DATA_PATH` (use an absolute path) and `SPLITMATE_DATA_DIR` on persistent disk. Run `npm run worker:sync` first in dry-run, then enable live mode after the above confirmations and link WhatsApp using the terminal QR. Use a process supervisor to restart the worker after VM reboot. Only one process may own a profile; for concurrent local UI access use `SPLITMATE_NO_WHATSAPP=1 npm start` with the worker owning WhatsApp. Dependency installation may require approving Puppeteer's install script or provisioning Chrome separately.

## Design rationale

The household and period remain visible across Overview, Receipts and Payment plan. History and configuration stay separate. Receipt review uses a list/detail pattern; errors appear beside the workflow they affect. Short transitions respect reduced-motion preferences.

References: [Apple feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback), [Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview), and the Personal IOS project's restrained typography and progressive disclosure patterns.
