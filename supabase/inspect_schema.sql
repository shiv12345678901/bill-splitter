-- Read-only schema evidence. Do not include row contents or credentials in Git.
select table_name,column_name,data_type,is_nullable,column_default
from information_schema.columns where table_schema='public'
and table_name in ('sync_requests','receipts','periods','settlements','members') order by table_name,ordinal_position;
select conrelid::regclass as table_name,conname,pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid in ('public.sync_requests'::regclass,'public.receipts'::regclass,'public.periods'::regclass,'public.settlements'::regclass);
select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
where schemaname in ('public','storage');
select id,name,public from storage.buckets where id='bill-evidence';
select count(*) as duplicate_id_groups from (select id from public.receipts group by id having count(*)>1) d;
