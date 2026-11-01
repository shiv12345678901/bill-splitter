-- Immediate, reversible rollback switch. Existing data remains untouched.
update public.instabox_worker_control set writes_enabled = false where singleton;
