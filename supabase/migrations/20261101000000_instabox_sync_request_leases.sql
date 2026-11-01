-- Additive migration for the InstaBox/Muse hand-off.
-- Apply only after confirming the existing public.sync_requests table matches
-- the frontend contract. This file is intentionally not executed by the app.

alter table public.sync_requests
  add column if not exists worker_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claimed_at timestamptz;

create index if not exists sync_requests_pending_created_idx
  on public.sync_requests (created_at)
  where status = 'pending';

create index if not exists sync_requests_processing_lease_idx
  on public.sync_requests (lease_expires_at)
  where status = 'processing';

-- Claim exactly one pending or expired leased request while holding a row lock.
-- This is the only production claim path; the worker does not use a select-then-
-- update fallback because that would not provide lease recovery safely.
create or replace function public.claim_sync_request(
  p_worker_id text,
  p_requested_by text default 'netlify-app',
  p_lease_seconds integer default 900
)
returns setof public.sync_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  -- One household writer at a time also prevents two different requests from
  -- racing to refresh the same period. All consumers must use this RPC.
  perform pg_advisory_xact_lock(17498013);
  if exists (
    select 1 from public.sync_requests
    where requested_by = p_requested_by and status = 'processing'
      and (lease_expires_at > now() or lease_expires_at is null)
  ) then
    return;
  end if;
  return query
  with next_request as (
    select id
    from public.sync_requests
    where requested_by = p_requested_by
      and (
        status = 'pending'
        or (
          status = 'processing'
          and lease_expires_at is not null
          and lease_expires_at <= now()
        )
      )
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.sync_requests request
  set status = 'processing',
      worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
      attempt_count = coalesce(request.attempt_count, 0) + 1,
      claimed_at = now(),
      stage = 'claimed',
      stage_message = 'Sync request claimed by InstaBox…',
      stage_updated_at = now(),
      error = null
  from next_request
  where request.id = next_request.id
  returning request.*;
end;
$$;

revoke all on function public.claim_sync_request(text, text, integer) from public;
grant execute on function public.claim_sync_request(text, text, integer) to service_role;

-- The frontend expects private locators in the bill-evidence bucket. Service
-- role uploads bypass object RLS; authenticated read access is configured by
-- the frontend's private-access.sql policy.
insert into storage.buckets (id, name, public)
values ('bill-evidence', 'bill-evidence', false)
on conflict (id) do nothing;
