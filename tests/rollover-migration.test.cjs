const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

const members = ["Shiva Kafle", "Arjun Bhurtel", "Arpan Bhurtel", "Swasti Adhikari"];
const jobId = "91919191-1919-4191-8191-919191919191";
const groupHash = "a".repeat(64);
const otherGroupHash = "b".repeat(64);
const startBoundaryId = "clearance-31-oct";
const clearanceTimestamp = Math.floor(new Date("2026-11-18T08:51:00Z").getTime() / 1000);
const startTimestamp = Math.floor(new Date("2026-10-30T13:00:00Z").getTime() / 1000);

async function setupProductionFixture() {
  const db = new PGlite();
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
    create table storage.buckets(id text primary key,name text,public boolean);
    create table storage.objects(id text primary key,bucket_id text,name text);
    alter table storage.objects enable row level security;
    create table public.sync_requests(
      id uuid primary key,requested_by text,status text,stage text,stage_message text,
      stage_updated_at timestamptz,result_summary text,error text,created_at timestamptz default now()
    );
    create table public.periods(
      id text primary key,start_date date,end_date date,status text,total_cents integer,
      per_person_cents integer,receipt_count integer
    );
    create table public.receipts(
      id text primary key,period_id text references public.periods(id),captured_at timestamptz,
      merchant text,amount_cents integer,payer text,category text,date date,
      is_excluded boolean,image_url text
    );
    create table public.settlements(
      id text primary key,period_id text references public.periods(id),total_cents integer,
      per_person_cents integer,member_totals jsonb,receipt_count integer,
      calculated_at timestamptz,owes jsonb
    );
    create table public.bank_transfer_receipts(
      id uuid primary key,period_id text references public.periods(id),step_id text,
      from_name text,to_name text,amount_cents integer,transfer_date date,receipt_url text
    );
    insert into periods values
      ('period_2026-09-30','2026-09-30','2026-10-30','CLOSED',100,25,1),
      ('period_2026-10-31','2026-10-31',null,'CURRENT',95416,23854,28);
    insert into settlements values
      ('settlement_2026-09-30_current','period_2026-09-30',100,25,'{}',1,now(),null),
      ('settlement_2026-10-31_current','period_2026-10-31',95416,23854,
       '{"Shiva Kafle":23854,"Arjun Bhurtel":23854,"Arpan Bhurtel":23854,"Swasti Adhikari":23854}',
       28,'2026-11-18T08:50:00Z',null);
    insert into sync_requests(id,requested_by,status) values('${jobId}','netlify-app','pending');
    insert into storage.buckets values('bill-evidence','bill-evidence',false);
    alter table sync_requests enable row level security;
    alter table receipts enable row level security;
    alter table periods enable row level security;
    alter table settlements enable row level security;
    grant select,insert on sync_requests to authenticated;
    grant select on receipts,periods,settlements to authenticated;
    create policy production_sync_select on sync_requests for select to authenticated using(requested_by='netlify-app');
    create policy production_sync_insert on sync_requests for insert to authenticated with check(requested_by='netlify-app' and status='pending');
    create policy production_receipts_read on receipts for select to authenticated using(true);
    create policy production_periods_read on periods for select to authenticated using(true);
    create policy production_settlements_read on settlements for select to authenticated using(true);
  `);
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  for (let index = 0; index < 28; index += 1) {
    const amount = index === 27 ? 3616 : 3400;
    await q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url)
      values($1,'period_2026-10-31',$2,'Production fixture',$3,$4,'Groceries',$5,false,$6)`, [
      `receipt-${index}`,
      `2026-11-${String(1 + (index % 17)).padStart(2, "0")}T01:00:00Z`,
      amount,
      members[index % members.length],
      `2026-11-${String(1 + (index % 17)).padStart(2, "0")}`,
      `storage://bill-evidence/receipt-${index}.jpg`,
    ]);
  }
  for (const name of fs.readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(`supabase/migrations/${name}`, "utf8"));
  }
  await q("select set_config('request.jwt.claim.role','service_role',false)");
  await db.exec("update instabox_worker_control set writes_enabled=true,automatic_rollover_after='2026-01-01T00:00:00Z'");
  await q("update periods set whatsapp_cycle_status='PENDING_SETTLEMENT',whatsapp_start_boundary=$1::jsonb where id='period_2026-10-31'", [JSON.stringify({
    id: startBoundaryId, timestamp: startTimestamp, dateStr: "2026-10-31", source: "marker", confidence: "HIGH",
  })]);
  await db.exec("update settlements set payment_obligations_status='UNINITIALIZED' where period_id='period_2026-10-31'");
  await q("select * from claim_sync_request('rollover-worker')");
  await q(`insert into instabox_managed_whatsapp_sources(
    source_message_id,period_id,source_kind,group_identity_hash,cycle_start_boundary_id,registration_status,job_id
  ) values('future-managed-source','period_2026-10-31','receipt',$1,$2,'pending',$3::uuid)`, [groupHash, startBoundaryId, jobId]);
  return { db, q };
}

function rolloverArgs(overrides = {}) {
  const clearance = {
    id: "clearance-18-nov", timestamp: clearanceTimestamp, dateStr: "2026-11-18",
    text: "Clear up to date 18th November", source: "marker", confidence: "HIGH",
    group_identity_hash: groupHash, cycle_start_boundary_id: startBoundaryId,
    ...(overrides.clearance || {}),
  };
  const startBoundary = { ...clearance, ...(overrides.startBoundary || {}) };
  return [
    jobId, "rollover-worker", "period_2026-10-31", "2026-11-18", JSON.stringify(clearance),
    "period_2026-11-18", "settlement_2026-11-18_current", "2026-11-18",
    JSON.stringify(startBoundary), "ACTIVE", null, members, 1,
  ];
}

const rolloverSql = `select rollover_settlement_period(
  $1::uuid,$2,$3,$4::date,$5::jsonb,$6,$7,$8::date,$9::jsonb,$10,$11::jsonb,$12::text[],$13::bigint
) value`;

test("verified-clearance migration closes the production null-end fixture atomically and fail-closed", async () => {
  const { db, q } = await setupProductionFixture();
  try {
    const beforePeriod = (await q("select total_cents,per_person_cents,receipt_count,end_date from periods where id='period_2026-10-31'"))[0];
    const beforeSettlement = (await q("select id,total_cents,per_person_cents,receipt_count,owes,payment_obligations_status from settlements where period_id='period_2026-10-31'"))[0];
    assert.deepEqual(beforePeriod, { total_cents: 95416, per_person_cents: 23854, receipt_count: 28, end_date: null });
    assert.deepEqual(beforeSettlement, {
      id: "settlement_2026-10-31_current", total_cents: 95416, per_person_cents: 23854,
      receipt_count: 28, owes: null, payment_obligations_status: "UNINITIALIZED",
    });

    await db.exec("begin");
    await db.exec("savepoint active_null_end");
    await db.exec("update periods set whatsapp_cycle_status='ACTIVE' where id='period_2026-10-31'");
    assert.equal((await q(rolloverSql, rolloverArgs()))[0].value.replayed, false);
    await db.exec("rollback to savepoint active_null_end");

    await db.exec("savepoint conflicting_end");
    await db.exec("update periods set end_date='2026-11-17' where id='period_2026-10-31'");
    await assert.rejects(() => q(rolloverSql, rolloverArgs()), /conflicts with verified clearance date/i);
    await db.exec("rollback to savepoint conflicting_end");

    await db.exec("savepoint historical_marker");
    await assert.rejects(() => q(rolloverSql, rolloverArgs({ clearance: { cycle_start_boundary_id: "another-period" } })), /cycle-start boundary/i);
    await db.exec("rollback to savepoint historical_marker");

    await db.exec("savepoint wrong_group");
    await assert.rejects(() => q(rolloverSql, rolloverArgs({
      clearance: { group_identity_hash: otherGroupHash },
      startBoundary: { group_identity_hash: otherGroupHash },
    })), /registered WhatsApp provenance/i);
    await db.exec("rollback to savepoint wrong_group");

    await db.exec("savepoint stale_revision");
    const staleArgs = rolloverArgs(); staleArgs[12] = 2;
    await assert.rejects(() => q(rolloverSql, staleArgs), /STALE_MEMBERSHIP_REVISION/);
    await db.exec("rollback to savepoint stale_revision");

    await db.exec("savepoint lost_lease");
    await db.exec(`update sync_requests set lease_expires_at=now()-interval '1 second' where id='${jobId}'`);
    await assert.rejects(() => q(rolloverSql, rolloverArgs()), /Lost job lease/);
    await db.exec("rollback to savepoint lost_lease");

    await db.exec("savepoint receipt_after_boundary");
    await q(`insert into receipts(id,period_id,captured_at,merchant,amount_cents,payer,category,date,is_excluded,image_url)
      values('after-boundary','period_2026-10-31','2026-11-18T08:51:01Z','Late',1,'Shiva Kafle','Other','2026-11-18',false,'late')`);
    await assert.rejects(() => q(rolloverSql, rolloverArgs()), /receipts after clearance/i);
    await db.exec("rollback to savepoint receipt_after_boundary");

    const [first, replay] = await Promise.all([
      q(rolloverSql, rolloverArgs()),
      q(rolloverSql, rolloverArgs()),
    ]);
    assert.deepEqual([first[0].value.replayed, replay[0].value.replayed].sort(), [false, true]);
    await db.exec("commit");

    const closed = (await q("select status,end_date,total_cents,per_person_cents,receipt_count from periods where id='period_2026-10-31'"))[0];
    assert.equal(closed.end_date.toISOString().slice(0, 10), "2026-11-18");
    assert.deepEqual({ ...closed, end_date: "2026-11-18" }, {
      status: "CLOSED", end_date: "2026-11-18", total_cents: 95416, per_person_cents: 23854, receipt_count: 28,
    });
    assert.deepEqual((await q("select id,total_cents,per_person_cents,receipt_count,owes,payment_obligations_status from settlements where period_id='period_2026-10-31'"))[0], beforeSettlement);
    assert.equal((await q("select count(*)::integer n from receipts where period_id='period_2026-10-31'"))[0].n, 28);
    const opened = (await q("select status,start_date,end_date from periods where id='period_2026-11-18'"))[0];
    assert.equal(opened.start_date.toISOString().slice(0, 10), "2026-11-18");
    assert.deepEqual({ ...opened, start_date: "2026-11-18" }, {
      status: "CURRENT", start_date: "2026-11-18", end_date: null,
    });
    assert.deepEqual((await q("select owes,payment_obligations_status from settlements where period_id='period_2026-11-18'"))[0], {
      owes: null, payment_obligations_status: "UNINITIALIZED",
    });
    assert.equal((await q("select revision from settlement_cycle_membership_state where period_id='period_2026-11-18'"))[0].revision, 1);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='period_2026-11-18' and participation_mode='enabled'"))[0].n, 4);
    assert.equal((await q("select count(*)::integer n from settlement_cycle_members where period_id='period_2026-09-30'"))[0].n, 0);
    assert.equal((await q("select instabox_worker_capabilities() value"))[0].value.version, 8);

    await db.exec(fs.readFileSync("supabase/migrations/20261118000001_verified_clearance_rollover.sql", "utf8"));
    assert.equal((await q("select count(*)::integer n from periods where status='CURRENT'"))[0].n, 1);
    assert.equal((await q("select count(*)::integer n from settlements where period_id='period_2026-11-18'"))[0].n, 1);
  } finally {
    await db.close();
  }
});
