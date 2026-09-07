-- Preserve shared receipt history when a member deletes their login.
alter table public.household_members alter column user_id drop not null;
alter table public.household_members drop constraint if exists household_members_user_id_fkey;
alter table public.household_members add constraint household_members_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;
