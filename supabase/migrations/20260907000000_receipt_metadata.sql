-- Safe to run more than once in the Supabase SQL Editor.
alter table public.expenses add column if not exists receipt_date date;
alter table public.expenses add column if not exists currency text not null default 'AUD';
alter table public.expenses add column if not exists image_original_name text;
alter table public.expenses add column if not exists image_mime_type text;
alter table public.expenses add column if not exists image_size_bytes bigint;
alter table public.expenses add column if not exists ocr_model text;
alter table public.expenses add column if not exists ocr_status text not null default 'not_requested';
alter table public.expenses add column if not exists ocr_processed_at timestamptz;
alter table public.expenses add column if not exists verified_at timestamptz;

alter table public.expenses drop constraint if exists expenses_currency_check;
alter table public.expenses add constraint expenses_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.expenses drop constraint if exists expenses_image_size_check;
alter table public.expenses add constraint expenses_image_size_check
  check (image_size_bytes is null or image_size_bytes between 1 and 10485760);

alter table public.expenses drop constraint if exists expenses_image_mime_check;
alter table public.expenses add constraint expenses_image_mime_check
  check (image_mime_type is null or image_mime_type in ('image/jpeg', 'image/png', 'image/webp'));

alter table public.expenses drop constraint if exists expenses_ocr_status_check;
alter table public.expenses add constraint expenses_ocr_status_check
  check (ocr_status in ('not_requested', 'pending', 'complete', 'failed', 'manual'));

create unique index if not exists expenses_image_path_unique_idx
  on public.expenses (image_path)
  where image_path is not null;
