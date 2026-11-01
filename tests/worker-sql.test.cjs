const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

// An isolated PostgreSQL fixture, not an assertion about the live Muse schema.
test("production SQL: preservation, RLS, claims, fencing, retries and atomic replay", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id text primary key,bucket_id text);
      create table public.sync_requests(id text primary key,requested_by text,status text,stage text,stage_message text,stage_updated_at timestamptz,result_summary text,error text,created_at timestamptz default now());
      create table public.periods(id text primary key,start_date date,end_date date,status text,total_cents integer,per_person_cents integer,receipt_count integer);
      create table public.receipts(id text primary key,period_id text references public.periods(id),captured_at timestamptz,merchant text,amount_cents integer,payer text,category text,date date,is_excluded boolean,image_url text);
      create table public.settlements(id text primary key,period_id text references public.periods(id),total_cents integer,per_person_cents integer,member_totals jsonb,receipt_count integer,calculated_at timestamptz);
      insert into periods values('p','2026-10-01','2026-10-31','CURRENT',999,499,1);
      insert into receipts values('edited','p',now(),'Manual merchant',999,'Alex','Other','2026-10-02',true,'storage://bill-evidence/manual.jpg');
      insert into settlements values('muse-original','p',999,499,'{"Alex":999}',1,now());
      insert into sync_requests(id,requested_by,status) values('job','netlify-app','pending'),('job2','netlify-app','pending');
    `);
    for (const name of fs.readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).sort())
      await db.exec(fs.readFileSync(`supabase/migrations/${name}`, "utf8"));
    const q = async (sql, args = []) => (await db.query(sql, args)).rows;
    assert.equal((await q("select * from claim_sync_request('a')")).length, 0);
    assert.equal((await q("select total_cents from periods"))[0].total_cents, 999);
    await db.exec("update instabox_worker_control set writes_enabled=true");
    assert.equal((await q("select * from claim_sync_request('a')")).length, 1);
    assert.equal((await q("select * from claim_sync_request('b')")).length, 0);
    const rows = [
      { id: "edited", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "OCR overwrite", amount_cents: 10000, payer: "Alex", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
      { id: "new", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "Market", amount_cents: 101, payer: "Alex", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
    ];
    const finalize = (owner, receipts = rows, rounding = "floor") => q("select finalize_sync_request('job',$1,'p',$2::jsonb,array['Alex','Jamie'],$3,'existing-only')", [owner, JSON.stringify(receipts), rounding]);
    await assert.rejects(() => finalize("b"), /lease/i);
    await assert.rejects(() => finalize("a", [...rows, { ...rows[1], id: "invalid", amount_cents: -1 }]), /Invalid receipt/);
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 1);
    assert.equal((await q("select total_cents from periods"))[0].total_cents, 999);
    await finalize("a");
    await finalize("a");
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 2);
    const edited = (await q("select * from receipts where id='edited'"))[0];
    assert.equal(edited.merchant, "Manual merchant");
    assert.equal(edited.is_excluded, true);
    assert.equal((await q("select total_cents from periods"))[0].total_cents, 101);
    assert.equal((await q("select per_person_cents from settlements"))[0].per_person_cents, 50);
    assert.equal((await q("select previous_period->>'total_cents' as n from instabox_sync_audit"))[0].n, "999");
    assert.equal((await q("select status from sync_requests where id='job'"))[0].status, "done");
    await assert.rejects(() => db.exec("insert into receipts(id,period_id,source_provider,source_message_id) values('alias','p','whatsapp','new')"), /unique/i);
    await q("select * from claim_sync_request('a')");
    await q("select retry_sync_request('job2','a','temporary outage')");
    assert.equal((await q("select status from sync_requests where id='job2'"))[0].status, "pending");
    assert.equal((await q("select * from claim_sync_request('a')")).length, 0);
    await db.exec("update sync_requests set next_attempt_at=now()-interval '1 second' where id='job2'");
    await q("select * from claim_sync_request('b')");
    await db.exec("update sync_requests set lease_expires_at=now()-interval '1 second' where id='job2'");
    const recovered = await q("select * from claim_sync_request('c')");
    assert.equal(recovered[0].worker_id, "c");
    assert.equal(recovered[0].attempt_count, 3);
    await db.exec("update sync_requests set lease_expires_at=now()-interval '1 second' where id='job2'");
    await q("select * from claim_sync_request('d')");
    assert.equal((await q("select status from sync_requests where id='job2'"))[0].status, "failed");
    assert.equal((await q("select has_function_privilege('authenticated','public.finalize_sync_request(text,text,text,jsonb,text[],text,text)','execute') as allowed"))[0].allowed, false);
    await db.exec("set role authenticated");
    await assert.rejects(() => db.exec("insert into sync_requests(id,requested_by,status,worker_id) values('evil','netlify-app','processing','evil')"), /row-level security/);
    await db.exec("insert into sync_requests(id,requested_by,status) values('frontend','netlify-app','pending')");
    await db.exec("reset role");
  } finally { await db.close(); }
});
