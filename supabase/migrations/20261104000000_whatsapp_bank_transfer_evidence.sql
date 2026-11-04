-- REVIEW AGAINST A FRESH PRODUCTION SCHEMA EXPORT BEFORE APPLYING.
-- Adds a separate store for automatically classified WhatsApp bank-transfer
-- evidence. It does not create payment-step relationships, verify payments,
-- or update receipts, periods, settlements, obligations, or settlements.owes.
begin;

create table if not exists public.whatsapp_bank_transfer_evidence (
  id text primary key,
  period_id text not null references public.periods(id),
  source_message_id text not null unique,
  captured_at timestamptz not null,
  sender_name text not null,
  recipient_name text,
  amount_cents integer check(amount_cents is null or amount_cents>=0),
  transfer_date date,
  reference_number text,
  evidence_url text not null,
  classification text not null default 'bank_transfer' check(classification='bank_transfer'),
  review_status text not null default 'pending' check(review_status in ('pending','reviewed','dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_bank_transfer_evidence_period_idx
  on public.whatsapp_bank_transfer_evidence(period_id,captured_at desc);

alter table public.whatsapp_bank_transfer_evidence enable row level security;
revoke all on public.whatsapp_bank_transfer_evidence from public,anon;
grant select on public.whatsapp_bank_transfer_evidence to authenticated,service_role;
drop policy if exists instabox_whatsapp_bank_evidence_read on public.whatsapp_bank_transfer_evidence;
create policy instabox_whatsapp_bank_evidence_read
  on public.whatsapp_bank_transfer_evidence for select to authenticated using(true);

create or replace function public.record_whatsapp_bank_evidence(
  p_job_id uuid,
  p_worker_id text,
  p_period_id text,
  p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  j public.sync_requests;
  p public.periods;
  item jsonb;
  inserted integer:=0;
  affected integer;
  evidence_id text;
  evidence_period text;
  evidence_captured_at timestamptz;
  evidence_transfer_date date;
  evidence_amount integer;
begin
  perform pg_advisory_xact_lock(17498013);
  if not exists(select 1 from public.instabox_worker_control where singleton and writes_enabled) then
    raise exception 'Production writes disabled';
  end if;
  select * into j from public.sync_requests where id=p_job_id for update;
  if j.id is null or j.status<>'processing' or j.worker_id is distinct from p_worker_id or
     j.lease_expires_at is null or j.lease_expires_at<=now() then raise exception 'Lost job lease'; end if;
  select * into p from public.periods where id::text=p_period_id for share;
  if p.id is null or p.status<>'CURRENT' then raise exception 'Bank evidence requires the CURRENT period'; end if;
  if jsonb_typeof(p_evidence)<>'array' then raise exception 'Bank evidence array required'; end if;

  for item in select value from jsonb_array_elements(p_evidence) loop
    evidence_id:=nullif(btrim(item->>'id'),'');
    evidence_period:=item->>'period_id';
    begin evidence_captured_at:=(item->>'captured_at')::timestamptz;
    exception when others then raise exception 'Invalid bank evidence timestamp'; end;
    begin evidence_transfer_date:=nullif(item->>'transfer_date','')::date;
    exception when others then raise exception 'Invalid bank evidence transfer date'; end;
    begin evidence_amount:=nullif(item->>'amount_cents','')::integer;
    exception when others then raise exception 'Invalid bank evidence amount'; end;

    if evidence_id is null or evidence_period is distinct from p_period_id or
       item->>'source_message_id' is distinct from evidence_id or
       nullif(btrim(item->>'sender_name'),'') is null or
       nullif(btrim(item->>'evidence_url'),'') is null or
       item->>'evidence_url' not like 'storage://bill-evidence/%' or
       item->>'classification' is distinct from 'bank_transfer' or
       item->>'review_status' is distinct from 'pending' or
       evidence_amount<0 or
       (to_timestamp(extract(epoch from evidence_captured_at)) at time zone 'Australia/Sydney')::date<p.start_date or
       (p.end_date is not null and (to_timestamp(extract(epoch from evidence_captured_at)) at time zone 'Australia/Sydney')::date>p.end_date) or
       (evidence_transfer_date is not null and
         (evidence_transfer_date<p.start_date or (p.end_date is not null and evidence_transfer_date>p.end_date))) then
      raise exception 'Invalid WhatsApp bank-transfer evidence';
    end if;
    if exists(select 1 from public.whatsapp_bank_transfer_evidence where id=evidence_id and period_id::text<>p_period_id) then
      raise exception 'Bank evidence belongs to another period';
    end if;
    insert into public.whatsapp_bank_transfer_evidence(
      id,period_id,source_message_id,captured_at,sender_name,recipient_name,
      amount_cents,transfer_date,reference_number,evidence_url,classification,review_status
    ) values(
      evidence_id,evidence_period,evidence_id,evidence_captured_at,item->>'sender_name',
      nullif(btrim(item->>'recipient_name'),''),evidence_amount,evidence_transfer_date,
      nullif(btrim(item->>'reference_number'),''),item->>'evidence_url','bank_transfer','pending'
    ) on conflict do nothing;
    get diagnostics affected=row_count;
    inserted:=inserted+affected;
    if affected=0 and not exists(
      select 1 from public.whatsapp_bank_transfer_evidence
      where id=evidence_id and period_id::text=p_period_id and source_message_id=evidence_id
    ) then raise exception 'Bank evidence source identity conflicts with another row'; end if;
  end loop;
  return jsonb_build_object('inserted',inserted,'total',jsonb_array_length(p_evidence));
end $$;

create or replace function public.instabox_worker_capabilities()
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('version',6,'writes_enabled',writes_enabled)
  from public.instabox_worker_control where singleton;
$$;

revoke all on function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
  to service_role;
revoke all on function public.instabox_worker_capabilities() from public,anon,authenticated;
grant execute on function public.instabox_worker_capabilities() to service_role;

commit;
