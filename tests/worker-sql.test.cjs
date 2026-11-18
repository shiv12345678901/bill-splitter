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
  const reconciliationJobId = "66666666-6666-4666-8666-666666666666";
  const groupIdentityHash = "a".repeat(64);
  const cycleBoundaryId = "period-start-boundary";
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
      insert into auth.users(id) values
        ('aaaaaaaa-1111-4111-8111-111111111111'),
        ('bbbbbbbb-2222-4222-8222-222222222222'),
        ('cccccccc-3333-4333-8333-333333333333'),
        ('dddddddd-4444-4444-8444-444444444444'),
        ('eeeeeeee-5555-4555-8555-555555555555');
      create schema storage;
      grant usage on schema storage to authenticated;
      create table storage.buckets(id text primary key,name text,public boolean);
      create table storage.objects(id text primary key,bucket_id text,name text);
      alter table storage.objects enable row level security;
      grant select on storage.objects to authenticated;
      create table public.sync_requests(id uuid primary key,requested_by text,status text,stage text,stage_message text,stage_updated_at timestamptz,result_summary text,error text,created_at timestamptz default now());
      create table public.periods(id text primary key,start_date date,end_date date,status text,total_cents integer,per_person_cents integer,receipt_count integer);
      create table public.receipts(id text primary key,period_id text references public.periods(id),captured_at timestamptz,merchant text,amount_cents integer,payer text,category text,date date,is_excluded boolean,image_url text);
      create table public.settlements(id text primary key,period_id text references public.periods(id),total_cents integer,per_person_cents integer,member_totals jsonb,receipt_count integer,calculated_at timestamptz,owes jsonb);
      create table public.bank_transfer_receipts(id uuid primary key,period_id text references public.periods(id),step_id text,from_name text,to_name text,amount_cents integer,transfer_date date,receipt_url text);
      insert into periods values('historical','2026-09-01','2026-09-30','CLOSED',500,125,1),('p','2026-10-01','2026-10-31','CURRENT',999,499,1);
      insert into receipts values('edited','p','2026-10-02T01:00:00Z','Manual merchant',999,'Shiva Kafle','Other','2026-10-02',true,'storage://bill-evidence/manual.jpg');
      insert into settlements values('settlement_2026-10-01_current','p',999,499,'{"Shiva Kafle":999}',1,now(),'{"Shiva Kafle":{"Arjun Bhurtel":250}}');
      insert into bank_transfer_receipts values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p','step-1','Shiva Kafle','Arjun Bhurtel',250,'2026-10-03','storage://bill-evidence/transfer.jpg');
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
    await q("select set_config('request.jwt.claim.role','service_role',false)");
    assert.equal((await q("select * from claim_sync_request('a')")).length, 0);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 999);
    await db.exec("update instabox_worker_control set writes_enabled=true");
    await q("update periods set whatsapp_start_boundary=$1::jsonb where id='p'", [JSON.stringify({
      id: cycleBoundaryId,
      timestamp: Math.floor(new Date("2026-09-30T14:00:00Z").getTime() / 1000) - 1,
      source: "configured",
      confidence: "HIGH",
    })]);
    await q("update settlements set payment_obligations_status='UNINITIALIZED' where period_id='p'");
    assert.equal((await q("select instabox_worker_capabilities() as value"))[0].value.version, 8);
    assert.equal((await q("select verification_status from bank_transfer_receipts"))[0].verification_status, null);
    assert.equal((await q("select * from claim_sync_request('a')")).length, 1);
    assert.equal((await q("select * from claim_sync_request('b')")).length, 0);
    const rows = [
      { id: "edited", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "OCR overwrite", amount_cents: 10000, payer: "Shiva Kafle", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
      { id: "new", period_id: "p", captured_at: "2026-10-02T00:00:00Z", merchant: "Market", amount_cents: 102, payer: "Shiva Kafle", category: "Groceries", date: "2026-10-02", is_excluded: false, image_url: "storage://bill-evidence/new.jpg" },
    ];
    const finalize = (owner, receipts = rows, rounding = "round", revision = 1) => q("select finalize_sync_request($1::uuid,$2,'p',$3::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],$4,'existing-only',$5)", [jobId, owner, JSON.stringify(receipts), rounding, revision]);
    await assert.rejects(() => q("select record_period_cycle_state($1::uuid,'a','p','PENDING_SETTLEMENT',$2::jsonb,null)", [jobId, JSON.stringify({ id: "calc-1", timestamp: 1793500000 })]), /MEMBERSHIP_REVISION_REQUIRED/);
    await q("select record_period_cycle_state($1::uuid,'a','p','PENDING_SETTLEMENT',$2::jsonb,null,1)", [jobId, JSON.stringify({ id: "calc-1", timestamp: 1793500000 })]);
    assert.equal((await q("select whatsapp_cycle_status from periods where id='p'"))[0].whatsapp_cycle_status, "PENDING_SETTLEMENT");
    await assert.rejects(
      () => q("select record_period_cycle_state($1::uuid,'a','p','SETTLED',null,null,1)", [jobId]),
      /clearance/i,
    );
    await assert.rejects(
      () => q("select record_period_cycle_state($1::uuid,'a','p','SETTLED',null,$2::jsonb,1)", [jobId, JSON.stringify({ id: "calc-only", source: "calculation", confidence: "LOW" })]),
      /clearance/i,
    );
    await assert.rejects(() => finalize("b"), /lease/i);
    await assert.rejects(() => finalize("a", [...rows, { ...rows[1], id: "invalid", amount_cents: -1 }]), /Invalid receipt/);
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 1);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 999);
    const bankEvidence = [{
      id: "whatsapp-bank-1", period_id: "p", source_message_id: "whatsapp-bank-1",
      captured_at: "2026-10-03T01:00:00Z", sender_name: "Shiva Kafle", recipient_name: "Arjun Bhurtel",
      amount_cents: 250, transfer_date: "2026-10-03", reference_number: "OSKO-123",
      evidence_url: "storage://bill-evidence/p/bank-transfers/whatsapp-bank-1.jpg",
      classification: "bank_transfer", review_status: "pending",
    }, {
      id: "whatsapp-bank-reviewed", period_id: "p", source_message_id: "whatsapp-bank-reviewed",
      captured_at: "2026-10-04T01:00:00Z", sender_name: "Arjun Bhurtel", recipient_name: "Shiva Kafle",
      amount_cents: null, transfer_date: null, reference_number: null,
      evidence_url: "storage://bill-evidence/p/bank-transfers/whatsapp-bank-reviewed.jpg",
      classification: "bank_transfer", review_status: "pending",
    }];
    await q("select prepare_instabox_whatsapp_sources($1::uuid,'a','p',$2::jsonb,1)", [jobId, JSON.stringify([
      { source_message_id: "new", source_kind: "receipt", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId },
      { source_message_id: "whatsapp-bank-1", source_kind: "bank_evidence", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId },
      { source_message_id: "whatsapp-bank-reviewed", source_kind: "bank_evidence", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId },
    ])]);
    assert.deepEqual(await q("select source_message_id,registration_status from instabox_managed_whatsapp_sources order by source_message_id"), [
      { source_message_id: "new", registration_status: "pending" },
      { source_message_id: "whatsapp-bank-1", registration_status: "pending" },
      { source_message_id: "whatsapp-bank-reviewed", registration_status: "pending" },
    ]);
    await assert.rejects(() => q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb)", [jobId, JSON.stringify(bankEvidence)]), /MEMBERSHIP_REVISION_REQUIRED/);
    await q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb,1)", [jobId, JSON.stringify(bankEvidence)]);
    await q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb,1)", [jobId, JSON.stringify(bankEvidence)]);
    await assert.rejects(() => q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb,2)", [jobId, JSON.stringify(bankEvidence)]), /STALE_MEMBERSHIP_REVISION/);
    await assert.rejects(
      () => q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb,1)", [
        jobId, JSON.stringify([{ ...bankEvidence[0], id: "zero", source_message_id: "zero", amount_cents: 0 }]),
      ]),
      /BANK_EVIDENCE_REVIEW_REQUIRED/,
    );
    await assert.rejects(
      () => q("select record_whatsapp_bank_evidence($1::uuid,'a','p',$2::jsonb,1)", [
        jobId, JSON.stringify([{ ...bankEvidence[0], id: "old-date", source_message_id: "old-date", transfer_date: "2026-04-25" }]),
      ]),
      /BANK_EVIDENCE_DATE_OUTSIDE_PERIOD/,
    );
    assert.equal((await q("select count(*)::integer n from whatsapp_bank_transfer_evidence"))[0].n, 2);
    await q("update whatsapp_bank_transfer_evidence set review_status='reviewed' where id='whatsapp-bank-reviewed'");
    assert.equal((await q("select verification_status from bank_transfer_receipts"))[0].verification_status, null);
    await finalize("a");
    await finalize("a");
    assert.equal((await q("select count(*)::integer as n from receipts"))[0].n, 2);
    const edited = (await q("select * from receipts where id='edited'"))[0];
    assert.equal(edited.merchant, "Manual merchant");
    assert.equal(edited.is_excluded, true);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 102);
    assert.equal((await q("select per_person_cents from settlements"))[0].per_person_cents, 26);
    assert.deepEqual((await q("select owes from settlements"))[0].owes, { "Shiva Kafle": { "Arjun Bhurtel": 250 } });
    assert.equal((await q("select id from settlements"))[0].id, "settlement_2026-10-01_current");
    assert.equal((await q("select previous_period->>'total_cents' as n from instabox_sync_audit"))[0].n, "999");
    assert.equal((await q("select status from sync_requests where id=$1", [jobId]))[0].status, "done");
    assert.deepEqual((await q("select source_provider,source_message_id from receipts where id='new'"))[0], { source_provider: "whatsapp", source_message_id: "new" });
    await assert.rejects(() => db.exec("insert into receipts(id,period_id,source_provider,source_message_id) values('alias','p','whatsapp','new')"), /unique/i);
    assert.equal((await q("select count(*)::integer n from instabox_managed_whatsapp_sources where source_message_id in ('new','whatsapp-bank-1','whatsapp-bank-reviewed')"))[0].n, 3);
    assert.equal((await q("select count(*)::integer n from instabox_managed_whatsapp_sources where registration_status='active'"))[0].n, 3);
    assert.equal((await q("select count(*)::integer n from instabox_managed_whatsapp_sources where source_message_id='edited'"))[0].n, 0);
    await q(`insert into sync_requests(id,requested_by,status,worker_id,lease_expires_at,attempt_count)
      values($1,'netlify-app','processing','reconciler',now()+interval '10 minutes',1)`, [reconciliationJobId]);
    await q("update periods set whatsapp_cycle_status='ACTIVE' where id='p'");
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p','[]'::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'floor',1)", [reconciliationJobId]), /shareRounding=round/i);
    const delayedEvidence = [{
      source_message_id: "delayed-source", evidence_source: "message_revoke_everyone",
      detected_at: "2026-11-17T07:00:03Z", group_identity_hash: groupIdentityHash,
      cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:delayed-source",
    }];
    const reconcileDelayed = () => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1) as value", [reconciliationJobId, JSON.stringify(delayedEvidence)]);
    assert.equal((await reconcileDelayed())[0].value.protected, 1);
    await assert.rejects(() => q("select prepare_instabox_whatsapp_sources($1::uuid,'reconciler','p',$2::jsonb,1)", [reconciliationJobId, JSON.stringify([{
      source_message_id: "edited", source_kind: "receipt", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId,
    }])]), /cannot be registered retroactively/i);
    await q("select prepare_instabox_whatsapp_sources($1::uuid,'reconciler','p',$2::jsonb,1)", [reconciliationJobId, JSON.stringify([{
      source_message_id: "delayed-source", source_kind: "receipt", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId,
    }])]);
    assert.equal((await q("select registration_status from instabox_managed_whatsapp_sources where source_message_id='delayed-source'"))[0].registration_status, "pending");
    await q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url,source_provider,source_message_id)
      values('delayed-source','p','2026-10-05T01:00:00Z','Delayed Market',4,'Arjun Bhurtel','Groceries','2026-10-05',false,'storage://bill-evidence/delayed.jpg','whatsapp','delayed-source')`);
    assert.equal((await q("select registration_status from instabox_managed_whatsapp_sources where source_message_id='delayed-source'"))[0].registration_status, "active");
    assert.equal((await reconcileDelayed())[0].value.receipts_deleted, 1);
    assert.deepEqual(await q("select outcome,source_state from whatsapp_image_reconciliation_audit where source_message_id='delayed-source' order by audit_id"), [
      { outcome: "protected_legacy", source_state: "unregistered" },
      { outcome: "receipt_deleted", source_state: "managed_receipt_present" },
    ]);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 102);
    assert.equal((await q("select per_person_cents from settlements where period_id='p'"))[0].per_person_cents, 26);
    const missingEvidence = [{
      source_message_id: "missing-source", evidence_source: "revoked_placeholder",
      detected_at: "2026-11-17T07:00:04Z", group_identity_hash: groupIdentityHash,
      cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:missing-source",
    }];
    const reconcileMissing = () => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1) as value", [reconciliationJobId, JSON.stringify(missingEvidence)]);
    await q("select prepare_instabox_whatsapp_sources($1::uuid,'reconciler','p',$2::jsonb,1)", [reconciliationJobId, JSON.stringify([{
      source_message_id: "missing-source", source_kind: "receipt", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId,
    }])]);
    const insertMissingSource = () => q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url,source_provider,source_message_id)
      values('missing-source','p','2026-10-06T01:00:00Z','Missing Market',8,'Arpan Bhurtel','Groceries','2026-10-06',false,'storage://bill-evidence/missing.jpg','whatsapp','missing-source')`);
    await insertMissingSource();
    await q("delete from receipts where id='missing-source'");
    assert.equal((await reconcileMissing())[0].value.receipts_deleted, 0);
    assert.equal((await q("select outcome from whatsapp_image_reconciliation_audit where source_message_id='missing-source' order by audit_id"))[0].outcome, "not_found");
    await insertMissingSource();
    assert.equal((await reconcileMissing())[0].value.receipts_deleted, 1);
    assert.deepEqual(await q("select outcome,source_state from whatsapp_image_reconciliation_audit where source_message_id='missing-source' order by audit_id"), [
      { outcome: "not_found", source_state: "managed_receipt_missing" },
      { outcome: "receipt_deleted", source_state: "managed_receipt_present" },
    ]);
    await q("update settlements set payment_obligations_status='REVIEWED' where period_id='p'");
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p','[]'::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1)", [reconciliationJobId]), /UNINITIALIZED payment obligations/i);
    await q("update settlements set payment_obligations_status='UNINITIALIZED' where period_id='p'");
    await q("update periods set whatsapp_cycle_status='PENDING_SETTLEMENT' where id='p'");
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p','[]'::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1)", [reconciliationJobId]), /CURRENT ACTIVE cycle/i);
    await q("update periods set whatsapp_cycle_status='ACTIVE' where id='p'");
    const deletionEvidence = [
      { source_message_id: "new", evidence_source: "message_revoke_everyone", detected_at: "2026-11-17T07:00:00Z", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:new" },
      { source_message_id: "whatsapp-bank-1", evidence_source: "revoked_placeholder", detected_at: "2026-11-17T07:00:01Z", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:whatsapp-bank-1" },
      { source_message_id: "whatsapp-bank-reviewed", evidence_source: "message_revoke_everyone", detected_at: "2026-11-17T07:00:01Z", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:whatsapp-bank-reviewed" },
      { source_message_id: "edited", evidence_source: "message_revoke_everyone", detected_at: "2026-11-17T07:00:02Z", group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId, idempotency_key: "whatsapp-delete:edited" },
    ];
    const reconcile = () => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1) as value", [reconciliationJobId, JSON.stringify(deletionEvidence)]);
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Unknown'],'round',1)", [reconciliationJobId, JSON.stringify(deletionEvidence)]), /reviewed settlement rules/i);
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'reconciler','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1)", [reconciliationJobId, JSON.stringify([{ ...deletionEvidence[0], group_identity_hash: "b".repeat(64) }])]), /provenance conflicts/i);
    const concurrentResults = await Promise.all([reconcile(), reconcile()]);
    const reconciledValues = concurrentResults.map((rows) => rows[0].value);
    assert.equal(reconciledValues.reduce((sum, value) => sum + value.receipts_deleted, 0), 1);
    assert.equal(reconciledValues.reduce((sum, value) => sum + value.bank_evidence_deleted, 0), 1);
    assert.equal(reconciledValues.reduce((sum, value) => sum + value.protected, 0), 2);
    await reconcile();
    assert.equal((await q("select count(*)::integer n from receipts where id='new'"))[0].n, 0);
    assert.equal((await q("select count(*)::integer n from receipts where id='edited'"))[0].n, 1);
    assert.deepEqual(await q("select id,review_status from whatsapp_bank_transfer_evidence"), [{ id: "whatsapp-bank-reviewed", review_status: "reviewed" }]);
    assert.equal((await q("select count(*)::integer n from whatsapp_image_reconciliation_audit"))[0].n, 8);
    assert.equal((await q("select total_cents from periods where id='p'"))[0].total_cents, 0);
    assert.deepEqual((await q("select total_cents,per_person_cents,receipt_count,member_totals from settlements where period_id='p'"))[0], {
      total_cents: 0,
      per_person_cents: 0,
      receipt_count: 0,
      member_totals: {
        "Arjun Bhurtel": 0,
        "Arpan Bhurtel": 0,
        "Shiva Kafle": 0,
        "Swasti Adhikari": 0,
      },
    });
    assert.deepEqual((await q("select owes from settlements"))[0].owes, { "Shiva Kafle": { "Arjun Bhurtel": 250 } });
    assert.equal((await q("select payment_obligations_status from settlements"))[0].payment_obligations_status, "UNINITIALIZED");
    await assert.rejects(() => q("select reconcile_deleted_whatsapp_images($1::uuid,'wrong','p',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1)", [reconciliationJobId, JSON.stringify(deletionEvidence)]), /lease/i);
    await q("update sync_requests set status='failed',lease_expires_at=null where id=$1", [reconciliationJobId]);
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
    assert.equal((await q("select has_function_privilege('authenticated','public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text,bigint)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.finalize_sync_request(uuid,text,text,jsonb,text[],text,text,bigint)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb,bigint)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_period_cycle_state(uuid,text,text,text,jsonb,jsonb,bigint)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('service_role','public.record_period_cycle_state_v7(uuid,text,text,text,jsonb,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('authenticated','public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_whatsapp_bank_evidence(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.record_whatsapp_bank_evidence(uuid,text,text,jsonb,bigint)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_whatsapp_bank_evidence(uuid,text,text,jsonb,bigint)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('service_role','public.record_whatsapp_bank_evidence_v6(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.record_whatsapp_bank_evidence_v7(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('authenticated','public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb,bigint)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.prepare_instabox_whatsapp_sources(uuid,text,text,jsonb,bigint)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select has_function_privilege('authenticated','public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.reconcile_deleted_whatsapp_images(uuid,text,text,jsonb,text[],text)','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select count(*)::integer n from pg_policies where schemaname='public' and tablename in ('receipts','periods','settlements') and permissive='PERMISSIVE' and 'public'::name=any(roles)"))[0].n, 0);
    assert.equal((await q("select count(*)::integer n from pg_policies where policyname like 'production_%'"))[0].n, 5);
    await q("insert into sync_requests(id,requested_by,status) values($1,'netlify-app','pending')", [job3Id]);
    await q("select * from claim_sync_request('rollover-worker')");
    const clearanceTimestamp = Math.floor(new Date("2026-10-31T12:30:00Z").getTime() / 1000);
    const clearance = {
      id: "clearance-31-oct", timestamp: clearanceTimestamp, dateStr: "2026-10-31",
      source: "marker", confidence: "HIGH", text: "Clear up to date",
      group_identity_hash: groupIdentityHash, cycle_start_boundary_id: cycleBoundaryId,
    };
    const rolloverArgs = [
      job3Id, "rollover-worker", "p", "2026-10-31", JSON.stringify(clearance),
      "period_2026-10-31", "settlement_2026-10-31_current", "2026-10-31",
      JSON.stringify(clearance), "ACTIVE", null,
      ["Shiva Kafle", "Arjun Bhurtel", "Arpan Bhurtel", "Swasti Adhikari"],
    ];
    rolloverArgs.push(1);
    const rolloverSql = "select rollover_settlement_period($1::uuid,$2,$3,$4::date,$5::jsonb,$6,$7,$8::date,$9::jsonb,$10,$11::jsonb,$12::text[],$13::bigint)";
    await q("update instabox_worker_control set automatic_rollover_after='2026-11-02T00:00:00Z'");
    await assert.rejects(() => q(rolloverSql, rolloverArgs), /explicitly reviewed approval/i);
    await q("insert into instabox_rollover_approvals(old_period_id,clearance_message_id,new_period_id,reviewed_by) values('p','clearance-31-oct','period_2026-10-31','operator-test')");
    await q("insert into periods(id,start_date,end_date,status,total_cents,per_person_cents,receipt_count) values('ambiguous-history','2026-08-01','2026-08-31','ARCHIVED',0,0,0)");
    await assert.rejects(() => q(rolloverSql, rolloverArgs), /status convention/i);
    await q("delete from periods where id='ambiguous-history'");
    await q("insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url) values('misassigned-november','p','2026-11-02T01:00:00Z','Wrong period',100,'Shiva Kafle','Groceries','2026-11-02',false,'storage://bill-evidence/wrong.jpg')");
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
      id: "settlement_2026-10-01_current", owes: { "Shiva Kafle": { "Arjun Bhurtel": 250 } },
    });
    const placeholder = (await q("select * from settlements where period_id='period_2026-10-31'"))[0];
    assert.equal(placeholder.id, "settlement_2026-10-31_current");
    assert.equal(placeholder.owes, null);
    assert.equal(placeholder.payment_obligations_status, "UNINITIALIZED");
    const novemberRows = [{ id: "nov-2", period_id: "period_2026-10-31", captured_at: "2026-11-02T01:00:00Z", merchant: "November Market", amount_cents: 400, payer: "Arjun Bhurtel", category: "Groceries", date: "2026-11-02", is_excluded: false, image_url: "storage://bill-evidence/nov-2.jpg" }];
    await q("select finalize_sync_request($1::uuid,'rollover-worker','period_2026-10-31',$2::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round','existing-only',1)", [job3Id, JSON.stringify(novemberRows)]);
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 1);
    assert.equal((await q("select owes from settlements where id='settlement_2026-10-31_current'"))[0].owes, null);
    assert.equal((await q("select has_function_privilege('authenticated','public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])','execute') as allowed"))[0].allowed, false);
    assert.equal((await q("select has_function_privilege('service_role','public.rollover_settlement_period(uuid,text,text,date,jsonb,text,text,date,jsonb,text,jsonb,text[])','execute') as allowed"))[0].allowed, true);
    assert.equal((await q("select instabox_worker_capabilities() as value"))[0].value.version, 8);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='period_2026-10-31' and participation_mode='enabled'"))[0].n, 4);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='historical'"))[0].n, 0);
    await q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url)
      values('swasti-visible','period_2026-10-31','2026-11-03T01:00:00Z','Member Market',200,'Swasti Adhikari','Groceries','2026-11-03',false,'storage://bill-evidence/swasti.jpg'),
      ('swasti-manual-exclusion','period_2026-10-31','2026-11-03T02:00:00Z','Excluded Market',999,'Swasti Adhikari','Groceries','2026-11-03',true,'storage://bill-evidence/swasti-excluded.jpg')`);
    await q(`insert into household_auth_identities(auth_user_id,member_name,household_role,verified_by) values
      ('aaaaaaaa-1111-4111-8111-111111111111','Shiva Kafle','admin','sql-test'),
      ('bbbbbbbb-2222-4222-8222-222222222222','Arjun Bhurtel','admin','sql-test'),
      ('cccccccc-3333-4333-8333-333333333333','Arpan Bhurtel','member','sql-test'),
      ('dddddddd-4444-4444-8444-444444444444','Swasti Adhikari','member','sql-test')`);
    await q("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','eeeeeeee-5555-4555-8555-555555555555',false)");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: false, can_view: false,
    });
    await assert.rejects(() => q("select get_settlement_cycle_membership('period_2026-10-31')"), /UNAUTHORIZED_MEMBERSHIP_ACCESS/);
    await assert.rejects(() => q("select settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari')"), /UNAUTHORIZED_MEMBERSHIP_ACCESS/);
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','disabled',1)"), /UNAUTHORIZED_MEMBERSHIP_CHANGE/);
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub','cccccccc-3333-4333-8333-333333333333',false)");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: false, can_view: true,
    });
    assert.equal((await q("select count(*)::integer n from receipts where period_id='p'"))[0].n, 1);
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','disabled',1)"), /UNAUTHORIZED_MEMBERSHIP_CHANGE/);
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub','dddddddd-4444-4444-8444-444444444444',false)");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: false, can_view: true,
    });
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub','bbbbbbbb-2222-4222-8222-222222222222',false)");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: true, can_review_disabled_receipts: true, can_view: true,
    });
    await db.exec("reset role");
    await q("select set_config('request.jwt.claim.sub','aaaaaaaa-1111-4111-8111-111111111111',false)");
    await db.exec("set role authenticated");
    const initialMembership = (await q("select get_settlement_cycle_membership('period_2026-10-31') value"))[0].value;
    assert.equal(initialMembership.revision, 1);
    assert.deepEqual(Object.keys(initialMembership).sort(), ["members", "period_id", "permissions", "revision", "status"]);
    assert.equal(initialMembership.members.length, 4);
    assert.ok(initialMembership.members.every((member) =>
      ["enabled", "keep_receipts", "disabled"].includes(member.participation_mode)));
    assert.deepEqual(initialMembership.permissions, {
      can_edit: true, can_review_disabled_receipts: true, can_view: true,
    });
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Unknown Member','disabled',1)"), /INVALID_MEMBER_IDENTITY/);
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','unknown',1)"), /INVALID_PARTICIPATION_MODE/);
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('p') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: true, can_view: true,
    });
    const mutation = (await q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','keep_receipts',1) value"))[0].value;
    assert.equal(mutation.revision, 2);
    assert.deepEqual(mutation.permissions, initialMembership.permissions);
    const keepPreview = (await q("select preview_settlement_cycle_membership('period_2026-10-31') value"))[0].value;
    assert.equal(keepPreview.total_cents, 600);
    assert.equal(keepPreview.equal_share_cents, 200);
    assert.equal(keepPreview.members.find((member) => member.member_name==='Swasti Adhikari').paid_cents, 200);
    assert.equal(keepPreview.members.find((member) => member.member_name==='Swasti Adhikari').share_cents, 0);
    assert.equal(keepPreview.members.reduce((sum, member) => sum+member.net_cents,0), 0);
    assert.deepEqual(Object.keys(keepPreview).sort(), [
      "equal_share_cents", "members", "period_id", "permissions", "receipt_count", "revision", "total_cents",
    ]);
    assert.deepEqual(keepPreview.permissions, initialMembership.permissions);
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','disabled',1)"), /STALE_MEMBERSHIP_REVISION/);
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','disabled',2)");
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 1);
    assert.equal((await q("select total_cents from periods where id='period_2026-10-31'"))[0].total_cents, 400);
    assert.equal((await q("select count(*)::integer n from get_disabled_settlement_receipts('period_2026-10-31')"))[0].n, 2);
    await db.exec("reset role");
    await q("insert into storage.objects(id,bucket_id,name) values('disabled-object','bill-evidence','swasti.jpg'),('unlinked-object','bill-evidence','bank/unlinked.jpg')");
    await db.exec("set role authenticated");
    assert.equal((await q("select count(*)::integer n from storage.objects where bucket_id='bill-evidence'"))[0].n, 2);
    await q("select set_config('request.jwt.claim.sub','cccccccc-3333-4333-8333-333333333333',false)");
    assert.equal((await q("select count(*)::integer n from storage.objects where bucket_id='bill-evidence'"))[0].n, 1);
    await assert.rejects(() => q("select * from get_disabled_settlement_receipts('period_2026-10-31')"), /UNAUTHORIZED_MEMBERSHIP_CHANGE/);
    await q("select set_config('request.jwt.claim.sub','aaaaaaaa-1111-4111-8111-111111111111',false)");
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','enabled',3)");
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 3);
    assert.equal((await q("select is_excluded from receipts where id='swasti-manual-exclusion'"))[0].is_excluded, true);
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('p','Swasti Adhikari','disabled',1)"), /CLOSED_CYCLE_MEMBERSHIP_CHANGE/);
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Arjun Bhurtel','keep_receipts',4)");
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Arpan Bhurtel','keep_receipts',5)");
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Shiva Kafle','keep_receipts',6)");
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','disabled',7)"), /ZERO_ENABLED_MEMBERS/);
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Arjun Bhurtel','enabled',7)");
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Arpan Bhurtel','enabled',8)");
    await q("select set_settlement_cycle_member_mode('period_2026-10-31','Shiva Kafle','enabled',9)");
    await db.exec("reset role");
    await q("update settlements set payment_obligations_status='REVIEWED' where period_id='period_2026-10-31'");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: true, can_view: true,
    });
    await assert.rejects(() => q("select set_settlement_cycle_member_mode('period_2026-10-31','Swasti Adhikari','keep_receipts',10)"), /FINALIZED_OBLIGATIONS/);
    await db.exec("reset role");
    await q("update settlements set payment_obligations_status=null where period_id='period_2026-10-31'");
    await db.exec("set role authenticated");
    assert.deepEqual((await q("select get_settlement_cycle_membership_permissions('period_2026-10-31') value"))[0].value, {
      can_edit: false, can_review_disabled_receipts: true, can_view: true,
    });
    await db.exec("reset role");
    await q("update settlements set payment_obligations_status='REVIEWED' where period_id='period_2026-10-31'");
    assert.equal((await q("select verification_status from bank_transfer_receipts"))[0].verification_status, null);
    const membershipMigration = fs.readFileSync("supabase/migrations/20261118000000_settlement_cycle_membership.sql", "utf8");
    await db.exec(membershipMigration);
    assert.equal((await q("select revision from settlement_cycle_membership_state where period_id='period_2026-10-31'"))[0].revision, 10);
    assert.equal((await q("select payment_obligations_status from settlements where period_id='period_2026-10-31'"))[0].payment_obligations_status, "REVIEWED");
    assert.equal((await q("select count(*)::integer n from whatsapp_image_reconciliation_audit"))[0].n, 8);
    assert.equal((await q("select count(*)::integer n from whatsapp_image_reconciliation_audit where previous_record ? 'reference_number' or previous_record ? 'recipient_name'"))[0].n, 0);
    await db.exec("set role authenticated");
    await assert.rejects(() => db.exec("delete from receipts where id='edited'"), /permission denied|row-level security/i);
    await assert.rejects(() => db.exec("select reconcile_deleted_whatsapp_images('11111111-1111-4111-8111-111111111111','evil','p','[]'::jsonb,array['Shiva Kafle','Arjun Bhurtel','Arpan Bhurtel','Swasti Adhikari'],'round',1)"), /permission denied/i);
    await assert.rejects(() => db.exec("insert into sync_requests(id,requested_by,status,worker_id) values('55555555-5555-4555-8555-555555555555','netlify-app','processing','evil')"), /row-level security/);
    await db.exec("insert into sync_requests(id,requested_by,status) values('44444444-4444-4444-8444-444444444444','netlify-app','pending')");
    assert.equal((await q("select count(*)::integer n from receipts"))[0].n, 4);
    await db.exec("reset role");
    await db.exec("set role anon");
    await assert.rejects(() => q("select get_settlement_cycle_membership_permissions('period_2026-10-31')"), /permission denied/i);
    await assert.rejects(() => q("select * from receipts"), /permission denied/i);
    await assert.rejects(() => q("select get_settlement_cycle_membership('period_2026-10-31')"), /permission denied/i);
    await db.exec("reset role");
  } finally { await db.close(); }
});
