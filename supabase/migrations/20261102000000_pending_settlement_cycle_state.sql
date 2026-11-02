-- REVIEW AGAINST A FRESH PRODUCTION SCHEMA EXPORT BEFORE APPLYING.
-- This migration adds WhatsApp cycle metadata and nullable transfer-review
-- metadata only. It does not backfill or rotate periods, move receipts,
-- change settlement IDs/totals, or touch owes.
begin;

alter table public.periods
  add column if not exists whatsapp_cycle_status text,
  add column if not exists whatsapp_calculation_message jsonb,
  add column if not exists whatsapp_clearance_message jsonb,
  add column if not exists whatsapp_cycle_updated_at timestamptz;

-- Evidence presence is not payment verification. Add nullable review fields
-- only when the separately managed frontend evidence table already exists;
-- no existing row is backfilled or treated as verified.
do $$
begin
  if to_regclass('public.bank_transfer_receipts') is not null then
    alter table public.bank_transfer_receipts
      add column if not exists verification_status text,
      add column if not exists verified_at timestamptz;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.periods'::regclass
      and conname = 'periods_whatsapp_cycle_status_check'
  ) then
    alter table public.periods add constraint periods_whatsapp_cycle_status_check
      check (whatsapp_cycle_status is null or whatsapp_cycle_status in
        ('ACTIVE','PENDING_SETTLEMENT','SETTLED','UNCONFIRMED')) not valid;
  end if;
end $$;

do $$
begin
  if to_regclass('public.bank_transfer_receipts') is not null and not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bank_transfer_receipts'::regclass
      and conname = 'bank_transfer_receipts_verification_status_check'
  ) then
    alter table public.bank_transfer_receipts
      add constraint bank_transfer_receipts_verification_status_check
      check (verification_status is null or verification_status in ('pending','verified','rejected')) not valid;
  end if;
end $$;

create or replace function public.record_period_cycle_state(
  p_job_id uuid,
  p_worker_id text,
  p_period_id text,
  p_cycle_status text,
  p_calculation_message jsonb default null,
  p_clearance_message jsonb default null
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests;
  p public.periods;
begin
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id
    or j.lease_expires_at is null or j.lease_expires_at<=now() then
    raise exception 'Lost job lease';
  end if;
  select * into p from public.periods where id=p_period_id for update;
  if p.id is null or p.status<>'CURRENT' then
    raise exception 'Only an existing CURRENT period may receive cycle metadata';
  end if;
  if p_cycle_status not in ('ACTIVE','PENDING_SETTLEMENT','SETTLED') then
    raise exception 'Unsupported detected cycle status';
  end if;
  if p_cycle_status='PENDING_SETTLEMENT' and
    (p_calculation_message is null or coalesce(p_calculation_message->>'id','')=''
      or p_clearance_message is not null) then
    raise exception 'Pending settlement requires a calculation and no clearance';
  end if;
  if p_cycle_status='ACTIVE' and
    (p_calculation_message is not null or p_clearance_message is not null) then
    raise exception 'Active cycle cannot have calculation or clearance evidence';
  end if;
  if p_cycle_status='SETTLED' and
    (p_clearance_message is null or coalesce(p_clearance_message->>'id','')=''
      or p_clearance_message->>'source'<>'marker'
      or p_clearance_message->>'confidence'<>'HIGH') then
    raise exception 'Settled cycle requires an explicit clearance message';
  end if;
  update public.periods set
    whatsapp_cycle_status=p_cycle_status,
    whatsapp_calculation_message=p_calculation_message,
    whatsapp_clearance_message=p_clearance_message,
    whatsapp_cycle_updated_at=now()
  where id=p.id;
end $$;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',4,'writes_enabled',writes_enabled)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)
  to service_role;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
