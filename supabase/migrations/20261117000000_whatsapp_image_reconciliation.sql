-- REVIEW AGAINST A FRESH PRODUCTION SCHEMA EXPORT BEFORE APPLYING.
-- Adds fail-closed reconciliation for explicit WhatsApp image revocations.
-- Existing receipts/evidence are deliberately not registered as worker-managed;
-- therefore this migration cannot automatically delete the 134 legacy rows.
begin;

create table if not exists public.instabox_managed_whatsapp_sources (
  source_message_id text primary key,
  period_id text not null references public.periods(id),
  source_kind text not null check(source_kind in ('receipt','bank_evidence')),
  group_identity_hash text not null check(group_identity_hash ~ '^[0-9a-f]{64}$'),
  cycle_start_boundary_id text not null,
  registration_status text not null default 'pending' check(registration_status in ('pending','active')),
  job_id uuid not null references public.sync_requests(id),
  registered_at timestamptz not null default now(),
  activated_at timestamptz
);

create table if not exists public.whatsapp_image_reconciliation_audit (
  audit_id bigint generated always as identity primary key,
  idempotency_key text not null,
  job_id uuid not null references public.sync_requests(id),
  period_id text not null references public.periods(id),
  source_message_id text not null,
  evidence_source text not null check(evidence_source in ('message_revoke_everyone','revoked_placeholder')),
  group_identity_hash text not null check(group_identity_hash ~ '^[0-9a-f]{64}$'),
  cycle_start_boundary_id text not null,
  evidence_detected_at timestamptz not null,
  outcome text not null check(outcome in ('receipt_deleted','bank_evidence_deleted','not_found','protected_legacy','protected_reviewed')),
  source_state text not null,
  previous_record jsonb,
  reconciled_at timestamptz not null default now(),
  unique(idempotency_key,source_state)
);
create index if not exists whatsapp_image_reconciliation_idempotency_idx
  on public.whatsapp_image_reconciliation_audit(idempotency_key,reconciled_at desc,audit_id desc);

alter table public.instabox_managed_whatsapp_sources enable row level security;
alter table public.whatsapp_image_reconciliation_audit enable row level security;
revoke all on public.instabox_managed_whatsapp_sources,public.whatsapp_image_reconciliation_audit
  from public,anon,authenticated;
grant select on public.instabox_managed_whatsapp_sources,public.whatsapp_image_reconciliation_audit
  to service_role;

-- Preserve the v6 implementation behind a validating wrapper. The wrapper
-- aligns SQL with the Sydney/date and unknown-vs-zero rules enforced in Node.
do $$ begin
  if to_regprocedure('public.record_whatsapp_bank_evidence_v6(uuid,text,text,jsonb)') is null then
    alter function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
      rename to record_whatsapp_bank_evidence_v6;
  end if;
end $$;
create or replace function public.record_whatsapp_bank_evidence(
  p_job_id uuid,p_worker_id text,p_period_id text,p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.periods; item jsonb; captured_at timestamptz; transfer_date date; amount integer;
begin
  select * into p from public.periods where id::text=p_period_id;
  if p.id is null then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end if;
  if jsonb_typeof(p_evidence)<>'array' then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end if;
  for item in select value from jsonb_array_elements(p_evidence) loop
    if nullif(btrim(item->>'source_message_id'),'') is null or
       length(item->>'source_message_id')>512 or item->>'source_message_id' ~ '[[:space:]]' or
       item->>'source_message_id' is distinct from item->>'id' then
      raise exception 'BANK_EVIDENCE_INVALID_SOURCE';
    end if;
    if nullif(btrim(item->>'sender_name'),'') is null then raise exception 'BANK_EVIDENCE_MISSING_SENDER'; end if;
    if not ((item->>'sender_name')=any(array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[])) then
      raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED';
    end if;
    begin captured_at:=(item->>'captured_at')::timestamptz;
    exception when others then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end;
    begin transfer_date:=nullif(item->>'transfer_date','')::date;
    exception when others then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end;
    begin amount:=nullif(item->>'amount_cents','')::integer;
    exception when others then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end;
    if (captured_at at time zone 'Australia/Sydney')::date<p.start_date or
       (p.end_date is not null and (captured_at at time zone 'Australia/Sydney')::date>p.end_date) or
       (transfer_date is not null and (transfer_date<p.start_date or (p.end_date is not null and transfer_date>p.end_date))) then
      raise exception 'BANK_EVIDENCE_DATE_OUTSIDE_PERIOD';
    end if;
    if amount=0 then raise exception 'BANK_EVIDENCE_REVIEW_REQUIRED'; end if;
  end loop;
  return public.record_whatsapp_bank_evidence_v6(p_job_id,p_worker_id,p_period_id,p_evidence);
end $$;
revoke all on function public.record_whatsapp_bank_evidence_v6(uuid,text,text,jsonb)
  from public,anon,authenticated,service_role;
revoke all on function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb) to service_role;

create or replace function public.register_instabox_whatsapp_receipt()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.source_provider='whatsapp' and nullif(btrim(new.source_message_id),'') is not null
     and new.source_message_id=new.id::text then
    update public.instabox_managed_whatsapp_sources
      set registration_status='active',activated_at=now()
      where source_message_id=new.source_message_id and period_id=new.period_id::text
        and source_kind='receipt';
  end if;
  return new;
end $$;

drop trigger if exists instabox_register_whatsapp_receipt on public.receipts;
create trigger instabox_register_whatsapp_receipt after insert on public.receipts
  for each row execute function public.register_instabox_whatsapp_receipt();

create or replace function public.register_instabox_whatsapp_bank_evidence()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.source_message_id=new.id then
    update public.instabox_managed_whatsapp_sources
      set registration_status='active',activated_at=now()
      where source_message_id=new.source_message_id and period_id=new.period_id::text
        and source_kind='bank_evidence';
  end if;
  return new;
end $$;

create or replace function public.prepare_instabox_whatsapp_sources(
  p_job_id uuid,p_worker_id text,p_period_id text,p_sources jsonb
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests; p public.periods; item jsonb; v_source_id text; v_source_kind text;
  v_group_identity_hash text; v_cycle_start_boundary_id text;
begin
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id or
     j.lease_expires_at is null or j.lease_expires_at<=now() then raise exception 'Lost job lease'; end if;
  select * into p from public.periods where id::text=p_period_id;
  if p.id is null or p.status<>'CURRENT' then raise exception 'Managed WhatsApp sources require the CURRENT period'; end if;
  if jsonb_typeof(p_sources)<>'array' then raise exception 'Source array required'; end if;
  for item in select value from jsonb_array_elements(p_sources) loop
    v_source_id:=nullif(btrim(item->>'source_message_id'),''); v_source_kind:=item->>'source_kind';
    v_group_identity_hash:=item->>'group_identity_hash';
    v_cycle_start_boundary_id:=nullif(btrim(item->>'cycle_start_boundary_id'),'');
    if v_source_id is null or length(v_source_id)>512 or v_source_id ~ '[[:space:]]' or
       v_source_kind not in ('receipt','bank_evidence') or
       v_group_identity_hash !~ '^[0-9a-f]{64}$' or v_cycle_start_boundary_id is null or
       p.whatsapp_start_boundary->>'id' is distinct from v_cycle_start_boundary_id then
      raise exception 'Invalid managed source provenance';
    end if;
    if exists(select 1 from public.receipts r where r.id::text=v_source_id or r.source_message_id=v_source_id) or
       exists(select 1 from public.whatsapp_bank_transfer_evidence e where e.id=v_source_id or e.source_message_id=v_source_id) then
      raise exception 'Existing source cannot be registered retroactively';
    end if;
    insert into public.instabox_managed_whatsapp_sources(
      source_message_id,period_id,source_kind,group_identity_hash,cycle_start_boundary_id,
      registration_status,job_id
    ) values(v_source_id,p_period_id,v_source_kind,v_group_identity_hash,v_cycle_start_boundary_id,'pending',p_job_id)
    on conflict(source_message_id) do update set
      job_id=excluded.job_id
    where instabox_managed_whatsapp_sources.period_id=excluded.period_id
      and instabox_managed_whatsapp_sources.source_kind=excluded.source_kind
      and instabox_managed_whatsapp_sources.registration_status='pending';
    if not exists(select 1 from public.instabox_managed_whatsapp_sources managed_source
      where managed_source.source_message_id=v_source_id and managed_source.period_id=p_period_id
        and managed_source.source_kind=v_source_kind
        and managed_source.group_identity_hash=v_group_identity_hash
        and managed_source.cycle_start_boundary_id=v_cycle_start_boundary_id)
      then raise exception 'Managed source identity conflict'; end if;
  end loop;
end $$;

drop trigger if exists instabox_register_whatsapp_bank_evidence on public.whatsapp_bank_transfer_evidence;
create trigger instabox_register_whatsapp_bank_evidence
  after insert on public.whatsapp_bank_transfer_evidence
  for each row execute function public.register_instabox_whatsapp_bank_evidence();

create or replace function public.reconcile_deleted_whatsapp_images(
  p_job_id uuid,
  p_worker_id text,
  p_period_id text,
  p_deletions jsonb,
  p_members text[],
  p_rounding text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests;
  p public.periods;
  s public.settlements;
  item jsonb;
  managed public.instabox_managed_whatsapp_sources;
  v_source_id text;
  v_evidence_source text;
  v_group_identity_hash text;
  v_cycle_start_boundary_id text;
  v_idempotency_key text;
  detected_at timestamptz;
  previous jsonb;
  outcome text;
  current_source_state text;
  latest_audit public.whatsapp_image_reconciliation_audit;
  total bigint;
  count_receipts integer;
  shares bigint;
  v_member_totals jsonb;
  changed_receipts integer:=0;
  changed_evidence integer:=0;
  protected integer:=0;
  v_outcomes jsonb:='{}'::jsonb;
begin
  perform pg_advisory_xact_lock(17498013);
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id or
     j.lease_expires_at is null or j.lease_expires_at<=now() then raise exception 'Lost job lease'; end if;
  select * into p from public.periods where id::text=p_period_id for update;
  if p.id is null or p.status<>'CURRENT' or p.whatsapp_cycle_status is distinct from 'ACTIVE' then
    raise exception 'Automatic WhatsApp deletion reconciliation requires the CURRENT ACTIVE cycle';
  end if;
  if coalesce(array_length(p_members,1),0)<>4 or
     (select count(distinct member_name) from unnest(p_members) member_name)<>4 or
     not (p_members @> array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[] and
          p_members <@ array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari']::text[]) or
     p_rounding is distinct from 'round' then raise exception 'Reviewed settlement rules require shareRounding=round'; end if;
  if jsonb_typeof(p_deletions)<>'array' then raise exception 'Deletion evidence array required'; end if;
  -- Match finalize_sync_request's lock order to avoid deadlocks with manual edits.
  lock table public.receipts in share row exclusive mode;
  lock table public.settlements in share row exclusive mode;
  select * into s from public.settlements where period_id::text=p_period_id
    order by calculated_at desc limit 1 for update;
  if s.id is null or s.id::text is distinct from 'settlement_'||p.start_date::text||'_current' then
    raise exception 'Existing CURRENT settlement required';
  end if;
  if s.payment_obligations_status is distinct from 'UNINITIALIZED' then
    raise exception 'Automatic reconciliation requires UNINITIALIZED payment obligations';
  end if;
  for item in select value from jsonb_array_elements(p_deletions) loop
    v_source_id:=nullif(btrim(item->>'source_message_id'),'');
    v_evidence_source:=item->>'evidence_source';
    v_group_identity_hash:=item->>'group_identity_hash';
    v_cycle_start_boundary_id:=nullif(btrim(item->>'cycle_start_boundary_id'),'');
    v_idempotency_key:=item->>'idempotency_key';
    begin detected_at:=(item->>'detected_at')::timestamptz;
    exception when others then raise exception 'Invalid WhatsApp deletion timestamp'; end;
    if v_source_id is null or length(v_source_id)>512 or v_source_id ~ '[[:space:]]' or
       v_evidence_source not in ('message_revoke_everyone','revoked_placeholder') or
       v_group_identity_hash !~ '^[0-9a-f]{64}$' or v_cycle_start_boundary_id is null or
       p.whatsapp_start_boundary->>'id' is distinct from v_cycle_start_boundary_id or
       v_idempotency_key is distinct from 'whatsapp-delete:'||v_source_id or detected_at is null then
      raise exception 'Invalid verified WhatsApp deletion evidence';
    end if;
    managed:=null; outcome:=null; previous:=null; current_source_state:=null; latest_audit:=null;
    select * into managed from public.instabox_managed_whatsapp_sources
      where source_message_id=v_source_id for update;
    if managed.source_message_id is not null and
       (managed.period_id<>p_period_id or managed.group_identity_hash<>v_group_identity_hash or
          managed.cycle_start_boundary_id<>v_cycle_start_boundary_id) then
      raise exception 'WhatsApp deletion source provenance conflicts with the selected period';
    end if;

    if managed.source_message_id is null then
      current_source_state:='unregistered';
    elsif managed.registration_status<>'active' then
      current_source_state:='registration_pending';
    elsif managed.source_kind='receipt' then
      select jsonb_build_object('id',r.id,'period_id',r.period_id,'amount_cents',r.amount_cents,
        'payer',r.payer,'is_excluded',r.is_excluded) into previous from public.receipts r
        where r.period_id::text=p_period_id and r.id::text=v_source_id
          and r.source_provider='whatsapp' and r.source_message_id=v_source_id for update;
      current_source_state:=case when previous is null then 'managed_receipt_missing' else 'managed_receipt_present' end;
    else
      select jsonb_build_object('id',e.id,'period_id',e.period_id,'review_status',e.review_status)
        into previous from public.whatsapp_bank_transfer_evidence e
        where e.period_id::text=p_period_id and e.id=v_source_id and e.source_message_id=v_source_id for update;
      current_source_state:=case
        when previous is null then 'managed_bank_missing'
        when previous->>'review_status'='pending' then 'managed_bank_pending'
        else 'managed_bank_reviewed' end;
    end if;

    select * into latest_audit from public.whatsapp_image_reconciliation_audit audit
      where audit.idempotency_key=v_idempotency_key
      order by audit.reconciled_at desc,audit.audit_id desc limit 1;
    if latest_audit.audit_id is not null then
      if latest_audit.period_id<>p_period_id or latest_audit.source_message_id<>v_source_id or
         latest_audit.group_identity_hash<>v_group_identity_hash or
         latest_audit.cycle_start_boundary_id<>v_cycle_start_boundary_id then
        raise exception 'WhatsApp deletion idempotency conflict';
      end if;
      if latest_audit.outcome in ('receipt_deleted','bank_evidence_deleted','protected_reviewed') or
         latest_audit.source_state=current_source_state or
         (latest_audit.outcome='protected_legacy' and current_source_state='registration_pending') then
        v_outcomes:=v_outcomes||jsonb_build_object(v_source_id,latest_audit.outcome);
        continue;
      end if;
      if latest_audit.outcome not in ('protected_legacy','not_found') or
         current_source_state not in ('managed_receipt_missing','managed_receipt_present','managed_bank_missing','managed_bank_pending','managed_bank_reviewed') or
         managed.activated_at is null or managed.activated_at<=latest_audit.reconciled_at then
        raise exception 'WhatsApp deletion source state changed without authoritative registration evidence';
      end if;
    end if;

    if current_source_state in ('unregistered','registration_pending') then
      outcome:='protected_legacy'; protected:=protected+1;
    elsif current_source_state in ('managed_receipt_missing','managed_bank_missing') then
      outcome:='not_found';
    elsif current_source_state='managed_receipt_present' then
      delete from public.receipts where period_id::text=p_period_id and id::text=v_source_id
        and source_provider='whatsapp' and source_message_id=v_source_id;
      outcome:='receipt_deleted'; changed_receipts:=changed_receipts+1;
    elsif current_source_state='managed_bank_reviewed' then
      outcome:='protected_reviewed'; protected:=protected+1;
    else
      delete from public.whatsapp_bank_transfer_evidence
        where period_id::text=p_period_id and id=v_source_id and source_message_id=v_source_id and review_status='pending';
      outcome:='bank_evidence_deleted'; changed_evidence:=changed_evidence+1;
    end if;
    insert into public.whatsapp_image_reconciliation_audit(
      idempotency_key,job_id,period_id,source_message_id,evidence_source,group_identity_hash,
      cycle_start_boundary_id,evidence_detected_at,outcome,source_state,previous_record
    ) values(v_idempotency_key,p_job_id,p_period_id,v_source_id,v_evidence_source,v_group_identity_hash,
      v_cycle_start_boundary_id,detected_at,outcome,current_source_state,previous);
    v_outcomes:=v_outcomes||jsonb_build_object(v_source_id,outcome);
  end loop;

  if changed_receipts>0 then
    if exists(select 1 from public.receipts where period_id::text=p_period_id and not is_excluded and
      (amount_cents is null or amount_cents<0 or payer is null or not(payer=any(p_members)))) then
      raise exception 'Existing receipt needs manual review; reconciliation rolled back';
    end if;
    select coalesce(sum(amount_cents),0),count(*) into total,count_receipts
      from public.receipts where period_id::text=p_period_id and not is_excluded;
    shares:=round(total::numeric/array_length(p_members,1));
    select jsonb_object_agg(member_name,coalesce((select sum(amount_cents) from public.receipts
      where period_id::text=p_period_id and not is_excluded and payer=member_name),0))
      into v_member_totals from unnest(p_members) member_name;
    update public.settlements set total_cents=total,per_person_cents=shares,
      member_totals=v_member_totals,receipt_count=count_receipts,calculated_at=now() where id=s.id;
    update public.periods set total_cents=total,per_person_cents=shares,receipt_count=count_receipts where id=p.id;
    -- settlements.owes, payment obligations, and verification fields are deliberately untouched.
  end if;
  return jsonb_build_object('receipts_deleted',changed_receipts,'bank_evidence_deleted',changed_evidence,
    'protected',protected,'outcomes',v_outcomes);
end $$;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',7,'writes_enabled',writes_enabled)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)
  from public,anon,authenticated;
grant execute on function public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)
  to service_role;
revoke all on function public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)
  to service_role;
revoke all on function public.register_instabox_whatsapp_receipt(),
  public.register_instabox_whatsapp_bank_evidence() from public,anon,authenticated;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
