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
   Use **Sync receipts** to refresh the current settlement cycle: it finds the newest "clear up to date" marker in the chat and loads every receipt from that point through today, preserving existing edits, exclusions and the period when the marker moves earlier. Loading failures are reported instead of silently showing an incomplete result.
   By default, **Collect receipts** shows every settlement cycle found in the chat and scans the one you pick; the custom date-range option still searches for the newest marker itself. PDFs and other documents are ignored — only photos are collected.
3. Review uncertain receipts in the list and detail workspace. Correct details, exclude duplicates, and undo accidental deletions. Unfinished edits survive navigation and reload. Re-scanning repairs receipts whose image previously failed to download. Filter the list by person or type (transfers, needs review, excluded), and open any receipt in a full-screen preview with next/previous navigation.
4. Review the payment plan. Whole-cent calculations distribute remaining cents in alphabetical order. Confirm a payment only after money has changed hands. "Copy calculation" produces the household's chat format with each person's receipts added up.
5. Close the completed settlement and save it to local history. Copying a summary or saving a plan does not confirm payments.

Financial edits clear payment confirmations. Closed settlements and history records are read-only. Viewing history preserves the active workspace. Start another settlement in Settings; Restore previous recovers the preceding workspace.

## Settlement cycles

The **Cycles** page runs a full scan of the group chat and maps each settlement using immutable WhatsApp boundary message IDs. Every record stores explicit start and end boundaries plus expected, processed, failed and excluded media counts. Gaps, overlaps, low-confidence calculation fallbacks and legacy records without IDs are marked **Boundary review**; they are never silently accepted, and a workspace linked to one cannot be closed. **Repair** can split, merge or correct a boundary without deleting saved receipt images. A one-time `settlement_cycles.pre-v2.backup.json` protects the pre-migration records.

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
- Timeouts, quota limits, download failures and recognition errors are classified and retried with exponential backoff. The final reconciliation card shows processed, excluded, failed and skipped counts with reasons; **Retry failed images** leaves successful images untouched.
- After the first successful load, the cached shell supports offline reload. Editing, calculations and exports work offline; scanning and local history require the server.

Recognition sends selected images to Google Gemini. The app does not send WhatsApp messages or initiate payments.

## Structure

```text
server.js                   Express startup and WhatsApp lifecycle
server/services/            Recognition, media, discovery, workers, storage, calculations
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

## Design rationale

The household and period remain visible across Overview, Receipts and Payment plan. History and configuration stay separate. Receipt review uses a list/detail pattern; errors appear beside the workflow they affect. Short transitions respect reduced-motion preferences.

References: [Apple feedback guidance](https://developer.apple.com/design/human-interface-guidelines/feedback), [Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview), and the Personal IOS project's restrained typography and progressive disclosure patterns.
