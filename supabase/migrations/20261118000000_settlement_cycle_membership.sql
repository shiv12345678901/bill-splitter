-- Additive cycle-specific household participation for capability v8.
-- Apply only after reviewing the four auth-user UUID mappings described in
-- DEPLOY_INSTABOX.md. This migration does not enable writes or alter owes.
begin;

create table if not exists public.household_auth_identities (
  auth_user_id uuid primary key references auth.users(id) on delete restrict,
  member_name text not null unique check(member_name in
    ('Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari')),
  household_role text not null default 'member' check(household_role in ('member','admin')),
  verified_at timestamptz not null default now(),
  verified_by text not null
);

create table if not exists public.settlement_cycle_membership_state (
  period_id text primary key references public.periods(id) on delete restrict,
  revision bigint not null default 1 check(revision >= 1),
  updated_at timestamptz not null default now()
);

create table if not exists public.settlement_cycle_members (
  period_id text not null references public.periods(id) on delete restrict,
  member_name text not null check(member_name in
    ('Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari')),
  participation_mode text not null check(participation_mode in ('enabled','keep_receipts','disabled')),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete restrict,
  primary key(period_id,member_name)
);

-- Existing history remains immutable and implicitly uses its original all-enabled
-- behavior. Only the CURRENT cycle receives explicit rows during this migration.
insert into public.settlement_cycle_membership_state(period_id,revision)
select id,1 from public.periods where status='CURRENT'
on conflict(period_id) do nothing;
insert into public.settlement_cycle_members(period_id,member_name,participation_mode)
select p.id,m.member_name,'enabled'
from public.periods p
cross join unnest(array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[]) m(member_name)
where p.status='CURRENT'
on conflict(period_id,member_name) do nothing;

do $$
declare current_id text; current_count integer;
begin
  select count(*) into current_count from public.periods where status='CURRENT';
  if current_count<>1 then raise exception 'Exactly one CURRENT period is required for membership initialization'; end if;
  select id into current_id from public.periods where status='CURRENT';
  if current_id is not null and
     (select count(*) from public.settlement_cycle_members where period_id=current_id)<>4 then
    raise exception 'CURRENT cycle membership must contain exactly four identities';
  end if;
end $$;

alter table public.household_auth_identities enable row level security;
alter table public.settlement_cycle_membership_state enable row level security;
alter table public.settlement_cycle_members enable row level security;
revoke all on public.household_auth_identities,public.settlement_cycle_membership_state,
  public.settlement_cycle_members from public,anon,authenticated;
grant select on public.household_auth_identities,public.settlement_cycle_membership_state,
  public.settlement_cycle_members to service_role;

create or replace function public.is_verified_household_identity()
returns boolean language sql stable security definer set search_path=public,auth,pg_temp as $$
  select auth.role()='service_role' or exists(
    select 1 from public.household_auth_identities where auth_user_id=auth.uid()
  );
$$;
revoke all on function public.is_verified_household_identity() from public,anon;
grant execute on function public.is_verified_household_identity() to authenticated,service_role;

create or replace function public.is_household_membership_admin()
returns boolean language sql stable security definer set search_path=public,auth,pg_temp as $$
  select auth.role()='service_role' or exists(
    select 1 from public.household_auth_identities where auth_user_id=auth.uid()
      and household_role='admin' and member_name in ('Shiva Kafle','Arjun Bhurtel')
  );
$$;
revoke all on function public.is_household_membership_admin() from public,anon;
grant execute on function public.is_household_membership_admin() to authenticated,service_role;

grant select on public.settlement_cycle_membership_state,public.settlement_cycle_members to authenticated;
drop policy if exists household_membership_state_read on public.settlement_cycle_membership_state;
create policy household_membership_state_read on public.settlement_cycle_membership_state
  for select to authenticated using(public.is_verified_household_identity());
drop policy if exists household_membership_read on public.settlement_cycle_members;
create policy household_membership_read on public.settlement_cycle_members
  for select to authenticated using(public.is_verified_household_identity());

create or replace function public.settlement_cycle_member_mode(p_period_id text,p_member_name text)
returns text language plpgsql stable security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.is_verified_household_identity() then raise exception 'UNAUTHORIZED_MEMBERSHIP_ACCESS'; end if;
  return coalesce((select participation_mode from public.settlement_cycle_members
    where period_id=p_period_id and member_name=p_member_name),'enabled');
end
$$;
revoke all on function public.settlement_cycle_member_mode(text,text) from public,anon;
grant execute on function public.settlement_cycle_member_mode(text,text) to authenticated,service_role;

-- A restrictive policy composes with the verified authenticated read policy.
-- Historical periods without explicit membership rows retain all-enabled visibility.
drop policy if exists settlement_cycle_receipt_visibility on public.receipts;
create policy settlement_cycle_receipt_visibility on public.receipts as restrictive
  for select to authenticated using(
    public.is_verified_household_identity() and
    public.settlement_cycle_member_mode(period_id::text,payer)<>'disabled'
  );

-- A previously issued object URL is time-limited, but new Storage reads must
-- also honor disabled-member visibility. Unlinked bank/review evidence retains
-- the existing verified-household behavior; disabled receipt objects are admin-only.
create or replace function public.can_read_bill_evidence_object(p_object_name text)
returns boolean language sql stable security definer set search_path=public,auth,pg_temp as $$
  select public.is_verified_household_identity() and (
    public.is_household_membership_admin() or not exists(
      select 1 from public.receipts r
      where r.image_url='storage://bill-evidence/'||p_object_name
        and public.settlement_cycle_member_mode(r.period_id::text,r.payer)='disabled'
    )
  );
$$;
revoke all on function public.can_read_bill_evidence_object(text) from public,anon;
grant execute on function public.can_read_bill_evidence_object(text) to authenticated,service_role;
drop policy if exists settlement_cycle_evidence_visibility on storage.objects;
create policy settlement_cycle_evidence_visibility on storage.objects as restrictive
  for select to authenticated using(
    bucket_id<>'bill-evidence' or public.can_read_bill_evidence_object(storage.objects.name)
  );

create or replace function public.compute_settlement_cycle_financials(p_period_id text)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  fixed_members constant text[]:=array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'];
  enabled_count integer; total bigint; receipt_count integer; display_share bigint;
  base_share bigint; remainder bigint; revision bigint; member_rows jsonb;
begin
  if not exists(select 1 from public.periods where id::text=p_period_id) then
    raise exception 'INVALID_PERIOD';
  end if;
  select count(*) into enabled_count from unnest(fixed_members) m(member_name)
    where public.settlement_cycle_member_mode(p_period_id,m.member_name)='enabled';
  if enabled_count=0 then raise exception 'ZERO_ENABLED_MEMBERS'; end if;
  if exists(select 1 from public.receipts r where r.period_id::text=p_period_id and not r.is_excluded
    and (r.amount_cents is null or r.amount_cents<0 or not(r.payer=any(fixed_members)))) then
    raise exception 'Existing receipt needs manual review; totals preserved';
  end if;
  select coalesce(sum(r.amount_cents),0),count(*) into total,receipt_count
    from public.receipts r where r.period_id::text=p_period_id and not r.is_excluded
      and public.settlement_cycle_member_mode(p_period_id,r.payer) in ('enabled','keep_receipts');
  display_share:=round(total::numeric/enabled_count);
  base_share:=floor(total::numeric/enabled_count);
  remainder:=total-(base_share*enabled_count);
  select coalesce(s.revision,1) into revision from public.settlement_cycle_membership_state s
    where s.period_id=p_period_id;
  revision:=coalesce(revision,1);
  with member_data as (
    select m.member_name,
      public.settlement_cycle_member_mode(p_period_id,m.member_name) participation_mode,
      coalesce((select sum(r.amount_cents) from public.receipts r
        where r.period_id::text=p_period_id and not r.is_excluded and r.payer=m.member_name
          and public.settlement_cycle_member_mode(p_period_id,r.payer) in ('enabled','keep_receipts')),0)::bigint paid_cents,
      case when public.settlement_cycle_member_mode(p_period_id,m.member_name)='enabled' then
        base_share + case when row_number() over(
          partition by (public.settlement_cycle_member_mode(p_period_id,m.member_name)='enabled')
          order by m.member_name collate "C")<=remainder then 1 else 0 end
      else 0 end::bigint share_cents
    from unnest(fixed_members) m(member_name)
  )
  select jsonb_agg(jsonb_build_object(
    'member_name',member_name,'participation_mode',participation_mode,
    'paid_cents',paid_cents,'share_cents',share_cents,'net_cents',paid_cents-share_cents
  ) order by member_name collate "C") into member_rows from member_data;
  if (select sum((item->>'net_cents')::bigint) from jsonb_array_elements(member_rows) item)<>0 then
    raise exception 'Settlement cent allocation is not balanced';
  end if;
  return jsonb_build_object('period_id',p_period_id,'revision',revision,'total_cents',total,
    'receipt_count',receipt_count,'equal_share_cents',display_share,'members',member_rows);
end $$;
revoke all on function public.compute_settlement_cycle_financials(text) from public,anon,authenticated;
grant execute on function public.compute_settlement_cycle_financials(text) to service_role;

create or replace function public.apply_settlement_cycle_financials(p_period_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare f jsonb; s public.settlements; v_member_totals jsonb;
begin
  f:=public.compute_settlement_cycle_financials(p_period_id);
  select * into s from public.settlements where period_id::text=p_period_id
    order by calculated_at desc limit 1 for update;
  if s.id is null then raise exception 'Existing settlement required'; end if;
  select jsonb_object_agg(item->>'member_name',(item->>'paid_cents')::bigint)
    into v_member_totals from jsonb_array_elements(f->'members') item;
  update public.settlements set total_cents=(f->>'total_cents')::bigint,
    per_person_cents=(f->>'equal_share_cents')::bigint,member_totals=v_member_totals,
    receipt_count=(f->>'receipt_count')::integer,calculated_at=now() where id=s.id;
  update public.periods set total_cents=(f->>'total_cents')::bigint,
    per_person_cents=(f->>'equal_share_cents')::bigint,
    receipt_count=(f->>'receipt_count')::integer where id::text=p_period_id;
  -- settlements.owes and all payment verification/obligation fields are untouched.
  return f;
end $$;
revoke all on function public.apply_settlement_cycle_financials(text) from public,anon,authenticated,service_role;

create or replace function public.get_settlement_cycle_membership(p_period_id text)
returns jsonb language plpgsql stable security definer set search_path=public,auth,pg_temp as $$
declare p public.periods; revision bigint; rows jsonb;
begin
  if not public.is_verified_household_identity() then raise exception 'UNAUTHORIZED_MEMBERSHIP_ACCESS'; end if;
  select * into p from public.periods where id::text=p_period_id;
  if p.id is null then raise exception 'INVALID_PERIOD'; end if;
  select coalesce(s.revision,1) into revision from public.settlement_cycle_membership_state s where s.period_id=p_period_id;
  select jsonb_agg(jsonb_build_object('member_name',m.member_name,
    'participation_mode',public.settlement_cycle_member_mode(p_period_id,m.member_name))
    order by m.member_name collate "C") into rows
  from unnest(array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[]) m(member_name);
  return jsonb_build_object('period_id',p_period_id,'revision',coalesce(revision,1),
    'status',p.status,'members',rows);
end $$;

create or replace function public.preview_settlement_cycle_membership(p_period_id text)
returns jsonb language plpgsql stable security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.is_verified_household_identity() then raise exception 'UNAUTHORIZED_MEMBERSHIP_ACCESS'; end if;
  return public.compute_settlement_cycle_financials(p_period_id);
end $$;

create or replace function public.get_effective_receipt_visibility(p_period_id text)
returns table(receipt_id text,payer text,participation_mode text,visible boolean,eligible boolean,manually_excluded boolean)
language plpgsql stable security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.is_household_membership_admin() then
    raise exception 'UNAUTHORIZED_MEMBERSHIP_CHANGE';
  end if;
  return query select r.id::text,r.payer,public.settlement_cycle_member_mode(p_period_id,r.payer),
    public.settlement_cycle_member_mode(p_period_id,r.payer)<>'disabled',
    not r.is_excluded and public.settlement_cycle_member_mode(p_period_id,r.payer) in ('enabled','keep_receipts'),
    r.is_excluded
  from public.receipts r where r.period_id::text=p_period_id order by r.date,r.id;
end $$;

create or replace function public.get_disabled_settlement_receipts(p_period_id text)
returns table(
  id text,period_id text,captured_at timestamptz,merchant text,amount_cents bigint,
  payer text,category text,date date,is_excluded boolean,image_url text
) language plpgsql stable security definer set search_path=public,auth,pg_temp as $$
begin
  if not public.is_household_membership_admin() then raise exception 'UNAUTHORIZED_MEMBERSHIP_CHANGE'; end if;
  if not exists(select 1 from public.periods where public.periods.id::text=p_period_id) then raise exception 'INVALID_PERIOD'; end if;
  return query select r.id::text,r.period_id::text,r.captured_at,r.merchant,r.amount_cents::bigint,
    r.payer,r.category,r.date,r.is_excluded,r.image_url
  from public.receipts r where r.period_id::text=p_period_id
    and public.settlement_cycle_member_mode(p_period_id,r.payer)='disabled'
  order by r.date desc,r.id;
end $$;

create or replace function public.set_settlement_cycle_member_mode(
  p_period_id text,p_member_name text,p_participation_mode text,p_expected_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,auth,pg_temp as $$
declare p public.periods; state public.settlement_cycle_membership_state; s public.settlements;
begin
  perform pg_advisory_xact_lock(17498013);
  if not public.is_household_membership_admin() or auth.role()='service_role' then
    raise exception 'UNAUTHORIZED_MEMBERSHIP_CHANGE';
  end if;
  if not(p_member_name=any(array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[])) then
    raise exception 'INVALID_MEMBER_IDENTITY';
  end if;
  if p_participation_mode not in ('enabled','keep_receipts','disabled') then raise exception 'INVALID_PARTICIPATION_MODE'; end if;
  select * into p from public.periods where id::text=p_period_id for update;
  if p.id is null then raise exception 'INVALID_PERIOD'; end if;
  if p.status<>'CURRENT' then raise exception 'CLOSED_CYCLE_MEMBERSHIP_CHANGE'; end if;
  select * into s from public.settlements where period_id::text=p_period_id order by calculated_at desc limit 1 for update;
  if s.payment_obligations_status is distinct from 'UNINITIALIZED' then raise exception 'FINALIZED_OBLIGATIONS'; end if;
  select * into state from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if state.period_id is null then raise exception 'MEMBERSHIP_NOT_INITIALIZED'; end if;
  if state.revision is distinct from p_expected_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  if p_participation_mode<>'enabled' and
    (select count(*) from public.settlement_cycle_members where period_id=p_period_id
      and participation_mode='enabled' and member_name<>p_member_name)=0 then
    raise exception 'ZERO_ENABLED_MEMBERS';
  end if;
  update public.settlement_cycle_members set participation_mode=p_participation_mode,
    updated_at=now(),updated_by=auth.uid() where period_id=p_period_id and member_name=p_member_name;
  if not found then raise exception 'MEMBERSHIP_NOT_INITIALIZED'; end if;
  update public.settlement_cycle_membership_state set revision=revision+1,updated_at=now()
    where period_id=p_period_id;
  perform public.apply_settlement_cycle_financials(p_period_id);
  return public.get_settlement_cycle_membership(p_period_id);
end $$;

-- Fence capability-v7 workers while retaining an explicit diagnostic at the old signatures.
do $$ begin
  if to_regprocedure('public.finalize_sync_request_v7(uuid,text,text,jsonb,text[],text,text)') is null then
    alter function public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text) rename to finalize_sync_request_v7;
  end if;
end $$;
create or replace function public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.finalize_sync_request(
  p_job_id uuid,p_worker_id text,p_period_id text,p_receipts jsonb,p_members text[],
  p_rounding text,p_settlement_id_mode text,p_membership_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint; result jsonb; financials jsonb; summary text;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  if p_rounding is distinct from 'round' then raise exception 'Reviewed settlement rules require shareRounding=round'; end if;
  if exists(select 1 from jsonb_array_elements(p_receipts) item
    where public.settlement_cycle_member_mode(p_period_id,item->>'payer')='disabled') then
    raise exception 'DISABLED_MEMBER_RECEIPT_REQUIRES_RESCAN';
  end if;
  result:=public.finalize_sync_request_v7(p_job_id,p_worker_id,p_period_id,p_receipts,p_members,p_rounding,p_settlement_id_mode);
  financials:=public.apply_settlement_cycle_financials(p_period_id);
  summary:=format('Sync complete: %s eligible receipt(s) in the period.',financials->>'receipt_count');
  update public.sync_requests set result_summary=summary where id=p_job_id;
  update public.instabox_sync_audit set result_summary=summary where job_id=p_job_id;
  return jsonb_build_object('result_summary',summary,'membership_revision',p_membership_revision);
end $$;

do $$ begin
  if to_regprocedure('public.prepare_instabox_whatsapp_sources_v7(uuid,text,text,jsonb)') is null then
    alter function public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb) rename to prepare_instabox_whatsapp_sources_v7;
  end if;
end $$;
create or replace function public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.prepare_instabox_whatsapp_sources(
  p_job_id uuid,p_worker_id text,p_period_id text,p_sources jsonb,p_membership_revision bigint
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  perform public.prepare_instabox_whatsapp_sources_v7(p_job_id,p_worker_id,p_period_id,p_sources);
end $$;

do $$ begin
  if to_regprocedure('public.record_period_cycle_state_v7(uuid,text,text,text,jsonb,jsonb)') is null then
    alter function public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)
      rename to record_period_cycle_state_v7;
  end if;
end $$;
create or replace function public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.record_period_cycle_state(
  p_job_id uuid,p_worker_id text,p_period_id text,p_cycle_status text,
  p_calculation_message jsonb,p_clearance_message jsonb,p_membership_revision bigint
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  perform public.record_period_cycle_state_v7(p_job_id,p_worker_id,p_period_id,p_cycle_status,
    p_calculation_message,p_clearance_message);
  return;
end $$;

do $$ begin
  if to_regprocedure('public.record_whatsapp_bank_evidence_v7(uuid,text,text,jsonb)') is null then
    alter function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
      rename to record_whatsapp_bank_evidence_v7;
  end if;
end $$;
create or replace function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.record_whatsapp_bank_evidence(
  p_job_id uuid,p_worker_id text,p_period_id text,p_evidence jsonb,p_membership_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  return public.record_whatsapp_bank_evidence_v7(p_job_id,p_worker_id,p_period_id,p_evidence);
end $$;

do $$ begin
  if to_regprocedure('public.reconcile_deleted_whatsapp_images_v7(uuid,text,text,jsonb,text[],text)') is null then
    alter function public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text) rename to reconcile_deleted_whatsapp_images_v7;
  end if;
end $$;
create or replace function public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.reconcile_deleted_whatsapp_images(
  p_job_id uuid,p_worker_id text,p_period_id text,p_deletions jsonb,p_members text[],p_rounding text,p_membership_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint; result jsonb;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  result:=public.reconcile_deleted_whatsapp_images_v7(p_job_id,p_worker_id,p_period_id,p_deletions,p_members,p_rounding);
  if coalesce((result->>'receipts_deleted')::integer,0)>0 then perform public.apply_settlement_cycle_financials(p_period_id); end if;
  return result||jsonb_build_object('membership_revision',p_membership_revision);
end $$;

do $$ begin
  if to_regprocedure('public.rollover_settlement_period_v7(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])') is null then
    alter function public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])
      rename to rollover_settlement_period_v7;
  end if;
end $$;
create or replace function public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin raise exception 'MEMBERSHIP_REVISION_REQUIRED'; end $$;
create or replace function public.rollover_settlement_period(
  p_job_id uuid,p_worker_id text,p_old_period_id text,p_old_end_date date,p_clearance_message jsonb,
  p_new_period_id text,p_new_settlement_id text,p_new_start_date date,p_start_boundary jsonb,
  p_new_cycle_status text,p_calculation_message jsonb,p_members text[],p_membership_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint; result jsonb;
begin
  perform pg_advisory_xact_lock(17498013);
  select revision into current_revision from public.settlement_cycle_membership_state where period_id=p_old_period_id for update;
  if current_revision is distinct from p_membership_revision then raise exception 'STALE_MEMBERSHIP_REVISION'; end if;
  result:=public.rollover_settlement_period_v7(p_job_id,p_worker_id,p_old_period_id,p_old_end_date,p_clearance_message,
    p_new_period_id,p_new_settlement_id,p_new_start_date,p_start_boundary,p_new_cycle_status,p_calculation_message,p_members);
  insert into public.settlement_cycle_membership_state(period_id,revision) values(p_new_period_id,1) on conflict do nothing;
  insert into public.settlement_cycle_members(period_id,member_name,participation_mode)
    select p_new_period_id,m,'enabled' from unnest(p_members) m on conflict do nothing;
  if (select count(*) from public.settlement_cycle_members where period_id=p_new_period_id and participation_mode='enabled')<>4 then
    raise exception 'New cycle membership initialization conflict';
  end if;
  return result||jsonb_build_object('membership_revision',1);
end $$;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',8,'writes_enabled',writes_enabled,'cycle_membership',true)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.finalize_sync_request_v7(uuid,text,text,jsonb,text[],text,text),
  public.prepare_instabox_whatsapp_sources_v7(uuid,text,text,jsonb),
  public.record_period_cycle_state_v7(uuid,text,text,text,jsonb,jsonb),
  public.record_whatsapp_bank_evidence_v7(uuid,text,text,jsonb),
  public.reconcile_deleted_whatsapp_images_v7(uuid,text,text,jsonb,text[],text),
  public.rollover_settlement_period_v7(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])
  from public,anon,authenticated,service_role;
revoke all on function public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text),
  public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text,bigint),
  public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb),
  public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb,bigint),
  public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb),
  public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb,bigint),
  public.record_whatsapp_bank_evidence(uuid,text,text,jsonb),
  public.record_whatsapp_bank_evidence(uuid,text,text,jsonb,bigint),
  public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text),
  public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text,bigint),
  public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[]),
  public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[],bigint)
  from public,anon,authenticated;
grant execute on function public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text),
  public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text,bigint),
  public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb),
  public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb,bigint),
  public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb),
  public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb,bigint),
  public.record_whatsapp_bank_evidence(uuid,text,text,jsonb),
  public.record_whatsapp_bank_evidence(uuid,text,text,jsonb,bigint),
  public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text),
  public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text,bigint),
  public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[]),
  public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[],bigint)
  to service_role;

revoke all on function public.get_settlement_cycle_membership(text),
  public.preview_settlement_cycle_membership(text),public.get_effective_receipt_visibility(text),
  public.get_disabled_settlement_receipts(text),
  public.set_settlement_cycle_member_mode(text,text,text,bigint) from public,anon;
grant execute on function public.get_settlement_cycle_membership(text),
  public.preview_settlement_cycle_membership(text),public.get_effective_receipt_visibility(text),
  public.get_disabled_settlement_receipts(text)
  to authenticated,service_role;
grant execute on function public.set_settlement_cycle_member_mode(text,text,text,bigint) to authenticated;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
