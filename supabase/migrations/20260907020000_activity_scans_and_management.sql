-- SplitMate reliability and household-management upgrade.
alter table public.expenses add column if not exists notes text;
alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses drop constraint if exists expenses_notes_length_check;
alter table public.expenses add constraint expenses_notes_length_check check (notes is null or char_length(notes) <= 300);
alter table public.households add column if not exists invite_version integer not null default 1;
alter table public.household_members add column if not exists left_at timestamptz;
alter table public.household_members drop constraint if exists household_members_user_id_key;
create unique index if not exists one_active_household_per_user on public.household_members (user_id) where left_at is null;

create or replace function public.is_household_member(target_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members where household_id = target_household and user_id = auth.uid() and left_at is null);
$$;

create or replace function public.create_household(household_name text, member_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_household_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if exists (select 1 from public.household_members where user_id = auth.uid() and left_at is null) then raise exception 'You already belong to a household'; end if;
  insert into public.households (created_by, name) values (auth.uid(), trim(household_name)) returning id into new_household_id;
  insert into public.household_members (household_id, user_id, name, color) values (new_household_id, auth.uid(), trim(member_name), '#d8ff7e');
  return new_household_id;
end $$;

create or replace function public.join_household(code text, member_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_id uuid; declare prior_member uuid;
declare palette text[] := array['#ffb88b','#8fdcff','#d6b8ff','#ffd76a','#89e5c2','#ff9bb7']; declare member_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if exists (select 1 from public.household_members where user_id = auth.uid() and left_at is null) then raise exception 'You already belong to a household'; end if;
  select id into target_id from public.households where join_code = upper(trim(code));
  if target_id is null then raise exception 'Household code not found'; end if;
  select id into prior_member from public.household_members where household_id = target_id and user_id = auth.uid();
  if prior_member is not null then update public.household_members set left_at = null, name = trim(member_name) where id = prior_member;
  else
    select count(*)::integer into member_count from public.household_members where household_id = target_id and left_at is null;
    insert into public.household_members (household_id, user_id, name, color) values (target_id, auth.uid(), trim(member_name), palette[(member_count % array_length(palette, 1)) + 1]);
  end if;
  return target_id;
end $$;

create table if not exists public.household_categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 30),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (household_id, name)
);

create table if not exists public.receipt_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  image_path text not null unique,
  status text not null default 'queued' check (status in ('queued','processing','complete','failed')),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.household_activity (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  actor_name text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  summary text not null,
  created_at timestamptz not null default now()
);

create or replace function public.log_expense_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare action_name text;
declare activity_summary text;
declare member_name text;
begin
  select name into member_name from public.household_members
    where household_id = coalesce(new.household_id, old.household_id)
      and user_id = coalesce(auth.uid(), new.user_id, old.user_id) limit 1;
  if tg_op = 'INSERT' then
    action_name := 'created'; activity_summary := 'added ' || coalesce(new.merchant, 'a receipt');
  elsif old.deleted_at is null and new.deleted_at is not null then
    action_name := 'deleted'; activity_summary := 'deleted ' || coalesce(old.merchant, 'a receipt');
  elsif old.deleted_at is not null and new.deleted_at is null then
    action_name := 'restored'; activity_summary := 'restored ' || coalesce(new.merchant, 'a receipt');
  elsif row(old.merchant, old.amount, old.category, old.receipt_date, old.payer_member_id, old.notes)
     is distinct from row(new.merchant, new.amount, new.category, new.receipt_date, new.payer_member_id, new.notes) then
    action_name := 'updated'; activity_summary := 'updated ' || coalesce(new.merchant, 'a receipt');
  else return new;
  end if;
  insert into public.household_activity (household_id, actor_id, actor_name, action, entity_type, entity_id, summary)
  values (coalesce(new.household_id, old.household_id), coalesce(auth.uid(), new.user_id, old.user_id), member_name, action_name, 'expense', coalesce(new.id, old.id), activity_summary);
  return new;
end;
$$;

drop trigger if exists expense_activity_trigger on public.expenses;
create trigger expense_activity_trigger after insert or update on public.expenses
for each row execute function public.log_expense_activity();

create or replace function public.log_household_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare member_name text;
begin
  if tg_table_name = 'household_members' then
    insert into public.household_activity (household_id, actor_id, actor_name, action, entity_type, entity_id, summary)
    values (new.household_id, new.user_id, new.name, 'joined', 'member', new.id, 'joined the household');
  else
    select name into member_name from public.household_members where household_id = new.household_id and user_id = new.created_by limit 1;
    insert into public.household_activity (household_id, actor_id, actor_name, action, entity_type, entity_id, summary)
    values (new.household_id, new.created_by, member_name, 'settled', 'settlement', new.id, 'completed a settlement');
  end if;
  return new;
end $$;

drop trigger if exists member_join_activity_trigger on public.household_members;
create trigger member_join_activity_trigger after insert on public.household_members for each row execute function public.log_household_event();
drop trigger if exists settlement_activity_trigger on public.settlement_cycles;
create trigger settlement_activity_trigger after insert on public.settlement_cycles for each row execute function public.log_household_event();

create or replace function public.rename_household(target_household uuid, new_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.households where id = target_household and created_by = auth.uid()) then raise exception 'Only the household owner can rename it'; end if;
  if char_length(trim(new_name)) not between 1 and 60 then raise exception 'Enter a household name'; end if;
  update public.households set name = trim(new_name) where id = target_household;
  insert into public.household_activity (household_id, actor_id, action, entity_type, entity_id, summary)
  values (target_household, auth.uid(), 'renamed', 'household', target_household, 'renamed the household to ' || trim(new_name));
end $$;

create or replace function public.rename_self(target_member uuid, new_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare target_household uuid;
begin
  if char_length(trim(new_name)) not between 1 and 50 then raise exception 'Enter your name'; end if;
  update public.household_members set name = trim(new_name) where id = target_member and user_id = auth.uid() returning household_id into target_household;
  if target_household is null then raise exception 'Member not found'; end if;
  insert into public.household_activity (household_id, actor_id, actor_name, action, entity_type, entity_id, summary)
  values (target_household, auth.uid(), trim(new_name), 'renamed', 'member', target_member, 'changed their display name');
end $$;

create or replace function public.regenerate_household_invite(target_household uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare new_code text;
begin
  if not exists (select 1 from public.households where id = target_household and created_by = auth.uid()) then raise exception 'Only the household owner can change the invite'; end if;
  new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update public.households set join_code = new_code, invite_version = invite_version + 1 where id = target_household;
  return new_code;
end $$;

create or replace function public.remove_household_member(target_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_household uuid; declare removed_name text;
begin
  select household_id, name into target_household, removed_name from public.household_members where id = target_member;
  if not exists (select 1 from public.households where id = target_household and created_by = auth.uid()) then raise exception 'Only the household owner can remove members'; end if;
  if exists (select 1 from public.household_members where id = target_member and user_id = auth.uid()) then raise exception 'Use Leave household instead'; end if;
  if exists (select 1 from public.expenses where payer_member_id = target_member and settled = false and deleted_at is null) then raise exception 'Settle current expenses before removing this member'; end if;
  update public.household_members set left_at = now() where id = target_member;
  insert into public.household_activity (household_id, actor_id, action, entity_type, entity_id, summary)
  values (target_household, auth.uid(), 'removed', 'member', target_member, 'removed ' || coalesce(removed_name, 'a member'));
end $$;

create or replace function public.leave_household(target_household uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare target_member uuid; declare member_total integer; declare is_owner boolean;
begin
  select id into target_member from public.household_members where household_id = target_household and user_id = auth.uid();
  if target_member is null then raise exception 'Membership not found'; end if;
  select count(*)::integer into member_total from public.household_members where household_id = target_household and left_at is null;
  select created_by = auth.uid() into is_owner from public.households where id = target_household;
  if is_owner and member_total > 1 then raise exception 'The owner cannot leave while other members remain'; end if;
  if exists (select 1 from public.expenses where payer_member_id = target_member and settled = false and deleted_at is null) then raise exception 'Settle current expenses before leaving'; end if;
  if is_owner then delete from public.households where id = target_household;
  else update public.household_members set left_at = now() where id = target_member;
  end if;
end $$;

alter table public.household_categories enable row level security;
alter table public.receipt_scan_jobs enable row level security;
alter table public.household_activity enable row level security;

drop policy if exists "Members can read categories" on public.household_categories;
drop policy if exists "Members can add categories" on public.household_categories;
drop policy if exists "Members can delete categories" on public.household_categories;
drop policy if exists "Users can read scan jobs" on public.receipt_scan_jobs;
drop policy if exists "Users can create scan jobs" on public.receipt_scan_jobs;
drop policy if exists "Users can delete scan jobs" on public.receipt_scan_jobs;
drop policy if exists "Members can read activity" on public.household_activity;
create policy "Members can read categories" on public.household_categories for select using (public.is_household_member(household_id));
create policy "Members can add categories" on public.household_categories for insert with check (public.is_household_member(household_id) and created_by = auth.uid());
create policy "Members can delete categories" on public.household_categories for delete using (public.is_household_member(household_id));
create policy "Users can read scan jobs" on public.receipt_scan_jobs for select using (user_id = auth.uid() and public.is_household_member(household_id));
create policy "Users can create scan jobs" on public.receipt_scan_jobs for insert with check (user_id = auth.uid() and public.is_household_member(household_id));
create policy "Users can delete scan jobs" on public.receipt_scan_jobs for delete using (user_id = auth.uid());
create policy "Members can read activity" on public.household_activity for select using (public.is_household_member(household_id));

drop policy if exists "Users can upload their receipt images" on storage.objects;
create policy "Users can upload their receipt images" on storage.objects for insert
  with check (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
drop policy if exists "Users can read scan job images" on storage.objects;
create policy "Users can read scan job images" on storage.objects for select
  using (bucket_id = 'receipts' and exists (select 1 from public.receipt_scan_jobs where image_path = name and user_id = auth.uid()));

create index if not exists activity_household_created_idx on public.household_activity (household_id, created_at desc);
create index if not exists scan_jobs_user_created_idx on public.receipt_scan_jobs (user_id, created_at desc);

grant execute on function public.rename_household(uuid, text) to authenticated;
grant execute on function public.rename_self(uuid, text) to authenticated;
grant execute on function public.regenerate_household_invite(uuid) to authenticated;
grant execute on function public.remove_household_member(uuid) to authenticated;
grant execute on function public.leave_household(uuid) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'receipt_scan_jobs') then alter publication supabase_realtime add table public.receipt_scan_jobs; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'household_activity') then alter publication supabase_realtime add table public.household_activity; end if;
end $$;
