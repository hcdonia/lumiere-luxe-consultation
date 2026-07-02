// Dry-run: shows which NEW guests would be texted the new-guest form, and who
// is skipped and why. Sends nothing. Mirrors the detection in api/square-webhook.mjs.
// Usage: node --env-file=.env.local scripts/preview-newguest-nudge.mjs [daysBack] [daysFwd]

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const SALON_TZ = 'America/Los_Angeles';
const NEW_GUEST_FORM_ID = '251448462902155';
const CONSULT_ATTR_KEY = 'square:9084740e-1f93-4c87-8937-cce6569f2faa';
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const JOTFORM_KEY = (process.env.JOTFORM_API_KEY || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const ACTIVE = new Set(['PENDING', 'ACCEPTED']);

// Square caps the ListBookings range at 31 days.
const daysBack = Math.min(Number(process.argv[2] || 8), 15);
const daysFwd = Math.min(Number(process.argv[3] || 22), 15);

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2025-03-19' },
  });
  return res.json();
}
function last10(raw) { if (!raw) return null; const d = String(raw).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; }
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}
async function fetchFormIndex() {
  const LIMIT = 1000, MAX_PAGES = 50;
  const phones = new Set(), emails = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(`https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${JOTFORM_KEY}&limit=${LIMIT}&offset=${page * LIMIT}`);
    if (!res.ok) return { ok: false, phones: new Set(), emails: new Set() };
    const data = await res.json();
    const rows = data.content || [];
    for (const sub of rows) for (const ans of Object.values(sub.answers || {})) {
      if (ans.type === 'control_phone') { const p = last10(ans.answer?.full || ans.answer); if (p) phones.add(p); }
      if (ans.type === 'control_email' && ans.answer) emails.add(String(ans.answer).toLowerCase());
    }
    if (rows.length < LIMIT) return { ok: true, phones, emails };
  }
  return { ok: false, phones: new Set(), emails: new Set() };
}
async function hasAttr(customerId) {
  try { const d = await squareGet(`/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(CONSULT_ATTR_KEY)}`); return !!d.custom_attribute?.value; } catch { return false; }
}
const fmt = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: SALON_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

const formIndex = await fetchFormIndex();
console.log(`\nJotform new-guest submissions loaded: ok=${formIndex.ok}, ${formIndex.phones.size} phones / ${formIndex.emails.size} emails`);
if (!formIndex.ok) { console.log('Jotform lookup FAILED — live handler would fail closed and send nothing.\n'); process.exit(1); }

const min = new Date(Date.now() - daysBack * 864e5).toISOString();
const max = new Date(Date.now() + daysFwd * 864e5).toISOString();
const bk = await squareGet(`/v2/bookings?location_id=${LOCATION_ID}&start_at_min=${min}&start_at_max=${max}&limit=200`);
const bookings = bk.bookings || [];
console.log(`Window: ${daysBack}d back → ${daysFwd}d forward  (${bookings.length} bookings)\n`);

const wouldText = [], skipped = [];
for (const b of bookings) {
  const row = { when: b.start_at ? fmt(b.start_at) : '(no time)', status: b.status };
  if (!b.customer_id) { row.reason = 'no customer'; skipped.push(row); continue; }
  const c = (await squareGet(`/v2/customers/${b.customer_id}`)).customer;
  row.client = `${c?.given_name || ''} ${c?.family_name || ''}`.trim() || '(no name)';
  row.phone = c?.phone_number || '(none)';
  const isNew = c?.created_at ? Math.abs(new Date(b.created_at) - new Date(c.created_at)) / 6e4 <= NEW_CUSTOMER_THRESHOLD_MINUTES : false;
  const p10 = last10(c?.phone_number), email = (c?.email_address || '').toLowerCase();
  const jf = (p10 && formIndex.phones.has(p10)) || (email && formIndex.emails.has(email));
  const attr = await hasAttr(b.customer_id);
  const deposit = (c?.note || '').includes('DEPOSIT PAID');
  const hasForm = jf || attr || !!c?.reference_id || (c?.note || '').includes('Hair Consultation') || deposit;
  if (!isNew) { row.reason = 'returning/existing customer (not new)'; skipped.push(row); continue; }
  if (hasForm) { row.reason = `has form/deposit (jf=${jf} attr=${attr} ref=${!!c?.reference_id} deposit=${deposit})`; skipped.push(row); continue; }
  if (!ACTIVE.has(b.status)) { row.reason = `status ${b.status}`; skipped.push(row); continue; }
  if ((c?.note || '').includes('[NEWGUESTNUDGE:')) { row.reason = 'already nudged'; skipped.push(row); continue; }
  if (!toE164(c?.phone_number)) { row.reason = 'no usable phone'; skipped.push(row); continue; }
  wouldText.push(row);
}

console.log(`WOULD TEXT (${wouldText.length}):`);
for (const r of wouldText) console.log(`  ${r.when.padEnd(16)} ${r.client.padEnd(24)} ${r.phone}`);
console.log(`\nSKIPPED (${skipped.length}):`);
for (const r of skipped) console.log(`  ${r.when.padEnd(16)} ${(r.client || '').padEnd(24)} — ${r.reason}`);
console.log();
