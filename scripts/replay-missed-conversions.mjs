// Diagnostic + backfill: find every booking since deploy that SHOULD have created
// a Google Ads conversion row, and replay it through the EXACT send logic from
// api/square-webhook.mjs against the live Apps Script endpoint. Idempotent — the
// Apps Script dedups by Order ID, so re-running (or a later real webhook) won't
// double-count. Reports latency + response per booking so we can see if the
// endpoint itself is the failure point.
//
// Usage (uses the pulled production env so URL+secret+square token match prod):
//   node --env-file="<scratchpad>/prod.env" scripts/replay-missed-conversions.mjs
//
// Add DRY=1 to skip the POST and only list what WOULD be sent:
//   DRY=1 node --env-file=... scripts/replay-missed-conversions.mjs

import { createHash } from 'crypto';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const ACTIVE = new Set(['PENDING', 'ACCEPTED']);
const DEPLOY_CUTOFF = '2026-07-08T00:00:00Z';
const DRY = process.env.DRY === '1';

const TOKEN = (process.env.SQUARE_ACCESS_TOKEN || '').replace(/﻿/g, '').replace(/[\r\n]/g, '').trim();
const SHEETS_URL = (process.env.GOOGLE_SHEETS_WEBHOOK_URL || '').trim();
const SHEETS_SECRET = (process.env.GOOGLE_SHEETS_WEBHOOK_SECRET || '').trim();

// --- exact hashing helpers copied from api/square-webhook.mjs ---
function sha256Hex(v) { return createHash('sha256').update(v, 'utf8').digest('hex'); }
function hashEmail(email) { const e = (email || '').trim().toLowerCase(); return e ? sha256Hex(e) : ''; }
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}
function hashPhone(phone) { const e164 = toE164(phone); return e164 ? sha256Hex(e164) : ''; }

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Square-Version': '2025-03-19' },
  });
  return res.json();
}

async function sendOne(customer, booking) {
  const payload = {
    secret: SHEETS_SECRET,
    conversionName: 'Square Booking',
    conversionTime: booking.created_at || new Date().toISOString(),
    email: hashEmail(customer.email_address),
    phone: hashPhone(customer.phone_number),
    gclid: '', value: '', currency: '',
    orderId: booking.id || '',
  };
  const t0 = Date.now();
  const res = await fetch(SHEETS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  return { ok: res.ok, status: res.status, ms, body: text.slice(0, 300) };
}

async function main() {
  console.log(`env: square=${TOKEN ? 'ok' : 'MISSING'} sheetsUrl=${SHEETS_URL ? 'ok' : 'MISSING'} secret=${SHEETS_SECRET ? 'ok' : 'MISSING'}  DRY=${DRY}\n`);

  const byId = new Map();
  for (let offset = -10; offset < 80; offset += 30) {
    const min = new Date(Date.now() + offset * 864e5).toISOString();
    const max = new Date(Date.now() + (offset + 30) * 864e5).toISOString();
    const bk = await squareGet(`/v2/bookings?location_id=${LOCATION_ID}&start_at_min=${min}&start_at_max=${max}&limit=200`);
    if (bk.errors && bk.errors.length) { console.log('Square error:', JSON.stringify(bk.errors)); return; }
    for (const b of (bk.bookings || [])) byId.set(b.id, b);
  }

  const qualifying = [];
  for (const b of byId.values()) {
    if (!b.created_at || b.created_at < DEPLOY_CUTOFF) continue;
    if (!ACTIVE.has(b.status)) continue;
    if (!b.customer_id) continue;
    const c = (await squareGet(`/v2/customers/${b.customer_id}`)).customer || {};
    const isNew = c.created_at ? Math.abs(new Date(b.created_at) - new Date(c.created_at)) / 6e4 <= NEW_CUSTOMER_THRESHOLD_MINUTES : false;
    if (!isNew) continue;
    if (!c.email_address && !c.phone_number) continue;
    qualifying.push({ b, c });
  }

  console.log(`Qualifying bookings since deploy: ${qualifying.length}\n`);
  for (const { b, c } of qualifying) {
    const who = `${c.given_name || ''} ${c.family_name || ''}`.trim();
    if (DRY) { console.log(`  [DRY] ${who}  order=${b.id}  email=${!!c.email_address} phone=${!!c.phone_number}`); continue; }
    const r = await sendOne(c, b);
    console.log(`  ${who.padEnd(20)} order=${b.id}`);
    console.log(`     -> HTTP ${r.status} in ${r.ms}ms  ${r.body}`);
  }
  console.log('\nDone. Re-run is safe (dedups by Order ID).');
}

main().catch((e) => console.error('replay failed:', e));
