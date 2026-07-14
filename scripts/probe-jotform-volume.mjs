// READ-ONLY: how many people actually complete the new-guest consultation form?
// Answers the "Lead = 0 conversions" puzzle: is it funnel drop-off (few submissions)
// or a tracking gap (submissions exist but Lead conversion isn't recording)?
// Usage: node --env-file=.env.local scripts/probe-jotform-volume.mjs

const NEW_GUEST_FORM_ID = '251448462902155';
const KEY = (process.env.JOTFORM_API_KEY || '').replace(/﻿/g, '').replace(/[\r\n]/g, '').trim();

function daysAgo(iso) { return (Date.now() - new Date(iso).getTime()) / 864e5; }

async function main() {
  console.log(`JOTFORM_API_KEY loaded: ${KEY ? 'yes' : 'NO'} (len ${KEY.length})\n`);
  const res = await fetch(`https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${KEY}&limit=100&orderby=created_at`);
  if (!res.ok) { console.log(`HTTP ${res.status}:`, (await res.text()).slice(0, 300)); return; }
  const data = await res.json();
  const subs = data.content || [];
  console.log(`Total submissions returned (most recent 100): ${subs.length}`);

  const last7 = subs.filter((s) => daysAgo(s.created_at) <= 7).length;
  const last30 = subs.filter((s) => daysAgo(s.created_at) <= 30).length;
  const last90 = subs.filter((s) => daysAgo(s.created_at) <= 90).length;
  console.log(`Submissions in last  7 days: ${last7}`);
  console.log(`Submissions in last 30 days: ${last30}`);
  console.log(`Submissions in last 90 days: ${last90}\n`);

  console.log('Most recent 15 submissions (date — name/email if present):');
  for (const s of subs.slice(0, 15)) {
    let who = '';
    for (const a of Object.values(s.answers || {})) {
      if (a.type === 'control_fullname' && a.answer) who = `${a.answer.first || ''} ${a.answer.last || ''}`.trim();
      if (!who && a.type === 'control_email' && a.answer) who = String(a.answer);
    }
    console.log(`  ${s.created_at}  ${who || '(no name)'}`);
  }
}
main().catch((e) => console.error('probe failed:', e));
