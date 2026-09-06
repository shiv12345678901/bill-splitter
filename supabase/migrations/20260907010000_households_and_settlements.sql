-- SplitMate household upgrade. Safe to run after the two earlier migrations.
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  name text not null check (char_length(name) between 1 and 60),
  join_code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
);

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 50),
  color text not null default '#d8ff7e',
  joined_at timestamptz not null default now(),
  unique (user_id),
  unique (household_id, user_id)
);

create or replace function public.is_household_member(target_household uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members
    where household_id = target_household and user_id = auth.uid()
  );
$$;

create or replace function public.create_household(household_name text, member_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare new_household_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if exists (select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'You already belong to a household';
  end if;
  insert into public.households (created_by, name)
  values (auth.uid(), trim(household_name)) returning id into new_household_id;
  insert into public.household_members (household_id, user_id, name, color)
  values (new_household_id, auth.uid(), trim(member_name), '#d8ff7e');
  return new_household_id;
end;
$$;

create or replace function public.join_household(code text, member_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare target_id uuid;
declare palette text[] := array['#ffb88b','#8fdcff','#d6b8ff','#ffd76a','#89e5c2','#ff9bb7'];
declare member_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if exists (select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'You already belong to a household';
  end if;
  select id into target_id from public.households where join_code = upper(trim(code));
  if target_id is null then raise exception 'Household code not found'; end if;
  select count(*)::integer into member_count from public.household_members where household_id = target_id;
  insert into public.household_members (household_id, user_id, name, color)
  values (target_id, auth.uid(), trim(member_name), palette[(member_count % array_length(palette, 1)) + 1]);
  return target_id;
end;
$$;

alter table public.expenses add column if not exists household_id uuid references public.households(id) on delete cascade;
alter table public.expenses add column if not exists payer_member_id uuid references public.household_members(id) on delete restrict;
alter table public.expenses add column if not exists settled_at timestamptz;
alter table public.expenses add column if not exists deleted_at timestamptz;
alter table public.expenses drop constraint if exists expenses_payer_check;

-- Preserve existing receipts by creating one private household per existing account.
do $$
declare owner record;
declare target_household uuid;
declare target_member uuid;
begin
  for owner in select distinct user_id from public.expenses where household_id is null loop
    select id, household_id into target_member, target_household
    from public.household_members where user_id = owner.user_id limit 1;
    if target_household is null then
      insert into public.households (created_by, name)
      values (owner.user_id, 'My Household') returning id into target_household;
      insert into public.household_members (household_id, user_id, name)
      values (target_household, owner.user_id, 'Me') returning id into target_member;
    end if;
    update public.expenses
      set household_id = target_household, payer_member_id = target_member
      where user_id = owner.user_id and household_id is null;
  end loop;
end $$;

create table if not exists public.settlement_cycles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  settled_at timestamptz not null default now(),
  total_amount numeric(12,2) not null check (total_amount >= 0),
  member_count integer not null check (member_count > 0),
  transfers jsonb not null default '[]'::jsonb
);

alter table public.expenses add column if not exists settlement_cycle_id uuid references public.settlement_cycles(id) on delete set null;

create or replace function public.settle_household(target_household uuid, transfer_summary jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare new_cycle_id uuid;
declare cycle_total numeric(12,2);
declare members_total integer;
begin
  if not public.is_household_member(target_household) then raise exception 'Household access denied'; end if;
  select coalesce(sum(amount), 0) into cycle_total from public.expenses
    where household_id = target_household and settled = false and deleted_at is null;
  select count(*)::integer into members_total from public.household_members where household_id = target_household;
  if cycle_total <= 0 then raise exception 'There are no expenses to settle'; end if;
  insert into public.settlement_cycles (household_id, created_by, total_amount, member_count, transfers)
  values (target_household, auth.uid(), cycle_total, members_total, coalesce(transfer_summary, '[]'::jsonb))
  returning id into new_cycle_id;
  update public.expenses set settled = true, settled_at = now(), settlement_cycle_id = new_cycle_id
    where household_id = target_household and settled = false and deleted_at is null;
  return new_cycle_id;
end;
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.settlement_cycles enable row level security;

drop policy if exists "Members can read their household" on public.households;
create policy "Members can read their household" on public.households for select
  using (public.is_household_member(id));
drop policy if exists "Members can read household members" on public.household_members;
create policy "Members can read household members" on public.household_members for select
  using (public.is_household_member(household_id));
drop policy if exists "Members can update themselves" on public.household_members;
drop policy if exists "Members can read settlement history" on public.settlement_cycles;
create policy "Members can read settlement history" on public.settlement_cycles for select
  using (public.is_household_member(household_id));

drop policy if exists "Users can read their expenses" on public.expenses;
drop policy if exists "Users can add their expenses" on public.expenses;
drop policy if exists "Users can update their expenses" on public.expenses;
drop policy if exists "Users can delete their expenses" on public.expenses;
drop policy if exists "Household members can read expenses" on public.expenses;
drop policy if exists "Household members can add expenses" on public.expenses;
drop policy if exists "Household members can update expenses" on public.expenses;
drop policy if exists "Household members can delete expenses" on public.expenses;
create policy "Household members can read expenses" on public.expenses for select
  using (public.is_household_member(household_id));
create policy "Household members can add expenses" on public.expenses for insert
  with check (public.is_household_member(household_id) and auth.uid() = user_id);
create policy "Household members can update expenses" on public.expenses for update
  using (public.is_household_member(household_id)) with check (public.is_household_member(household_id));
create policy "Household members can delete expenses" on public.expenses for delete
  using (public.is_household_member(household_id));

drop policy if exists "Users can read their receipt images" on storage.objects;
drop policy if exists "Users can delete their receipt images" on storage.objects;
drop policy if exists "Household members can read receipt images" on storage.objects;
drop policy if exists "Household members can delete receipt images" on storage.objects;
create policy "Household members can read receipt images" on storage.objects for select
  using (
    bucket_id = 'receipts' and exists (
      select 1 from public.expenses
      where image_path = name and public.is_household_member(household_id)
    )
  );
create policy "Household members can delete receipt images" on storage.objects for delete
  using (
    bucket_id = 'receipts' and (
      auth.uid()::text = (storage.foldername(name))[1] or exists (
        select 1 from public.expenses
        where image_path = name and public.is_household_member(household_id)
      )
    )
  );

create index if not exists expenses_household_status_idx
  on public.expenses (household_id, settled, deleted_at, receipt_date desc);
create index if not exists household_members_household_idx on public.household_members (household_id);
create index if not exists settlement_cycles_household_idx on public.settlement_cycles (household_id, settled_at desc);

grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.settle_household(uuid, jsonb) to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'household_members') then
    alter publication supabase_realtime add table public.household_members;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'settlement_cycles') then
    alter publication supabase_realtime add table public.settlement_cycles;
  end if;
end $$;
