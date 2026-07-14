// READ-ONLY: do consultation-form submissions carry a gclid (ad-click id)?
// Decides the "Lead = 0" puzzle: gclids present => ad-clickers DO reach the form
// (so Lead tracking/attribution is broken); all empty => ad clicks bounce before
// the form, or the gclid passthrough is broken.
// Usage: node --env-file=.env.local scripts/probe-jotform-gclid.mjs

const NEW_GUEST_FORM_ID = '251448462902155';
const KEY = (process.env.JOTFORM_API_KEY || '').replace(/﻿/g, '').replace(/[\r\n]/g, '').trim();
const daysAgo = (iso) => (Date.now() - new Date(iso).getTime()) / 864e5;

// Pull a gclid-ish value out of a submission's answers, whatever the field is named.
function extract(sub) {
  let email = '', gclid = '', allFieldNames = [];
  for (const a of Object.values(sub.answers || {})) {
    const name = (a.name || '').toLowerCase();
    const text = (a.text || '').toLowerCase();
    allFieldNames.push(a.name || a.text || a.type);
    if (a.type === 'control_email' && a.answer) email = String(a.answer);
    if (name.includes('gclid') || text.includes('gclid')) {
      gclid = typeof a.answer === 'string' ? a.answer : JSON.stringify(a.answer || '');
    }
  }
  return { email, gclid, allFieldNames };
}

async function main() {
  const res = await fetch(`https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${KEY}&limit=40&orderby=created_at`);
  if (!res.ok) { console.log(`HTTP ${res.status}:`, (await res.text()).slice(0, 300)); return; }
  const subs = (await res.json()).content || [];

  // Show the field list once so we can confirm a gclid field even exists on the form.
  if (subs.length) console.log('Fields on the form:', [...new Set(extract(subs[0]).allFieldNames)].join(' | '), '\n');

  const recent = subs.filter((s) => daysAgo(s.created_at) <= 45);
  let withGclid = 0;
  console.log(`Recent submissions (<=45d): ${recent.length}\n  date        gclid?    email`);
  for (const s of recent) {
    const { email, gclid } = extract(s);
    const has = gclid && gclid !== '""' && gclid !== '{}';
    if (has) withGclid++;
    console.log(`  ${s.created_at.slice(0, 10)}  ${has ? 'YES ' + gclid.slice(0, 18) : 'no       '}  ${email}`);
  }
  console.log(`\n==> ${withGclid} of ${recent.length} recent submissions carry a gclid.`);
  console.log(withGclid === 0
    ? '==> Either ad-clickers are not completing the form, or the gclid passthrough is broken. Test the passthrough next.'
    : '==> Ad-clickers ARE reaching the form -> the Lead conversion should be firing. Tracking/attribution is the suspect.');
}
main().catch((e) => console.error('probe failed:', e));
