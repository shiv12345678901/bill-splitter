alter table public.settlement_cycles
  add column if not exists period_start date,
  add column if not exists period_end date;

create or replace function public.settle_household_range(
  target_household uuid,
  date_from date,
  date_to date,
  transfer_summary jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_cycle_id uuid;
  cycle_total numeric(12,2);
  members_total integer;
begin
  if not public.is_household_admin(target_household) then
    raise exception 'Only an admin can settle the household';
  end if;
  if date_from is null or date_to is null or date_from > date_to then
    raise exception 'Choose a valid settlement date range';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_household::text, 0));
  select coalesce(sum(amount), 0) into cycle_total
    from public.expenses
    where household_id = target_household
      and settled = false
      and deleted_at is null
      and receipt_date between date_from and date_to;
  select count(*)::integer into members_total
    from public.household_members
    where household_id = target_household and left_at is null;
  if cycle_total <= 0 then raise exception 'There are no unsettled expenses in this date range'; end if;

  insert into public.settlement_cycles
    (household_id, created_by, total_amount, member_count, transfers, period_start, period_end)
  values
    (target_household, auth.uid(), cycle_total, members_total, coalesce(transfer_summary, '[]'::jsonb), date_from, date_to)
  returning id into new_cycle_id;

  update public.expenses
    set settled = true, settled_at = now(), settlement_cycle_id = new_cycle_id
    where household_id = target_household
      and settled = false
      and deleted_at is null
      and receipt_date between date_from and date_to;
  return new_cycle_id;
end;
$$;

grant execute on function public.settle_household_range(uuid, date, date, jsonb) to authenticated;

create index if not exists expenses_unsettled_date_idx
  on public.expenses (household_id, receipt_date)
  where settled = false and deleted_at is null;

create or replace function public.settle_household(target_household uuid, transfer_summary jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_cycle_id uuid;
  cycle_total numeric(12,2);
  members_total integer;
begin
  if not public.is_household_admin(target_household) then raise exception 'Only an admin can settle the household'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_household::text, 0));
  select coalesce(sum(amount), 0) into cycle_total from public.expenses
    where household_id = target_household and settled = false and deleted_at is null;
  select count(*)::integer into members_total from public.household_members
    where household_id = target_household and left_at is null;
  if cycle_total <= 0 then raise exception 'There are no expenses to settle'; end if;
  insert into public.settlement_cycles (household_id, created_by, total_amount, member_count, transfers)
  values (target_household, auth.uid(), cycle_total, members_total, coalesce(transfer_summary, '[]'::jsonb))
  returning id into new_cycle_id;
  update public.expenses set settled = true, settled_at = now(), settlement_cycle_id = new_cycle_id
    where household_id = target_household and settled = false and deleted_at is null;
  return new_cycle_id;
end;
$$;
