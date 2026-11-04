-- REVIEW AGAINST A FRESH PRODUCTION SCHEMA EXPORT BEFORE APPLYING.
-- Additive historical evidence queue support. This migration never changes an
-- existing receipt, period, settlement, owes value, payment obligation, or
-- verification state. Worker writes remain controlled by writes_enabled.
begin;

alter table public.sync_requests
  add column if not exists job_type text not null default 'sync',
  add column if not exists period_id text,
  add column if not exists requested_by_user uuid;
alter table public.receipts
  add column if not exists evidence_only boolean not null default false,
  add column if not exists needs_review boolean not null default false;

do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.sync_requests'::regclass and conname='sync_requests_job_type_check') then
    alter table public.sync_requests add constraint sync_requests_job_type_check
      check(job_type in ('sync','historical_rescan')) not valid;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.sync_requests'::regclass and conname='sync_requests_historical_period_check') then
    alter table public.sync_requests add constraint sync_requests_historical_period_check
      check((job_type='sync') or (period_id is not null and requested_by_user is not null)) not valid;
  end if;
end $$;

create unique index if not exists sync_requests_one_active_historical_period
  on public.sync_requests(period_id)
  where job_type='historical_rescan' and status in ('pending','processing');

create table if not exists public.instabox_household_allowlist (
  email text primary key check(email=lower(email)),
  enabled boolean not null default true
);
insert into public.instabox_household_allowlist(email) values
  ('shiva@billforus.netlify.app'),
  ('arpan@billforus.netlify.app'),
  ('arjun@billforus.netlify.app'),
  ('swasti@billforus.netlify.app')
on conflict(email) do nothing;
alter table public.instabox_household_allowlist enable row level security;
revoke all on public.instabox_household_allowlist from public,anon,authenticated;
grant select on public.instabox_household_allowlist to service_role;

create table if not exists public.instabox_historical_rescan_audit (
  job_id uuid primary key references public.sync_requests(id),
  period_id text not null,
  start_boundary_id text not null,
  end_boundary_id text not null,
  inserted_receipt_ids text[] not null default '{}',
  completed_at timestamptz not null default now()
);
alter table public.instabox_historical_rescan_audit enable row level security;
revoke all on public.instabox_historical_rescan_audit from public,anon,authenticated;
grant select on public.instabox_historical_rescan_audit to service_role;

create or replace function public.is_instabox_household_member()
returns boolean language sql stable security definer set search_path=public,auth,pg_temp as $$
  select auth.uid() is not null and exists(
    select 1 from public.instabox_household_allowlist
    where email=lower(coalesce(auth.jwt()->>'email','')) and enabled
  );
$$;

create or replace function public.request_historical_rescan(p_period_id text)
returns setof public.sync_requests
language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare
  requester uuid:=auth.uid();
  requester_email text:=lower(coalesce(auth.jwt()->>'email',''));
  target public.periods;
  created public.sync_requests;
  start_ts bigint;
  end_ts bigint;
begin
  if requester is null or requester_email='' or not exists(
    select 1 from public.instabox_household_allowlist
    where email=requester_email and enabled
  ) then raise exception 'Household authorization required' using errcode='42501'; end if;
  if nullif(btrim(p_period_id),'') is null then raise exception 'Period ID required'; end if;

  perform pg_advisory_xact_lock(17498014);
  select * into target from public.periods where id::text=p_period_id for update;
  if target.id is null or target.status='CURRENT' or target.whatsapp_cycle_status is distinct from 'SETTLED' then
    raise exception 'Only an authoritative SETTLED period can be rescanned';
  end if;
  if target.start_date is null or target.end_date is null or
     coalesce(target.whatsapp_start_boundary->>'id','')='' or
     coalesce(target.whatsapp_clearance_message->>'id','')='' or
     coalesce(target.whatsapp_start_boundary->>'timestamp','')!~'^[0-9]+$' or
     coalesce(target.whatsapp_clearance_message->>'timestamp','')!~'^[0-9]+$' or
     target.whatsapp_start_boundary->>'confidence'<>'HIGH' or
     target.whatsapp_start_boundary->>'source' not in ('configured','marker') or
     target.whatsapp_clearance_message->>'source'<>'marker' or
     target.whatsapp_clearance_message->>'confidence'<>'HIGH' then
    raise exception 'Settled period is missing verified immutable boundaries';
  end if;
  start_ts:=(target.whatsapp_start_boundary->>'timestamp')::bigint;
  end_ts:=(target.whatsapp_clearance_message->>'timestamp')::bigint;
  if start_ts<=0 or end_ts<=start_ts or
     (to_timestamp(start_ts+1) at time zone 'Australia/Sydney')::date is distinct from target.start_date or
     (to_timestamp(end_ts) at time zone 'Australia/Sydney')::date is distinct from target.end_date then
    raise exception 'Stored period dates conflict with immutable boundaries';
  end if;
  if not exists(select 1 from public.settlements where period_id::text=target.id::text) then
    raise exception 'Historical settlement record is missing';
  end if;
  if exists(
    select 1 from public.periods other where other.id<>target.id and (
      other.whatsapp_start_boundary->>'id'=target.whatsapp_start_boundary->>'id' or
      other.whatsapp_clearance_message->>'id'=target.whatsapp_clearance_message->>'id'
    )
  ) then raise exception 'Historical boundaries conflict with another period'; end if;
  if exists(
    select 1 from public.periods other
    where other.id<>target.id and other.whatsapp_cycle_status='SETTLED'
      and coalesce(other.whatsapp_start_boundary->>'timestamp','')~'^[0-9]+$'
      and coalesce(other.whatsapp_clearance_message->>'timestamp','')~'^[0-9]+$'
      and int8range(start_ts+1,end_ts,'[]') && int8range(
        (other.whatsapp_start_boundary->>'timestamp')::bigint+1,
        (other.whatsapp_clearance_message->>'timestamp')::bigint,'[]')
  ) then raise exception 'Historical period overlaps another settled cycle'; end if;

  select * into created from public.sync_requests
    where job_type='historical_rescan' and period_id=p_period_id
      and status in ('pending','processing') order by created_at desc limit 1;
  if created.id is null then
    begin
      insert into public.sync_requests(
        id,requested_by,status,stage,stage_message,stage_updated_at,
        job_type,period_id,requested_by_user
      ) values(
        gen_random_uuid(),'netlify-app','pending','queued',
        'Historical settlement rescan queued',now(),
        'historical_rescan',p_period_id,requester
      ) returning * into created;
    exception when unique_violation then
      select * into created from public.sync_requests
        where job_type='historical_rescan' and period_id=p_period_id
          and status in ('pending','processing') order by created_at desc limit 1;
    end;
  end if;
  return next created;
end $$;

create or replace function public.finalize_historical_rescan(
  p_job_id uuid,
  p_worker_id text,
  p_period_id text,
  p_start_boundary_id text,
  p_end_boundary_id text,
  p_receipts jsonb,
  p_members text[]
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests;
  p public.periods;
  r public.receipts;
  item jsonb;
  affected integer;
  inserted integer:=0;
  inserted_ids text[]:='{}';
  summary text;
begin
  perform pg_advisory_xact_lock(17498013);
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.status='done' and exists(select 1 from public.instabox_historical_rescan_audit where job_id=p_job_id) then
    return jsonb_build_object('result_summary',j.result_summary,'replayed',true);
  end if;
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  if j.id is null or j.job_type<>'historical_rescan' or j.period_id is distinct from p_period_id or
     j.status<>'processing' or j.worker_id is distinct from p_worker_id or
     j.lease_expires_at is null or j.lease_expires_at<=now() then raise exception 'Lost historical job lease'; end if;
  if coalesce(array_length(p_members,1),0)<>4 or
     (select count(distinct member_name) from unnest(p_members) member_name)<>4 then
    raise exception 'Four reviewed household members are required';
  end if;
  select * into p from public.periods where id::text=p_period_id for share;
  if p.id is null or p.status='CURRENT' or p.whatsapp_cycle_status is distinct from 'SETTLED' or
     p.whatsapp_start_boundary->>'id' is distinct from p_start_boundary_id or
     p.whatsapp_clearance_message->>'id' is distinct from p_end_boundary_id then
    raise exception 'Historical period boundaries changed before finalization';
  end if;
  if jsonb_typeof(p_receipts)<>'array' then raise exception 'Receipt array required'; end if;

  for item in select value from jsonb_array_elements(p_receipts) loop
    r:=jsonb_populate_record(null::public.receipts,item);
    if nullif(r.id::text,'') is null or r.period_id::text<>p_period_id or
       r.amount_cents is null or r.amount_cents<0 or nullif(btrim(r.merchant),'') is null or
       r.payer is null or not(r.payer=any(p_members)) or r.date is null or r.captured_at is null or
       r.category not in ('Groceries','Utilities','Dining','Household Supplies','Other') or
       r.image_url is null or r.image_url not like 'storage://bill-evidence/%' or
       not coalesce(r.is_excluded,false) or not coalesce(r.evidence_only,false) or
       not coalesce(r.needs_review,false) or r.date<p.start_date or r.date>p.end_date then
      raise exception 'Invalid review-only historical evidence';
    end if;
    if exists(select 1 from public.receipts where id=r.id and period_id::text<>p_period_id) then
      raise exception 'Existing receipt belongs to another period';
    end if;
    insert into public.receipts(
      id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,
      image_url,source_provider,source_message_id,evidence_only,needs_review
    ) values(
      r.id,r.period_id,r.captured_at,r.merchant,r.amount_cents,r.payer,r.category,r.date,true,
      r.image_url,'whatsapp',r.id::text,true,true
    ) on conflict do nothing;
    get diagnostics affected=row_count;
    if affected=1 then
      inserted:=inserted+1;
      inserted_ids:=array_append(inserted_ids,r.id::text);
    elsif not exists(
      select 1 from public.receipts existing where existing.id=r.id
        and existing.period_id::text=p_period_id
        and coalesce(existing.source_message_id,existing.id::text)=r.id::text
    ) then raise exception 'Source message identity conflicts with another receipt'; end if;
  end loop;

  summary:=format('Historical rescan complete: %s new review-only evidence item(s). Settlement values were preserved.',inserted);
  insert into public.instabox_historical_rescan_audit(
    job_id,period_id,start_boundary_id,end_boundary_id,inserted_receipt_ids
  ) values(p_job_id,p_period_id,p_start_boundary_id,p_end_boundary_id,inserted_ids)
  on conflict(job_id) do nothing;
  update public.sync_requests set status='done',stage='complete',stage_message='Historical rescan complete',
    stage_updated_at=now(),result_summary=summary,error=null,lease_expires_at=null
  where id=j.id;
  return jsonb_build_object('result_summary',summary,'inserted',inserted,'replayed',false);
end $$;

-- Existing permissive authenticated policies remain. These restrictive guards
-- prevent direct browser insertion of historical jobs and scope their reads to
-- the reviewed household. The request RPC performs all period validation.
drop policy if exists instabox_sync_job_type_insert_guard on public.sync_requests;
create policy instabox_sync_job_type_insert_guard on public.sync_requests
  as restrictive for insert to authenticated with check(job_type='sync');
drop policy if exists instabox_sync_job_type_select_guard on public.sync_requests;
create policy instabox_sync_job_type_select_guard on public.sync_requests
  as restrictive for select to authenticated using(
    job_type='sync' or public.is_instabox_household_member()
  );

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',6,'writes_enabled',writes_enabled)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.request_historical_rescan(text) from public,anon;
grant execute on function public.request_historical_rescan(text) to authenticated;
revoke all on function public.is_instabox_household_member() from public,anon;
grant execute on function public.is_instabox_household_member() to authenticated;
revoke all on function public.finalize_historical_rescan(uuid,text,text,text,text,jsonb,text[])
  from public,anon,authenticated;
grant execute on function public.finalize_historical_rescan(uuid,text,text,text,text,jsonb,text[])
  to service_role;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
