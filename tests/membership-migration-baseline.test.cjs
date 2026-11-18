const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

test("membership migration preserves the confirmed capability-v7 production baseline", async () => {
  const db = new PGlite();
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      create function auth.role() returns text language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),current_user)
      $$;
      create schema storage;
      create table storage.objects(id text primary key,bucket_id text,name text);
      alter table storage.objects enable row level security;
      create table public.periods(
        id text primary key,start_date date,end_date date,status text,total_cents integer,
        per_person_cents integer,receipt_count integer
      );
      create table public.receipts(
        id text primary key,period_id text references periods(id),captured_at timestamptz,
        merchant text,amount_cents integer,payer text,category text,date date,
        is_excluded boolean,image_url text
      );
      create table public.settlements(
        id text primary key,period_id text references periods(id),total_cents integer,
        per_person_cents integer,member_totals jsonb,receipt_count integer,
        calculated_at timestamptz,owes jsonb,payment_obligations_status text
      );
      create table public.sync_requests(id uuid primary key,result_summary text);
      create table public.instabox_sync_audit(job_id uuid primary key,result_summary text);
      create table public.instabox_worker_control(singleton boolean primary key,writes_enabled boolean,review_reference text);
      insert into instabox_worker_control values(true,false,'capability-v7-baseline');
      insert into periods values
        ('historical','2026-09-01','2026-09-30','CLOSED',500,125,1),
        ('period_2026-10-31','2026-10-31',null,'CURRENT',93931,23483,26);
      insert into settlements values(
        'settlement_2026-10-31_current','period_2026-10-31',93931,23483,
        '{"Shiva Kafle":93931,"Arjun Bhurtel":0,"Arpan Bhurtel":0,"Swasti Adhikari":0}',
        26,now(),null,'UNINITIALIZED'
      );
      alter table receipts enable row level security;
      create policy production_receipts_read on receipts for select to authenticated using(true);
      create function public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text)
        returns jsonb language sql as $$select '{}'::jsonb$$;
      create function public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)
        returns void language plpgsql as $$begin end$$;
      create function public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)
        returns void language plpgsql as $$begin end$$;
      create function public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)
        returns jsonb language sql as $$select '{}'::jsonb$$;
      create function public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)
        returns jsonb language sql as $$select '{}'::jsonb$$;
      create function public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])
        returns jsonb language sql as $$select '{}'::jsonb$$;
    `);
    const members = ["Shiva Kafle", "Arjun Bhurtel", "Arpan Bhurtel", "Swasti Adhikari"];
    for (let index = 0; index < 26; index++) {
      const amount = index === 25 ? 3931 : 3600;
      await q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url)
        values($1,'period_2026-10-31',now(),'Baseline receipt',$2,$3,'Groceries','2026-11-01',false,$4)`,
      [`baseline-${index}`, amount, members[index % members.length], `storage://bill-evidence/baseline-${index}.jpg`]);
    }
    const beforeIds = await q("select id from receipts order by id");
    const migration = fs.readFileSync("supabase/migrations/20261118000000_settlement_cycle_membership.sql", "utf8");
    await db.exec(migration);
    assert.deepEqual((await q("select total_cents,per_person_cents,receipt_count from periods where id='period_2026-10-31'"))[0], {
      total_cents: 93931, per_person_cents: 23483, receipt_count: 26,
    });
    assert.deepEqual((await q("select total_cents,per_person_cents,receipt_count,payment_obligations_status,owes from settlements"))[0], {
      total_cents: 93931, per_person_cents: 23483, receipt_count: 26,
      payment_obligations_status: "UNINITIALIZED", owes: null,
    });
    assert.deepEqual(await q("select id from receipts order by id"), beforeIds);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='period_2026-10-31' and participation_mode='enabled'"))[0].n, 4);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='historical'"))[0].n, 0);
    assert.equal((await q("select writes_enabled from instabox_worker_control"))[0].writes_enabled, false);
    assert.equal((await q("select instabox_worker_capabilities() value"))[0].value.version, 8);

    await db.exec(migration);
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 26);
    assert.equal((await q("select revision from settlement_cycle_membership_state where period_id='period_2026-10-31'"))[0].revision, 1);
  } finally {
    await db.close();
  }
});
