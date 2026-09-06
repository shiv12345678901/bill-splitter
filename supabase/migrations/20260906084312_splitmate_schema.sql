create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  payer text not null,
  merchant text not null,
  amount numeric(10,2) not null,
  category text not null default 'Other',
  image_path text,
  settled boolean not null default false
);

-- Upgrade the original SplitMate table without deleting existing receipts.
alter table public.expenses add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();
alter table public.expenses add column if not exists image_path text;
alter table public.expenses alter column user_id set default auth.uid();
alter table public.expenses alter column category set default 'Other';
alter table public.expenses alter column settled set default false;

update public.expenses set payer = case payer
  when 'Member 1' then 'Alex'
  when 'Member 2' then 'Sam'
  when 'Member 3' then 'Jordan'
  when 'Member 4' then 'Taylor'
  else payer end
where payer in ('Member 1', 'Member 2', 'Member 3', 'Member 4');

update public.expenses set category = 'Household'
where category = 'Household Supplies';

alter table public.expenses drop constraint if exists expenses_payer_check;
alter table public.expenses add constraint expenses_payer_check
  check (payer in ('Alex', 'Sam', 'Jordan', 'Taylor'));
alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses add constraint expenses_category_check
  check (category in ('Groceries', 'Utilities', 'Household', 'Dining', 'Other'));
alter table public.expenses drop constraint if exists expenses_amount_check;
alter table public.expenses add constraint expenses_amount_check check (amount > 0);

create index if not exists expenses_user_cycle_idx
  on public.expenses (user_id, settled, created_at desc);

alter table public.expenses enable row level security;

drop policy if exists "Users can read their expenses" on public.expenses;
drop policy if exists "Users can add their expenses" on public.expenses;
drop policy if exists "Users can update their expenses" on public.expenses;
drop policy if exists "Users can delete their expenses" on public.expenses;

create policy "Users can read their expenses" on public.expenses
  for select using (auth.uid() = user_id);
create policy "Users can add their expenses" on public.expenses
  for insert with check (auth.uid() = user_id);
create policy "Users can update their expenses" on public.expenses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their expenses" on public.expenses
  for delete using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their receipt images" on storage.objects;
drop policy if exists "Users can upload their receipt images" on storage.objects;
drop policy if exists "Users can update their receipt images" on storage.objects;
drop policy if exists "Users can delete their receipt images" on storage.objects;

create policy "Users can read their receipt images" on storage.objects
  for select using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can upload their receipt images" on storage.objects
  for insert with check (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can update their receipt images" on storage.objects
  for update using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can delete their receipt images" on storage.objects
  for delete using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'expenses'
  ) then
    alter publication supabase_realtime add table public.expenses;
  end if;
end $$;
