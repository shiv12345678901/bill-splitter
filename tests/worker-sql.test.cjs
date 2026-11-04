const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

// An isolated PostgreSQL fixture, not an assertion about the live Muse schema.
test("production SQL: preservation, RLS, claims, fencing, retries and atomic replay", async () => {
  const db = new PGlite();
  const jobId = "11111111-1111-4111-8111-111111111111";
  const job2Id = "22222222-2222-4222-8222-222222222222";
  const job3Id = "33333333-3333-4333-8333-333333333333";
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select jsonb_build_object('email',coalesce(current_setting('request.jwt.claim.email',true),''))
      $$;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id text primary key,bucket_id text);
      create table public.sync_requests(id uuid primary key,requested_by text,status text,stage text,stage_message text,stage_updated_at timestamptz,result_summary text,error text,created_at timestamptz default now());
      create table public.periods(id text primary key,start_date date,end_date date,status text,total_cents integer,per_person_cents integer,receipt_count integer);
      create table public.receipts(id text primary key,period_id text references public.periods(id),captured_at timestamptz,merchant text,amount_cents integer,payer text,category text,date date,is_excluded boolean,image_url text);
      create table public.settlements(id text primary key,period_id text references public.periods(id),total_cents integer,per_person_cents integer,member_totals jsonb,receipt_count integer,calculated_at timestamptz,owes jsonb);
      create table public.bank_transfer_receipts(id uuid primary key,period_id text references public.periods(id),step_id text,from_name text,to_name text,amount_cents integer,transfer_date date,receipt_url text);
      insert into periods values('historical','2026-09-01','2026-09-30','CLOSED',500,125,1),('p','2026-10-01','2026-10-31','CURRENT',999,499,1);
      insert into receipts values('edited','p',now(),'Manual merchant',999,'Alex','Other','2026-10-02',true,'storage://bill-evidence/manual.jpg');
      insert into settlements values('settlement_2026-10-01_current','p',999,499,'{"Alex":999}',1,now(),'{"Alex":{"Jamie":250}}');
      insert into bank_transfer_receipts values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p','step-1','Alex','Jamie',250,'2026-10-03','storage://bill-evidence/transfer.jpg');
      insert into sync_requests(id,requested_by,status) values('${jobId}','netlify-app','pending'),('${job2Id}','netlify-app','pending');
      insert into storage.buckets values('bill-evidence','bill-evidence',false);
      alter table sync_requests enable row level security;
      alter table receipts enable row level security;
      alter table periods enable row level security;
      alter table settlements enable row level security;
      grant select,insert on sync_requests to authenticated;
      grant select on receipts,periods,settlements to authenticated;
      create policy production_sync_select on sync_requests for select to authenticated using(requested_by='netlify-app');
      create policy production_sync_insert on sync_requests for insert to authenticated with check(requested_by='netlify-app' and status='pending');
      create policy legacy_public_receipts_read on receipts for select to public using(true);
      create policy legacy_public_periods_read on periods for select to public using(true);
      create policy legacy_public_settlements_read on settlements for select to public using(true);
      create policy production_receipts_read on receipts for select to authenticated using(true);
      create policy production_periods_read on periods for select to authenticated using(true);
      create policy production_settlements_read on settlements for select to authenticated using(true);
    `);
    for (const name of fs.readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).sort())
      await db.exec(fs.readFileSync(`supabase/migrations/${name}`, "utf8"));
    const q = async (sql, args = []) => (await db.query(sql, args)).rows;
    assert.equal((await q("select * from claim_sync_request('a')")).length, 0);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 999);
    await db.exec("update instabox_worker_control set writes_enabled=true");
    assert.equal((await q("select instabox_worker_capabilities() as value"))[0].value.version, 6);
    assert.equal((await q("select verification_status from bank_transfer_receipts"))[0].verification_status, null);
    assert.equal((await q("select * from claim_sync_request('a')")).length, 1);
    assert.equal((await q("select * from claim_sync_request('b')")).length, 0);
    const rows = [
      { id: "edited", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "OCR overwrite", amount_cents: 10000, payer: "Alex", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
      { id: "new", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "Market", amount_cents: 101, payer: "Alex", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
    ];
    const finalize = (owner, receipts = rows, rounding = "floor") => q("select finalize_sync_request($1::uuid,$2,'p',$3::jsonb,array['Alex','Jamie','Morgan','Taylor'],$4,'existing-only')", [jobId, owner, JSON.stringify(receipts), rounding]);
    await q("select record_period_cycle_state($1::uuid,'a','p','PENDING_SETTLEMENT',$2::jsonb,null)", [jobId, JSON.stringify({ id: "calc-1", timestamp: 1793500000 })]);
    assert.equal((await q("select whatsapp_cycle_status from periods where id='p'"))[0].whatsapp_cycle_status, "PENDING_SETTLEMENT");
    await assert.rejects(
      () => q("select record_period_cycle_state($1::uuid,'a','p','SETTLED',null,null)", [jobId]),
      /clearance/i,
    );
    await assert.rejects(
      () => q("select record_period_cycle_state($1::uuid,'a','p','SETTLED',null,$2::jsonb)", [jobId, JSON.stringify({ id: "calc-only", source: "calculation", confidence: "LOW" })]),
      /clearance/i,
    );
    await assert.rejects(() => finalize("b"), /lease/i);
    await assert.rejects(() => finalize("a", [...rows, { ...rows[1], id: "invalid", amount_cents: -1 }]), /Invalid receipt/);
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 1);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 999);
    await finalize("a");
    await finalize("a");
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 2);
    const edited = (await q("select * from receipts where id='edited'"))[0];
    assert.equal(edited.merchant, "Manual merchant");
    assert.equal(edited.is_excluded, true);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 101);
    assert.equal((await q("select per_person_cents from settlements"))[0].per_person_cents, 25);
    assert.deepEqual((await q("select owes from settlements"))[0].owes, { Alex: { Jamie: 250 } });
    assert.equal((await q("select id from settlements"))[0].id, "settlement_2026-10-01_current");
    assert.equal((await q("select previous_period->>'total_cents' as n from instabox_sync_audit"))[0].n, "999");
    assert.equal((await q("select status from sync_requests where id=$1", [jobId]))[0].status, "done");
    assert.deepEqual((await q("select source_provider,source_message_id from receipts where id='new'"))[0], { source_provider: "whatsapp", source_message_id: "new" });
    await assert.rejects(() => db.exec("insert into receipts(id,period_id,source_provider,source_message_id) values('alias','p','whatsapp','new')"), /unique/i);
    await q("select * from claim_sync_request('a')");
    await q("select retry_sync_request($1::uuid,'a','temporary outage')", [job2Id]);
    assert.equal((await q("select status from sync_requests where id=$1", [job2Id]))[0].status, "pending");
    assert.equal((await q("select * from claim_sync_request('a')")).length, 0);
    await q("update sync_requests set next_attempt_at=now()-interval '1 second' where id=$1", [job2Id]);
    await q("select * from claim_sync_request('b')");
    await q("update sync_requests set lease_expires_at=now()-interval '1 second' where id=$1", [job2Id]);
    const recovered = await q("select * from claim_sync_request('c')");
    assert.equal(recovered[0].worker_id, "c");
    assert.equal(recovered[0].attempt_count, 3);
    await q("update sync_requests set lease_expires_at=now()-interval '1 second' where id=$1", [job2Id]);
    await q("select * from claim_sync_request('d')");
    assert.equal((await q("select status from sync_requests where id=$1", [job2Id]))[0].status, "failed");
    assert.equal((await q("select has_function_privilege('authenticated','public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select count(*)::integer n from pg_policies where schemaname='public' and tablename in ('receipts','periods','settlements') and permissive='PERMISSIVE' and 'public'::name=any(roles)"))[0].n, 0);
    assert.equal((await q("select count(*)::integer n from pg_policies where policyname like 'production_%'"))[0].n, 5);
    await q("insert into sync_requests(id,requested_by,status) values($1,'netlify-app','pending')", [job3Id]);
    await q("select * from claim_sync_request('rollover-worker')");
    const clearanceTimestamp = Math.floor(new Date("2026-10-31T12:30:00Z").getTime() / 1000);
    const clearance = { id: "clearance-31-oct", timestamp: clearanceTimestamp, source: "marker", confidence: "HIGH", text: "Clear up to date" };
    const rolloverArgs = [
      job3Id, "rollover-worker", "p", "2026-10-31", JSON.stringify(clearance),
      "period_2026-10-31", "settlement_2026-10-31_current", "2026-10-31",
      JSON.stringify({ ...clearance, dateStr: "2026-10-31" }), "ACTIVE", null,
      ["Alex", "Jamie", "Morgan", "Taylor"],
    ];
    const rolloverSql = "select rollover_settlement_period($1::uuid,$2,$3,$4::date,$5::jsonb,$6,$7,$8::date,$9::jsonb,$10,$11::jsonb,$12::text[])";
    await q("update instabox_worker_control set automatic_rollover_after='2026-11-02T00:00:00Z'");
    await assert.rejects(() => q(rolloverSql, rolloverArgs), /explicitly reviewed approval/i);
    await q("insert into instabox_rollover_approvals(old_period_id,clearance_message_id,new_period_id,reviewed_by) values('p','clearance-31-oct','period_2026-10-31','operator-test')");
    await q("insert into periods(id,start_date,end_date,status,total_cents,per_person_cents,receipt_count) values('ambiguous-history','2026-08-01','2026-08-31','ARCHIVED',0,0,0)");
    await assert.rejects(() => q(rolloverSql, rolloverArgs), /status convention/i);
    await q("delete from periods where id='ambiguous-history'");
    await q("insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url) values('misassigned-november','p','2026-11-02T01:00:00Z','Wrong period',100,'Alex','Groceries','2026-11-02',false,'storage://bill-evidence/wrong.jpg')");
    await assert.rejects(() => q(rolloverSql, rolloverArgs), /receipts after clearance/i);
    await q("delete from receipts where id='misassigned-november'");
    await q(rolloverSql, rolloverArgs);
    await q(rolloverSql, rolloverArgs);
    assert.equal((await q("select status from periods where id='p'"))[0].status, "CLOSED");
    const opened = (await q("select * from periods where id='period_2026-10-31'"))[0];
    assert.equal(opened.status, "CURRENT");
    assert.equal(opened.end_date, null);
    assert.equal(opened.whatsapp_start_boundary.id, "clearance-31-oct");
    assert.deepEqual((await q("select id,owes from settlements where period_id='p'"))[0], {
      id: "settlement_2026-10-01_current", owes: { Alex: { Jamie: 250 } },
    });
    const placeholder = (await q("select * from settlements where period_id='period_2026-10-31'"))[0];
    assert.equal(placeholder.id, "settlement_2026-10-31_current");
    assert.equal(placeholder.owes, null);
    assert.equal(placeholder.payment_obligations_status, "UNINITIALIZED");
    const novemberRows = [{ id: "nov-2", period_id: "period_2026-10-31", captured_at: "2026-11-02T01:00:00Z", merchant: "November Market", amount_cents: 400, payer: "Jamie", category: "Groceries", date: "2026-11-02", is_excluded: false, image_url: "storage://bill-evidence/nov-2.jpg" }];
    await q("select finalize_sync_request($1::uuid,'rollover-worker','period_2026-10-31',$2::jsonb,array['Alex','Jamie','Morgan','Taylor'],'floor','existing-only')", [job3Id, JSON.stringify(novemberRows)]);
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 1);
    assert.equal((await q("select owes from settlements where id='settlement_2026-10-31_current'"))[0].owes, null);
    assert.equal((await q("select has_function_privilege('authenticated','public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])','execute') as allowed"))[0].allowed, true);
    const historicalStart = Math.floor(new Date("2026-08-31T13:59:59Z").getTime() / 1000);
    const historicalEnd = Math.floor(new Date("2026-09-30T13:59:59Z").getTime() / 1000);
    const historicalStartBoundary = { id: "historical-start", timestamp: historicalStart, source: "configured", confidence: "HIGH" };
    const historicalEndBoundary = { id: "historical-clearance", timestamp: historicalEnd, source: "marker", confidence: "HIGH" };
    await q("update periods set whatsapp_cycle_status='SETTLED',whatsapp_start_boundary=$1::jsonb,whatsapp_clearance_message=$2::jsonb where id='historical'", [JSON.stringify(historicalStartBoundary), JSON.stringify(historicalEndBoundary)]);
    await q("insert into settlements(id,period_id,total_cents,per_person_cents,member_totals,receipt_count,calculated_at,owes,payment_obligations_status) values('settlement_2026-09-01_closed','historical',500,125,'{\"Alex\":500}',1,now(),'{\"Jamie\":125}','REVIEWED')");
    const historicalFinanceBefore = (await q("select to_jsonb(p) period,(select jsonb_agg(to_jsonb(s)) from settlements s where s.period_id=p.id) settlements from periods p where id='historical'"))[0];

    await db.exec("set role authenticated");
    await q("select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',false)");
    await q("select set_config('request.jwt.claim.email','outsider@example.com',false)");
    await assert.rejects(() => q("select * from request_historical_rescan('historical')"), /authorization/i);
    await q("select set_config('request.jwt.claim.email','shiva@billforus.netlify.app',false)");
    const historicalRequest = await q("select * from request_historical_rescan('historical')");
    const duplicateRequest = await q("select * from request_historical_rescan('historical')");
    assert.equal(historicalRequest[0].id, duplicateRequest[0].id);
    assert.equal(historicalRequest[0].job_type, "historical_rescan");
    await assert.rejects(
      () => db.exec("insert into sync_requests(id,requested_by,status,job_type,period_id,requested_by_user) values('66666666-6666-4666-8666-666666666666','netlify-app','pending','historical_rescan','historical','99999999-9999-4999-8999-999999999999')"),
      /row-level security/i,
    );
    await db.exec("reset role");

    const claimedHistorical = await q("select * from claim_sync_request('historical-worker')");
    assert.equal(claimedHistorical[0].id, historicalRequest[0].id);
    const historicalEvidence = [{
      id: "historical-bank-proof", period_id: "historical", captured_at: "2026-09-15T01:00:00Z",
      merchant: "Bank Transfer", amount_cents: 0, payer: "Alex", category: "Other", date: "2026-09-15",
      is_excluded: true, evidence_only: true, needs_review: true,
      image_url: "storage://bill-evidence/historical/historical-bank-proof.jpg",
    }];
    const finalizeHistorical = () => q(
      "select finalize_historical_rescan($1::uuid,'historical-worker','historical','historical-start','historical-clearance',$2::jsonb,array['Alex','Jamie','Morgan','Taylor'])",
      [historicalRequest[0].id, JSON.stringify(historicalEvidence)],
    );
    await finalizeHistorical();
    await finalizeHistorical();
    assert.deepEqual(await q("select is_excluded,evidence_only,needs_review from receipts where id='historical-bank-proof'"), [{
      is_excluded: true, evidence_only: true, needs_review: true,
    }]);
    const historicalFinanceAfter = (await q("select to_jsonb(p) period,(select jsonb_agg(to_jsonb(s)) from settlements s where s.period_id=p.id) settlements from periods p where id='historical'"))[0];
    assert.deepEqual(historicalFinanceAfter, historicalFinanceBefore);
    assert.equal((await q("select count(*)::integer n from instabox_historical_rescan_audit"))[0].n, 1);
    assert.equal((await q("select has_function_privilege('authenticated','public.request_historical_rescan(text)','execute') allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.finalize_historical_rescan(uuid,text,text,text,text,jsonb,text[])','execute') allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.finalize_historical_rescan(uuid,text,text,text,text,jsonb,text[])','execute') allowed"))[0].allowed, true);
    await db.exec("set role authenticated");
    await assert.rejects(() => db.exec("insert into sync_requests(id,requested_by,status,worker_id) values('55555555-5555-4555-8555-555555555555','netlify-app','processing','evil')"), /row-level security/);
    await db.exec("insert into sync_requests(id,requested_by,status) values('44444444-4444-4444-8444-444444444444','netlify-app','pending')");
    assert.equal((await q("select count(*)::integer n from receipts"))[0].n, 4);
    await db.exec("reset role");
  } finally { await db.close(); }
});
