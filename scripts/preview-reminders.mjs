// Dry-run: shows who would be texted tomorrow without actually sending anything.
// Usage: node --env-file=.env.local scripts/preview-reminders.mjs

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const SALON_TZ = 'America/Los_Angeles';

async function squareFetch(method, path, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function tomorrowRangeUtc(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SALON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: 'numeric',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const todayLocal = `${get('year')}-${get('month')}-${get('day')}`;
  const tomorrowMidnightLocal = new Date(`${todayLocal}T00:00:00`);
  tomorrowMidnightLocal.setDate(tomorrowMidnightLocal.getDate() + 1);

  const toUtcInstant = (wallClockLocalDate) => {
    const guess = new Date(wallClockLocalDate.toISOString());
    const offsetMs = guess.getTime() - new Date(
      guess.toLocaleString('en-US', { timeZone: SALON_TZ })
    ).getTime();
    return new Date(guess.getTime() + offsetMs);
  };

  const startUtc = toUtcInstant(tomorrowMidnightLocal);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startAtMin: startUtc.toISOString(), startAtMax: endUtc.toISOString() };
}

const now = new Date();
const { startAtMin, startAtMax } = tomorrowRangeUtc(now);

const tomorrowLabel = new Intl.DateTimeFormat('en-US', {
  timeZone: SALON_TZ,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
}).format(new Date(startAtMin));

console.log(`\nTomorrow in LA: ${tomorrowLabel}`);
console.log(`Window (UTC): ${startAtMin} → ${startAtMax}\n`);

const params = new URLSearchParams({
  location_id: LOCATION_ID,
  start_at_min: startAtMin,
  start_at_max: startAtMax,
  limit: '200',
});
const search = await squareFetch('GET', `/v2/bookings?${params.toString()}`);

const bookings = search.bookings || [];
if (bookings.length === 0) {
  console.log('No bookings found for tomorrow.\n');
  process.exit(0);
}

const fmtTime = (iso) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: SALON_TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));

const rows = [];
for (const b of bookings) {
  const row = { time: fmtTime(b.start_at), startAt: b.start_at, bookingId: b.id, status: b.status };
  if (b.status !== 'ACCEPTED') {
    row.willText = false;
    row.reason = `status=${b.status}`;
    rows.push(row);
    continue;
  }
  if (!b.customer_id) {
    row.willText = false;
    row.reason = 'no customer_id';
    rows.push(row);
    continue;
  }
  const c = await squareFetch('GET', `/v2/customers/${b.customer_id}`);
  const customer = c.customer;
  const name = `${customer?.given_name || ''} ${customer?.family_name || ''}`.trim() || '(no name)';
  row.client = name;
  row.phone = customer?.phone_number || '(none)';
  if (!customer?.phone_number) {
    row.willText = false;
    row.reason = 'no phone on file';
  } else if ((customer?.note || '').includes(`[REMINDED:${b.id}]`)) {
    row.willText = false;
    row.reason = 'already reminded';
  } else {
    row.willText = true;
  }
  rows.push(row);
}

rows.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

const willText = rows.filter((r) => r.willText);
const skipped = rows.filter((r) => !r.willText);

console.log(`WOULD TEXT (${willText.length}):`);
for (const r of willText) {
  console.log(`  ${r.time}  ${r.client.padEnd(28)}  ${r.phone}`);
}
if (skipped.length) {
  console.log(`\nSKIPPED (${skipped.length}):`);
  for (const r of skipped) {
    console.log(`  ${r.time}  ${(r.client || r.bookingId).padEnd(28)}  — ${r.reason}`);
  }
}
console.log();
