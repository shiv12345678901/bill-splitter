# Historical settlement rescan contract

This contract connects the authenticated Netlify History page to the existing
Supabase queue. The browser never calls InstaBox or the desktop Socket.IO server.

## Required database migration

Apply `supabase/migrations/20261104000000_historical_rescan_jobs.sql` only after
reviewing it against a fresh production schema export. It is ordered after the
lease, production-safeguard, pending-cycle, and rollover migrations. It adds:

- `sync_requests.job_type`, `period_id`, and `requested_by_user`;
- `receipts.evidence_only` and `needs_review`, both defaulting to `false`;
- the household allowlist and historical-rescan audit tables;
- `request_historical_rescan(text)` for authenticated household users;
- `finalize_historical_rescan(...)` for `service_role` only; and
- worker capability version 6.

The migration does not update an existing receipt, period, settlement, balance,
`owes` value, payment obligation, or verification state. It does not enable
`instabox_worker_control.writes_enabled`.

## Netlify endpoint

Add an authenticated `POST /api/history-rescan` Netlify function beside the
existing `/api/sync` function. Reuse its bearer-token validation,
`HOUSEHOLD_EMAILS`, user-scoped Supabase client, and InstaBox wake client.

Request body:

```json
{ "periodId": "period_2026-09-19" }
```

Do not accept start dates, end dates, WhatsApp boundary IDs, machine IDs, or
InstaBox credentials from the browser. Call:

```js
supabase.rpc("request_historical_rescan", { p_period_id: periodId })
```

using the signed-in user's access token and the public Supabase key. The RPC
authorizes the household member, validates the authoritative period and its
stored boundaries, and atomically creates or reuses one active job for that
period. Then call the existing server-only `wakeMachine` implementation with the
returned request ID. `INSTABOX_API_KEY` and `INSTABOX_MACHINE_ID` remain Netlify
server environment variables. A wake response means only that processing can
start; it never means the rescan is complete.

Return the same response shape as `/api/sync`:

```json
{
  "request": { "id": "uuid", "job_type": "historical_rescan", "period_id": "period_2026-09-19", "status": "pending" },
  "reused": false,
  "wake": { "status": "ready" }
}
```

The existing normal-sync store must add `.eq("job_type", "sync")` when finding
an active request. Historical requests are deduplicated by
`request_historical_rescan`; they must not be reused as normal Sync Now jobs.

## History page behavior

Show **Rescan cycle** only for a period whose UI cycle state is `SETTLED`. The
button must have an accessible name including the displayed period dates. Keep
state per period so one card can show progress without changing another card.

On activation:

1. disable that period's button and show `Queuing historical rescan…`;
2. call `/api/history-rescan` with only `periodId`;
3. poll the returned row through the existing authenticated
   `fetchSyncRequest(id)` path every five seconds;
4. display `stage_message` for `pending` and `processing`;
5. on `done`, display `result_summary`, refresh periods and that period's
   receipts, and re-enable the button; and
6. on `failed`, display `error` (falling back to `stage_message`) and offer a
   **Try again** action that calls the endpoint again.

Expected stages include `queued`, `claimed`, `validating_history`,
`discovering_history`, `scanning_history`, `saving_history`, `retry_wait`,
`complete`, and `failed`. A delayed InstaBox wake leaves the request pending and
should use the existing retryable/unreachable presentation. A page reload can
reattach by querying active `historical_rescan` requests for the selected period.

If the RPC rejects the request, show its safe server message: the period may not
be settled, its immutable boundaries may be missing or conflicting, or the user
may not be authorized. If the worker reports unavailable/incomplete WhatsApp
history, tell the user to let the linked phone finish synchronizing and retry.

Newly discovered rows always have `is_excluded=true`, `evidence_only=true`, and
`needs_review=true`. Their existence is not payment verification. Approval and
any resulting accounting change require a separate reviewed workflow.
