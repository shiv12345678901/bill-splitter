create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  payer text not null check (payer in ('Alex', 'Sam', 'Jordan', 'Taylor')),
  merchant text not null,
  amount numeric(10,2) not null check (amount > 0),
  category text not null default 'Other' check (category in ('Groceries', 'Utilities', 'Household', 'Dining', 'Other')),
  image_path text,
  settled boolean not null default false
);

create index expenses_user_cycle_idx on public.expenses (user_id, settled, created_at desc);

alter table public.expenses enable row level security;

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
on conflict (id) do nothing;

create policy "Users can read their receipt images" on storage.objects
  for select using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can upload their receipt images" on storage.objects
  for insert with check (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can update their receipt images" on storage.objects
  for update using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "Users can delete their receipt images" on storage.objects
  for delete using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);

alter publication supabase_realtime add table public.expenses;
