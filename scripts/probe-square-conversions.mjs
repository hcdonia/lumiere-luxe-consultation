// READ-ONLY probe: did any Square booking that SHOULD fire the Google Ads
// conversion send actually come through since we deployed (2026-07-08)?
// Mirrors the exact gate in api/square-webhook.mjs:
//   sendBookingConversion fires when  booking.created  &&  status in {PENDING,ACCEPTED}
//   &&  isNewCustomer (customer created within 30 min of the booking)  &&  has email or phone.
// Sends nothing, writes nothing. Usage: node --env-file=.env.local scripts/probe-square-conversions.mjs

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const SALON_TZ = 'America/Los_Angeles';
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const ACTIVE = new Set(['PENDING', 'ACCEPTED']);
const DEPLOY_CUTOFF = '2026-07-08T00:00:00Z'; // when the conversion send went live

const TOKEN = (process.env.SQUARE_ACCESS_TOKEN || '').replace(/﻿/g, '').replace(/[\r\n]/g, '').trim();
console.log(`SQUARE_ACCESS_TOKEN loaded: ${TOKEN ? 'yes' : 'NO'} (length ${TOKEN.length}, starts "${TOKEN.slice(0, 4)}…")`);

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': '2025-03-19' },
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* leave {} */ }
  return { status: res.status, json, text };
}
const fmt = (iso) => iso ? new Intl.DateTimeFormat('en-US', { timeZone: SALON_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) : '(none)';

async function main() {
  // Sweep a wide appointment range in 30-day chunks (Square caps each query at 31
  // days): from 10 days back to 80 days forward, catching essentially every booking
  // created recently regardless of how far out its appointment is.
  const byId = new Map();
  for (let offset = -10; offset < 80; offset += 30) {
    const min = new Date(Date.now() + offset * 864e5).toISOString();
    const max = new Date(Date.now() + (offset + 30) * 864e5).toISOString();
    const bk = await squareGet(`/v2/bookings?location_id=${LOCATION_ID}&start_at_min=${min}&start_at_max=${max}&limit=200`);
    console.log(`ListBookings ${fmt(min)}–${fmt(max)}: HTTP ${bk.status}, ${(bk.json.bookings || []).length} bookings`);
    if (bk.json.errors && bk.json.errors.length) { console.log('Square errors:', JSON.stringify(bk.json.errors, null, 2)); return; }
    if (bk.status !== 200) { console.log('Non-200 body snippet:', bk.text.slice(0, 400)); return; }
    for (const b of (bk.json.bookings || [])) byId.set(b.id, b);
  }
  const all = [...byId.values()];
  const sinceDeploy = all.filter((b) => b.created_at && b.created_at >= DEPLOY_CUTOFF);
  console.log(`\nBookings across the sweep: ${all.length} total, ${sinceDeploy.length} created since deploy (${DEPLOY_CUTOFF}).\n`);

  const wouldConvert = [], wouldNot = [];
  for (const b of sinceDeploy) {
    const row = { made: fmt(b.created_at), appt: fmt(b.start_at), status: b.status };
    if (!b.customer_id) { row.reason = 'no customer_id'; wouldNot.push(row); continue; }
    const c = (await squareGet(`/v2/customers/${b.customer_id}`)).json.customer || {};
    row.client = `${c.given_name || ''} ${c.family_name || ''}`.trim() || '(no name)';
    row.hasEmail = !!c.email_address;
    row.hasPhone = !!c.phone_number;
    const isNew = c.created_at ? Math.abs(new Date(b.created_at) - new Date(c.created_at)) / 6e4 <= NEW_CUSTOMER_THRESHOLD_MINUTES : false;
    if (!ACTIVE.has(b.status)) { row.reason = `status ${b.status} (not PENDING/ACCEPTED)`; wouldNot.push(row); continue; }
    if (!isNew) { row.reason = 'returning/existing customer (not new)'; wouldNot.push(row); continue; }
    if (!c.email_address && !c.phone_number) { row.reason = 'no email or phone to match on'; wouldNot.push(row); continue; }
    wouldConvert.push(row);
  }

  console.log(`SHOULD have created a conversion row (${wouldConvert.length}):`);
  for (const r of wouldConvert) console.log(`  made ${r.made.padEnd(14)} appt ${r.appt.padEnd(14)} ${r.client.padEnd(22)} email=${r.hasEmail} phone=${r.hasPhone} [${r.status}]`);
  console.log(`\nWould NOT convert (${wouldNot.length}):`);
  for (const r of wouldNot) console.log(`  made ${r.made.padEnd(14)} appt ${r.appt.padEnd(14)} ${(r.client || '').padEnd(22)} — ${r.reason}`);
  console.log(`\n==> ${wouldConvert.length} booking(s) since deploy should be in the Sheet. Sheet currently has 0 real rows (only the test row).`);
  console.log(wouldConvert.length === 0
    ? '==> VERDICT: no qualifying bookings yet — empty Sheet is expected, pipeline not yet exercised.\n'
    : '==> VERDICT: qualifying bookings exist but Sheet is empty — the webhook→Sheet send is likely BROKEN. Investigate.\n');
}

main().catch((e) => console.error('probe failed:', e));
