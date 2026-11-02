-- REVIEW AGAINST A FRESH PRODUCTION SCHEMA EXPORT BEFORE APPLYING.
-- This migration enables guarded future rollovers only. It does not reconcile
-- or rewrite the known 31 October 2026 production state automatically.
begin;

alter table public.periods alter column end_date drop not null;
alter table public.periods
  add column if not exists whatsapp_start_boundary jsonb;
alter table public.settlements
  add column if not exists payment_obligations_status text;
alter table public.settlements alter column owes drop not null;
alter table public.instabox_worker_control
  add column if not exists automatic_rollover_after timestamptz not null default now();

create table if not exists public.instabox_rollover_approvals (
  old_period_id text primary key,
  clearance_message_id text not null,
  new_period_id text not null,
  reviewed_by text not null,
  reviewed_at timestamptz not null default now()
);
alter table public.instabox_rollover_approvals enable row level security;
revoke all on public.instabox_rollover_approvals from public,anon,authenticated;
grant select on public.instabox_rollover_approvals to service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.settlements'::regclass
      and conname='settlements_payment_obligations_status_check'
  ) then
    alter table public.settlements
      add constraint settlements_payment_obligations_status_check
      check (payment_obligations_status is null or payment_obligations_status in
        ('UNINITIALIZED','REVIEWED')) not valid;
  end if;
end $$;

create or replace function public.rollover_settlement_period(
  p_job_id uuid,
  p_worker_id text,
  p_old_period_id text,
  p_old_end_date date,
  p_clearance_message jsonb,
  p_new_period_id text,
  p_new_settlement_id text,
  p_new_start_date date,
  p_start_boundary jsonb,
  p_new_cycle_status text,
  p_calculation_message jsonb,
  p_members text[]
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests;
  old_period public.periods;
  new_period public.periods;
  closed_status text;
  closed_status_count integer;
  zero_member_totals jsonb;
begin
  perform pg_advisory_xact_lock(17498013);
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id
    or j.lease_expires_at is null or j.lease_expires_at<=now() then
    raise exception 'Lost job lease';
  end if;
  if coalesce(array_length(p_members,1),0)<>4 or
    (select count(distinct member_name) from unnest(p_members) member_name)<>4 then
    raise exception 'Four reviewed household members are required';
  end if;
  if p_new_period_id is distinct from 'period_'||p_new_start_date::text or
    p_new_settlement_id is distinct from 'settlement_'||p_new_start_date::text||'_current' then
    raise exception 'Unexpected deterministic period or settlement ID';
  end if;
  if p_old_end_date is null then
    raise exception 'The old period requires a verified end date';
  end if;
  if p_clearance_message is null or coalesce(p_clearance_message->>'id','')='' or
    p_clearance_message->>'source'<>'marker' or p_clearance_message->>'confidence'<>'HIGH' or
    coalesce(p_clearance_message->>'timestamp','')!~'^[0-9]+$' then
    raise exception 'A verified explicit clearance marker is required';
  end if;
  if (to_timestamp((p_clearance_message->>'timestamp')::double precision)
      at time zone 'Australia/Sydney')::date is distinct from p_old_end_date then
    raise exception 'Clearance timestamp does not match the stored period end date';
  end if;
  if p_start_boundary is null or p_start_boundary->>'id' is distinct from p_clearance_message->>'id' or
    p_start_boundary->>'source'<>'marker' or p_start_boundary->>'confidence'<>'HIGH' then
    raise exception 'The next cycle must start at the clearance marker';
  end if;
  if p_new_start_date is distinct from
    (to_timestamp((p_clearance_message->>'timestamp')::double precision + 1)
      at time zone 'Australia/Sydney')::date then
    raise exception 'The new cycle start date does not match the clearance boundary instant';
  end if;
  if to_timestamp((p_clearance_message->>'timestamp')::double precision) <
      (select automatic_rollover_after from public.instabox_worker_control where singleton)
    and not exists(
      select 1 from public.instabox_rollover_approvals
      where old_period_id=p_old_period_id
        and clearance_message_id=p_clearance_message->>'id'
        and new_period_id=p_new_period_id
    ) then
    raise exception 'Historical rollover requires an explicitly reviewed approval';
  end if;
  if p_new_cycle_status not in ('ACTIVE','PENDING_SETTLEMENT') or
    (p_new_cycle_status='ACTIVE' and p_calculation_message is not null) or
    (p_new_cycle_status='PENDING_SETTLEMENT' and
      (p_calculation_message is null or coalesce(p_calculation_message->>'id','')='')) then
    raise exception 'Invalid next-cycle state';
  end if;

  select count(distinct status),min(status) into closed_status_count,closed_status
    from public.periods where status<>'CURRENT';
  if closed_status_count<>1 then
    raise exception 'Cannot infer one verified historical period status convention';
  end if;

  select * into old_period from public.periods where id=p_old_period_id for update;
  select * into new_period from public.periods where id=p_new_period_id for update;
  if old_period.id is null then raise exception 'Existing period not found'; end if;

  -- A retry after a committed-but-unacknowledged rollover is harmless.
  if old_period.status=closed_status and new_period.id is not null and
    new_period.status='CURRENT' and new_period.start_date=p_new_start_date and
    new_period.whatsapp_start_boundary->>'id'=p_start_boundary->>'id' then
    return jsonb_build_object('period_id',new_period.id,'replayed',true);
  end if;
  if old_period.status<>'CURRENT' then raise exception 'Expected old CURRENT period'; end if;
  if old_period.end_date is distinct from p_old_end_date then
    raise exception 'Stored period end date does not match clearance date';
  end if;
  if old_period.whatsapp_cycle_status not in ('ACTIVE','PENDING_SETTLEMENT','SETTLED') and
    old_period.whatsapp_cycle_status is not null then
    raise exception 'Stored cycle state conflicts with verified closure';
  end if;
  if exists(select 1 from public.periods where status='CURRENT' and id<>old_period.id) then
    raise exception 'Multiple CURRENT periods require manual reconciliation';
  end if;
  if new_period.id is not null then raise exception 'Target period ID already exists'; end if;
  if exists(select 1 from public.receipts where period_id=old_period.id and date>p_old_end_date) then
    raise exception 'The old period already contains receipts after clearance';
  end if;
  if not exists(select 1 from public.settlements where period_id=old_period.id) then
    raise exception 'The old period has no settlement to preserve';
  end if;
  if exists(select 1 from public.settlements where id=p_new_settlement_id or period_id=p_new_period_id) then
    raise exception 'Target settlement already exists';
  end if;

  select jsonb_object_agg(member_name,0) into zero_member_totals
    from unnest(p_members) member_name;

  update public.periods set
    status=closed_status,
    whatsapp_cycle_status='SETTLED',
    whatsapp_clearance_message=p_clearance_message,
    whatsapp_cycle_updated_at=now()
  where id=old_period.id;

  insert into public.periods(
    id,start_date,end_date,status,total_cents,per_person_cents,receipt_count,
    whatsapp_cycle_status,whatsapp_calculation_message,
    whatsapp_clearance_message,whatsapp_cycle_updated_at,whatsapp_start_boundary
  ) values(
    p_new_period_id,p_new_start_date,null,'CURRENT',0,0,0,
    p_new_cycle_status,p_calculation_message,null,now(),p_start_boundary
  );

  -- This placeholder contains no transfers and no payment completion state.
  -- finalize_sync_request may refresh receipt-derived totals but deliberately
  -- leaves owes null until a separately reviewed obligations workflow runs.
  insert into public.settlements(
    id,period_id,total_cents,per_person_cents,member_totals,receipt_count,
    calculated_at,owes,payment_obligations_status
  ) values(
    p_new_settlement_id,p_new_period_id,0,0,zero_member_totals,0,
    now(),null,'UNINITIALIZED'
  );

  return jsonb_build_object('period_id',p_new_period_id,'replayed',false);
end $$;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',5,'writes_enabled',writes_enabled)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.rollover_settlement_period(
  uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[]
) from public,anon,authenticated;
grant execute on function public.rollover_settlement_period(
  uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[]
) to service_role;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
