-- Allow a verified WhatsApp marker to establish a previously-null period end
-- date inside the capability-v8 rollover transaction. This migration does not
-- enable writes, alter financial records, or change the capability contract.
begin;

create or replace function public.rollover_settlement_period(
  p_job_id uuid,p_worker_id text,p_old_period_id text,p_old_end_date date,p_clearance_message jsonb,
  p_new_period_id text,p_new_settlement_id text,p_new_start_date date,p_start_boundary jsonb,
  p_new_cycle_status text,p_calculation_message jsonb,p_members text[],p_membership_revision bigint
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  fixed_members constant text[]:=array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'];
  j public.sync_requests;
  old_period public.periods;
  new_period public.periods;
  old_settlement public.settlements;
  closed_status text;
  closed_status_count integer;
  current_revision bigint;
  clearance_epoch bigint;
  clearance_instant timestamptz;
  clearance_date date;
  old_start_epoch bigint;
  v_group_identity_hash text;
  v_cycle_start_boundary_id text;
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

  select revision into current_revision
    from public.settlement_cycle_membership_state where period_id=p_old_period_id for update;
  if current_revision is distinct from p_membership_revision then
    raise exception 'STALE_MEMBERSHIP_REVISION';
  end if;
  if coalesce(array_length(p_members,1),0)<>4 or
    (select count(distinct member_name) from unnest(p_members) member_name)<>4 or
    exists(select 1 from unnest(p_members) member_name where not(member_name=any(fixed_members))) then
    raise exception 'Four reviewed household members are required';
  end if;

  if p_clearance_message is null or length(coalesce(p_clearance_message->>'id','')) not between 1 and 512 or
    p_clearance_message->>'source'<>'marker' or p_clearance_message->>'confidence'<>'HIGH' or
    coalesce(p_clearance_message->>'timestamp','')!~'^[0-9]{1,10}$' then
    raise exception 'A verified explicit clearance marker is required';
  end if;
  clearance_epoch:=(p_clearance_message->>'timestamp')::bigint;
  if clearance_epoch<=0 then raise exception 'The clearance marker timestamp is invalid'; end if;
  clearance_instant:=to_timestamp(clearance_epoch::double precision);
  clearance_date:=(clearance_instant at time zone 'Australia/Sydney')::date;
  if p_old_end_date is distinct from clearance_date or
    p_clearance_message->>'dateStr' is distinct from clearance_date::text then
    raise exception 'The verified Sydney clearance date is inconsistent';
  end if;
  v_group_identity_hash:=p_clearance_message->>'group_identity_hash';
  v_cycle_start_boundary_id:=p_clearance_message->>'cycle_start_boundary_id';
  if v_group_identity_hash is null or v_group_identity_hash!~'^[0-9a-f]{64}$' or
    coalesce(v_cycle_start_boundary_id,'')='' then
    raise exception 'The clearance marker has invalid WhatsApp provenance';
  end if;

  if p_start_boundary is null or p_start_boundary->>'id' is distinct from p_clearance_message->>'id' or
    p_start_boundary->>'timestamp' is distinct from p_clearance_message->>'timestamp' or
    p_start_boundary->>'dateStr' is distinct from p_clearance_message->>'dateStr' or
    p_start_boundary->>'source'<>'marker' or p_start_boundary->>'confidence'<>'HIGH' or
    p_start_boundary->>'group_identity_hash' is distinct from v_group_identity_hash then
    raise exception 'The next cycle must start at the verified clearance marker';
  end if;
  if p_new_start_date is distinct from
    (to_timestamp((clearance_epoch+1)::double precision) at time zone 'Australia/Sydney')::date then
    raise exception 'The new cycle start date does not match the clearance boundary instant';
  end if;
  if p_new_period_id is distinct from 'period_'||p_new_start_date::text or
    p_new_settlement_id is distinct from 'settlement_'||p_new_start_date::text||'_current' then
    raise exception 'Unexpected deterministic period or settlement ID';
  end if;
  if p_new_cycle_status not in ('ACTIVE','PENDING_SETTLEMENT') or
    (p_new_cycle_status='ACTIVE' and p_calculation_message is not null) or
    (p_new_cycle_status='PENDING_SETTLEMENT' and
      (p_calculation_message is null or coalesce(p_calculation_message->>'id','')='')) then
    raise exception 'Invalid next-cycle state';
  end if;

  if clearance_instant <
      (select automatic_rollover_after from public.instabox_worker_control where singleton)
    and not exists(
      select 1 from public.instabox_rollover_approvals
      where old_period_id=p_old_period_id
        and clearance_message_id=p_clearance_message->>'id'
        and new_period_id=p_new_period_id
    ) then
    raise exception 'Historical rollover requires an explicitly reviewed approval';
  end if;

  select count(distinct status),min(status) into closed_status_count,closed_status
    from public.periods where status<>'CURRENT';
  if closed_status_count<>1 then
    raise exception 'Cannot infer one verified historical period status convention';
  end if;

  select * into old_period from public.periods where id=p_old_period_id for update;
  select * into new_period from public.periods where id=p_new_period_id for update;
  if old_period.id is null then raise exception 'Existing period not found'; end if;

  -- Replays after a committed response was lost are read-only and deterministic.
  if old_period.status=closed_status and old_period.end_date=clearance_date and
    old_period.whatsapp_clearance_message->>'id'=p_clearance_message->>'id' and
    new_period.id is not null and new_period.status='CURRENT' and
    new_period.start_date=p_new_start_date and
    new_period.whatsapp_start_boundary->>'id'=p_start_boundary->>'id' and
    new_period.whatsapp_start_boundary->>'timestamp'=p_start_boundary->>'timestamp' then
    return jsonb_build_object('period_id',new_period.id,'replayed',true,'membership_revision',1);
  end if;

  if old_period.status<>'CURRENT' then raise exception 'Expected old CURRENT period'; end if;
  if old_period.whatsapp_cycle_status not in ('ACTIVE','PENDING_SETTLEMENT') then
    raise exception 'Stored cycle state conflicts with verified closure';
  end if;
  if old_period.end_date is not null and old_period.end_date is distinct from clearance_date then
    raise exception 'Stored period end date conflicts with verified clearance date';
  end if;
  if old_period.start_date>clearance_date then
    raise exception 'The clearance marker predates the CURRENT period';
  end if;
  if old_period.whatsapp_start_boundary is null or
    old_period.whatsapp_start_boundary->>'id' is distinct from v_cycle_start_boundary_id or
    coalesce(old_period.whatsapp_start_boundary->>'timestamp','')!~'^[0-9]{1,10}$' then
    raise exception 'The CURRENT period has an invalid immutable cycle-start boundary';
  end if;
  old_start_epoch:=(old_period.whatsapp_start_boundary->>'timestamp')::bigint;
  if clearance_epoch<=old_start_epoch then
    raise exception 'The clearance marker must be after the CURRENT cycle start boundary';
  end if;
  if old_period.whatsapp_clearance_message is not null and
    old_period.whatsapp_clearance_message->>'id' is distinct from p_clearance_message->>'id' then
    raise exception 'The CURRENT period already has conflicting clearance evidence';
  end if;
  if exists(select 1 from public.periods where status='CURRENT' and id<>old_period.id) then
    raise exception 'Multiple CURRENT periods require manual reconciliation';
  end if;
  if new_period.id is not null then raise exception 'Target period ID already exists'; end if;
  if exists(select 1 from public.receipts where period_id=old_period.id and
      (captured_at is null or captured_at>clearance_instant or date>clearance_date)) then
    raise exception 'The old period already contains receipts after clearance';
  end if;
  if exists(select 1 from public.instabox_managed_whatsapp_sources
      where period_id=old_period.id and registration_status in ('pending','active') and
        (instabox_managed_whatsapp_sources.group_identity_hash<>v_group_identity_hash or
         instabox_managed_whatsapp_sources.cycle_start_boundary_id<>v_cycle_start_boundary_id)) then
    raise exception 'The clearance marker conflicts with registered WhatsApp provenance';
  end if;
  select * into old_settlement from public.settlements where period_id=old_period.id
    order by calculated_at desc limit 1 for update;
  if old_settlement.id is null then raise exception 'The old period has no settlement to preserve'; end if;
  if exists(select 1 from public.settlements where id=p_new_settlement_id or period_id=p_new_period_id) then
    raise exception 'Target settlement already exists';
  end if;

  select jsonb_object_agg(member_name,0) into zero_member_totals from unnest(fixed_members) member_name;

  update public.periods set end_date=clearance_date,status=closed_status,
    whatsapp_cycle_status='SETTLED',whatsapp_clearance_message=p_clearance_message,
    whatsapp_cycle_updated_at=now() where id=old_period.id;

  insert into public.periods(
    id,start_date,end_date,status,total_cents,per_person_cents,receipt_count,
    whatsapp_cycle_status,whatsapp_calculation_message,whatsapp_clearance_message,
    whatsapp_cycle_updated_at,whatsapp_start_boundary
  ) values(
    p_new_period_id,p_new_start_date,null,'CURRENT',0,0,0,
    p_new_cycle_status,p_calculation_message,null,now(),p_start_boundary
  );

  insert into public.settlements(
    id,period_id,total_cents,per_person_cents,member_totals,receipt_count,
    calculated_at,owes,payment_obligations_status
  ) values(
    p_new_settlement_id,p_new_period_id,0,0,zero_member_totals,0,
    now(),null,'UNINITIALIZED'
  );

  insert into public.settlement_cycle_membership_state(period_id,revision)
    values(p_new_period_id,1);
  insert into public.settlement_cycle_members(period_id,member_name,participation_mode)
    select p_new_period_id,member_name,'enabled' from unnest(fixed_members) member_name;
  if (select count(*) from public.settlement_cycle_members
      where period_id=p_new_period_id and participation_mode='enabled')<>4 then
    raise exception 'New cycle membership initialization conflict';
  end if;

  return jsonb_build_object('period_id',p_new_period_id,'replayed',false,'membership_revision',1);
end $$;

revoke all on function public.rollover_settlement_period(
  uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[],bigint
) from public,anon,authenticated;
grant execute on function public.rollover_settlement_period(
  uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[],bigint
) to service_role;

commit;
