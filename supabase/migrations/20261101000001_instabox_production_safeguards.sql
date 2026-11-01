-- REVIEW AGAINST A SCHEMA EXPORT FIRST. Apply with psql -v ON_ERROR_STOP=1.
-- No backfill, receipt deletion, source-ID guessing, or replacement of totals.
begin;
do $$
begin
  if exists(select 1 from information_schema.columns where table_schema='public' and
    ((table_name='sync_requests' and column_name='status' and data_type<>'text') or
     (table_name='receipts' and column_name='date' and data_type<>'date') or
     (table_name='receipts' and column_name='amount_cents' and data_type not in ('integer','bigint')))) then
    raise exception 'Unsupported status/date/amount type; review an explicit schema adapter';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='receipts' and column_name='id' and data_type='text') then
    raise exception 'Bundled adapter requires receipts.id text. Review legacy source mapping first.';
  end if;
  if exists(select 1 from public.receipts group by id having count(*) > 1) then
    raise exception 'Duplicate receipt IDs require manual review; migration will not delete data.';
  end if;
end $$;

alter table public.receipts add column if not exists source_provider text,
  add column if not exists source_message_id text;
create unique index if not exists instabox_receipt_id_unique on public.receipts(id);
create unique index if not exists instabox_receipt_source_unique
  on public.receipts(source_provider, source_message_id) where source_message_id is not null;
alter table public.sync_requests add column if not exists next_attempt_at timestamptz,
  add column if not exists max_attempts integer not null default 3;

create table if not exists public.instabox_worker_control (
  singleton boolean primary key default true check(singleton),
  writes_enabled boolean not null default false,
  review_reference text
);
insert into public.instabox_worker_control(singleton) values(true) on conflict do nothing;
create table if not exists public.instabox_sync_audit (
  job_id text primary key,
  period_id text not null,
  previous_period jsonb not null,
  previous_settlements jsonb not null,
  result_summary text,
  completed_at timestamptz
);
alter table public.instabox_worker_control enable row level security;
alter table public.instabox_sync_audit enable row level security;
revoke all on public.instabox_worker_control, public.instabox_sync_audit from public, anon, authenticated;
grant select on public.instabox_worker_control to service_role;
grant select on public.instabox_sync_audit to service_role;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',2,'writes_enabled',writes_enabled) from public.instabox_worker_control where singleton;
$$;

create or replace function public.claim_sync_request(p_worker_id text, p_requested_by text default 'netlify-app', p_lease_seconds integer default 900)
returns setof public.sync_requests language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then return; end if;
  if nullif(btrim(p_worker_id),'') is null then raise exception 'worker ID required'; end if;
  perform pg_advisory_xact_lock(17498013);
  -- Unleased legacy jobs are never stolen. Disable/reconcile Muse separately.
  if exists(select 1 from public.sync_requests where status='processing' and (lease_expires_at is null or lease_expires_at>now())) then return; end if;
  update public.sync_requests set status='failed', stage='failed', stage_message='Retry limit reached',
    error='Worker recovery retry limit reached', lease_expires_at=null, stage_updated_at=now()
    where requested_by=p_requested_by and status='processing' and lease_expires_at<=now() and attempt_count>=max_attempts;
  return query with candidate as (
    select id from public.sync_requests where requested_by=p_requested_by
      and ((status='pending' and coalesce(next_attempt_at,now())<=now()) or (status='processing' and lease_expires_at<=now()))
      and attempt_count<max_attempts order by created_at for update skip locked limit 1
  ) update public.sync_requests s set status='processing', worker_id=p_worker_id,
    lease_expires_at=now()+make_interval(secs=>greatest(60,least(p_lease_seconds,3600))),
    attempt_count=s.attempt_count+1, claimed_at=now(), stage='claimed',
    stage_message='Loading WhatsApp receipts', stage_updated_at=now(), error=null
    from candidate where s.id=candidate.id returning s.*;
end $$;

create or replace function public.retry_sync_request(p_job_id text,p_worker_id text,p_error text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.sync_requests set
    status=case when attempt_count<max_attempts then 'pending' else 'failed' end,
    stage=case when attempt_count<max_attempts then 'retry_wait' else 'failed' end,
    stage_message=case when attempt_count<max_attempts then 'Temporary failure; retry scheduled' else 'Sync failed after retries' end,
    error=left(p_error,2000), stage_updated_at=now(), lease_expires_at=null,
    next_attempt_at=now()+make_interval(secs=>least(300,5*power(2,least(attempt_count,6))::integer))
    where id::text=p_job_id and worker_id=p_worker_id and status='processing' and lease_expires_at>now();
end $$;

create or replace function public.finalize_sync_request(
  p_job_id text,p_worker_id text,p_period_id text,p_receipts jsonb,p_members text[],
  p_rounding text,p_settlement_id_mode text default 'existing-only'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests; p public.periods; s public.settlements;
  r public.receipts; item jsonb; total bigint; count_receipts integer;
  shares bigint; v_member_totals jsonb; summary text; inserted integer:=0; affected integer;
begin
  perform pg_advisory_xact_lock(17498013);
  select * into j from public.sync_requests where id::text=p_job_id for update;
  -- A committed response lost in transit is a successful replay, regardless of lease.
  if j.status='done' and exists(select 1 from public.instabox_sync_audit where job_id=p_job_id and completed_at is not null) then
    return jsonb_build_object('result_summary',j.result_summary);
  end if;
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then raise exception 'Production writes disabled'; end if;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id or j.lease_expires_at<=now() or j.lease_expires_at is null then raise exception 'Lost job lease'; end if;
  if coalesce(array_length(p_members,1),0)=0 or p_rounding not in ('floor','round') or p_rounding is null then raise exception 'Reviewed settlement rules required'; end if;
  if (select count(distinct m) from unnest(p_members) m)<>array_length(p_members,1) then raise exception 'Duplicate members'; end if;
  select * into p from public.periods where id::text=p_period_id for update;
  if p.id is null or p.status<>'CURRENT' then raise exception 'Only an existing CURRENT period may be refreshed'; end if;
  -- Serialize against manual edits during aggregate calculation; all originals survive.
  lock table public.receipts in share row exclusive mode;
  lock table public.settlements in share row exclusive mode;
  insert into public.instabox_sync_audit(job_id,period_id,previous_period,previous_settlements)
    values(p_job_id,p_period_id,to_jsonb(p),coalesce((select jsonb_agg(to_jsonb(t)) from public.settlements t where t.period_id::text=p_period_id),'[]'))
    on conflict(job_id) do nothing;
  if jsonb_typeof(p_receipts)<>'array' then raise exception 'Receipt array required'; end if;
  for item in select value from jsonb_array_elements(p_receipts) loop
    r:=jsonb_populate_record(null::public.receipts,item);
    if nullif(r.id::text,'') is null or r.period_id::text<>p_period_id or r.amount_cents is null or r.amount_cents<0
      or nullif(btrim(r.merchant),'') is null or not(r.payer=any(p_members)) or r.payer is null or r.date is null or r.captured_at is null
      or r.category not in ('Groceries','Utilities','Dining','Household Supplies','Other') or r.category is null
      or r.image_url not like 'storage://bill-evidence/%' or r.image_url is null
      or r.date<p.start_date or (p.end_date is not null and r.date>p.end_date) then raise exception 'Invalid receipt or period mapping'; end if;
    -- Never reassign a legacy receipt to another period or overwrite its edits.
    if exists(select 1 from public.receipts where id=r.id and period_id::text<>p_period_id) then raise exception 'Existing receipt belongs to another period'; end if;
    insert into public.receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url,source_provider,source_message_id)
      values(r.id,r.period_id,r.captured_at,r.merchant,r.amount_cents,r.payer,r.category,r.date,coalesce(r.is_excluded,false),r.image_url,'whatsapp',r.id::text)
      on conflict do nothing;
    get diagnostics affected=row_count; inserted:=inserted+affected;
    if affected=0 and not exists(select 1 from public.receipts where id=r.id) then
      raise exception 'Source message identity conflicts with another receipt; manual mapping required';
    end if;
    -- Only a null evidence locator may be filled on an existing record.
    update public.receipts set image_url=r.image_url where id=r.id and image_url is null;
  end loop;
  if exists(select 1 from public.receipts where period_id::text=p_period_id and not is_excluded
    and (amount_cents is null or amount_cents<0 or payer is null or not(payer=any(p_members)))) then raise exception 'Existing receipt needs manual review; totals preserved'; end if;
  select coalesce(sum(amount_cents),0),count(*) into total,count_receipts from public.receipts where period_id::text=p_period_id and not is_excluded;
  shares:=case when p_rounding='round' then round(total::numeric/array_length(p_members,1)) else floor(total::numeric/array_length(p_members,1)) end;
  select jsonb_object_agg(m,coalesce((select sum(amount_cents) from public.receipts where period_id::text=p_period_id and not is_excluded and payer=m),0))
    into v_member_totals from unnest(p_members) m;
  select * into s from public.settlements where period_id::text=p_period_id order by calculated_at desc limit 1 for update;
  if s.id is null then
    if p_settlement_id_mode not in ('text','uuid') then raise exception 'First settlement requires reviewed ID type'; end if;
    s:=jsonb_populate_record(null::public.settlements,jsonb_build_object(
      'id',case when p_settlement_id_mode='uuid' then md5('instabox-settlement:'||p_period_id) else 'instabox-settlement-'||p_period_id end,'period_id',p_period_id));
    insert into public.settlements(id,period_id,total_cents,per_person_cents,member_totals,receipt_count,calculated_at)
      values(s.id,s.period_id,total,shares,v_member_totals,count_receipts,now());
  else
    update public.settlements set total_cents=total,per_person_cents=shares,member_totals=v_member_totals,receipt_count=count_receipts,calculated_at=now() where id=s.id;
  end if;
  update public.periods set total_cents=total,per_person_cents=shares,receipt_count=count_receipts where id=p.id;
  summary:=format('Sync complete: %s new receipt(s), %s receipt(s) in the period.',inserted,count_receipts);
  update public.sync_requests set status='done',stage='complete',stage_message='Sync complete',stage_updated_at=now(),result_summary=summary,error=null,lease_expires_at=null where id=j.id;
  update public.instabox_sync_audit set result_summary=summary,completed_at=now() where job_id=p_job_id;
  return jsonb_build_object('result_summary',summary);
end $$;

revoke all on function public.claim_sync_request(text,text,integer), public.retry_sync_request(text,text,text),
  public.finalize_sync_request(text,text,text,jsonb,text[],text,text),public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.claim_sync_request(text,text,integer), public.retry_sync_request(text,text,text),
  public.finalize_sync_request(text,text,text,jsonb,text[],text,text),public.instabox_worker_capabilities() to service_role;

alter table public.sync_requests enable row level security;
alter table public.receipts enable row level security;
alter table public.periods enable row level security;
alter table public.settlements enable row level security;
-- Restrictive policies constrain existing permissive policies as well. Preserve
-- existing grants/policies; service_role bypasses RLS. Household model matches frontend.
grant select,insert on public.sync_requests to authenticated;
revoke all on public.sync_requests,public.receipts,public.periods,public.settlements from anon,public;
revoke update,delete on public.sync_requests from authenticated;
grant select on public.receipts,public.periods,public.settlements to authenticated;
drop policy if exists instabox_sync_read on public.sync_requests;
drop policy if exists instabox_sync_insert on public.sync_requests;
drop policy if exists instabox_sync_insert_guard on public.sync_requests;
drop policy if exists instabox_sync_update_guard on public.sync_requests;
drop policy if exists instabox_sync_delete_guard on public.sync_requests;
drop policy if exists instabox_sync_anon_guard on public.sync_requests;
create policy instabox_sync_read on public.sync_requests for select to authenticated using(requested_by='netlify-app');
create policy instabox_sync_insert on public.sync_requests for insert to authenticated
  with check(requested_by='netlify-app' and status='pending' and worker_id is null and lease_expires_at is null and attempt_count=0);
create policy instabox_sync_insert_guard on public.sync_requests as restrictive for insert to authenticated
  with check(requested_by='netlify-app' and status='pending' and worker_id is null and lease_expires_at is null and attempt_count=0);
create policy instabox_sync_update_guard on public.sync_requests as restrictive for update to authenticated using(false);
create policy instabox_sync_delete_guard on public.sync_requests as restrictive for delete to authenticated using(false);
create policy instabox_sync_anon_guard on public.sync_requests as restrictive for all to anon using(false) with check(false);
drop policy if exists instabox_household_receipts_read on public.receipts;
drop policy if exists instabox_household_periods_read on public.periods;
drop policy if exists instabox_household_settlements_read on public.settlements;
create policy instabox_household_receipts_read on public.receipts for select to authenticated using(true);
create policy instabox_household_periods_read on public.periods for select to authenticated using(true);
create policy instabox_household_settlements_read on public.settlements for select to authenticated using(true);
-- Evidence is private; existing authenticated household read policy remains valid.
do $$ begin
  if exists(select 1 from storage.buckets where id='bill-evidence' and public) then raise exception 'bill-evidence is public; review Storage before proceeding'; end if;
end $$;
drop policy if exists instabox_private_evidence_read on storage.objects;
create policy instabox_private_evidence_read on storage.objects for select to authenticated using(bucket_id='bill-evidence');
commit;
