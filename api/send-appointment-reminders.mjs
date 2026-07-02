const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const JOTFORM_LINK = 'https://form.jotform.com/260438977572067';
const SALON_TZ = 'America/Los_Angeles';
const FIRE_HOUR_EVENING = 19; // 7pm LA: remind all of tomorrow's guests
const FIRE_HOUR_MORNING = 8;  // 8am LA: catch guests still coming today who booked after last night's run

const messageBody = (greeting) =>
  `${greeting} from Lumiere Luxe, please fill out this form to make sure we can prepare for your salon visit today. ` +
  "We can't wait to see you and get you to your hair goals! " +
  JOTFORM_LINK;

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

async function searchBookings(startAtMin, startAtMax) {
  const params = new URLSearchParams({
    location_id: LOCATION_ID,
    start_at_min: startAtMin,
    start_at_max: startAtMax,
    limit: '200',
  });
  const data = await squareFetch('GET', `/v2/bookings?${params.toString()}`);
  return data.bookings || [];
}

async function getCustomer(customerId) {
  const data = await squareFetch('GET', `/v2/customers/${customerId}`);
  return data.customer;
}

async function updateCustomerNote(customerId, note) {
  return squareFetch('PUT', `/v2/customers/${customerId}`, { note });
}

// Quo/OpenPhone requires E.164. Square may return "(310) 555-1234" or "+1310...".
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

async function sendQuoSms(toPhone, content) {
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: process.env.OPENPHONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.OPENPHONE_FROM_NUMBER,
      to: [toPhone],
      content,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Quo ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function laHour(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SALON_TZ,
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(fmt.format(date), 10);
}

// Returns ISO timestamps spanning the salon-local day `offsetDays` from today
// (0 = today, 1 = tomorrow). e.g. offset 1 on Mon 7pm LA → [Tue 00:00 LA, Wed 00:00 LA].
function dayRangeUtc(now, offsetDays) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SALON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const todayLocal = `${get('year')}-${get('month')}-${get('day')}`;
  // Guard: never let a malformed date silently produce an Invalid Date (this is
  // what broke single-digit days like the 1st-9th when day was 'numeric').
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayLocal) || Number.isNaN(new Date(`${todayLocal}T00:00:00`).getTime())) {
    throw new Error(`dayRangeUtc: bad local date "${todayLocal}" from parts ${JSON.stringify(parts)}`);
  }
  const targetMidnightLocal = new Date(`${todayLocal}T00:00:00`);
  targetMidnightLocal.setDate(targetMidnightLocal.getDate() + offsetDays);
  // Derive the END from the NEXT local midnight (not start+24h) so DST-change
  // days (23h/25h) still span exactly one salon-local day.
  const nextMidnightLocal = new Date(`${todayLocal}T00:00:00`);
  nextMidnightLocal.setDate(nextMidnightLocal.getDate() + offsetDays + 1);

  // Convert a "wall-clock" salon-local date to its UTC instant.
  const toUtcInstant = (wallClockLocalDate) => {
    const guess = new Date(wallClockLocalDate.toISOString());
    const offsetMs = guess.getTime() - new Date(
      guess.toLocaleString('en-US', { timeZone: SALON_TZ })
    ).getTime();
    return new Date(guess.getTime() + offsetMs);
  };

  const startUtc = toUtcInstant(targetMidnightLocal);
  const endUtc = toUtcInstant(nextMidnightLocal);
  return { startAtMin: startUtc.toISOString(), startAtMax: endUtc.toISOString() };
}

// --- Error alerting -------------------------------------------------------
// Hunter wants an email whenever this job fails to text clients. Trim env vars
// because Vercel sometimes stores trailing newlines.
const ALERT_TO = (process.env.ALERT_EMAIL_TO || 'hunter@hairbyhunty.com').trim();
// From must be on a Resend-verified domain. We reuse the MSM Resend key, whose
// verified sending domain is the hunterdonia.com apex.
const ALERT_FROM = (process.env.ALERT_EMAIL_FROM || 'Lumiere Luxe Bot <noreply@hunterdonia.com>').trim();

async function sendAlertEmail(subject, text) {
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) {
    console.error('[reminders] RESEND_API_KEY not set — could not email alert:', subject);
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[reminders] alert email failed ${r.status}: ${body}`);
    }
  } catch (e) {
    console.error('[reminders] alert email threw:', e.message);
  }
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const force = req.query?.force === '1';
  const dry = req.query?.dry === '1';
  const modeOverride = req.query?.mode; // 'morning' | 'evening' (testing)

  try {
  const hour = laHour(now);
  let mode;
  if (modeOverride === 'morning' || modeOverride === 'evening') mode = modeOverride;
  else if (hour === FIRE_HOUR_EVENING) mode = 'evening';
  else if (hour === FIRE_HOUR_MORNING) mode = 'morning';
  if (!mode) {
    if (!force) {
      return res.status(200).json({ skipped: `LA hour is ${hour}, waiting for ${FIRE_HOUR_MORNING} or ${FIRE_HOUR_EVENING}` });
    }
    mode = 'evening';
  }

  // Evening run reminds ALL of tomorrow's guests. Morning run catches anyone
  // still coming TODAY who booked after last night's run — the [REMINDED:] note
  // marker skips anyone already texted, so nobody is double-texted.
  let startAtMin, startAtMax;
  if (mode === 'morning') {
    startAtMin = now.toISOString();                    // only upcoming appts (never a past one)
    startAtMax = dayRangeUtc(now, 1).startAtMin;        // ...through end of today (tomorrow 00:00 LA)
  } else {
    ({ startAtMin, startAtMax } = dayRangeUtc(now, 1)); // all of tomorrow
  }
  const messageText = messageBody(mode === 'morning' ? 'Good morning' : 'Good evening');

  const bookings = await searchBookings(startAtMin, startAtMax);

  const results = [];
  for (const booking of bookings) {
    const out = { id: booking.id, start: booking.start_at };
    try {
      if (booking.status !== 'ACCEPTED') {
        out.skipped = `status ${booking.status}`;
        results.push(out);
        continue;
      }
      if (!booking.customer_id) {
        out.skipped = 'no customer_id';
        results.push(out);
        continue;
      }

      const customer = await getCustomer(booking.customer_id);
      if (!customer) {
        out.skipped = 'customer not found';
        results.push(out);
        continue;
      }
      const normalizedPhone = normalizePhone(customer.phone_number);
      if (!normalizedPhone) {
        out.skipped = `unparseable phone: ${customer.phone_number || '(none)'}`;
        results.push(out);
        continue;
      }

      const marker = `[REMINDED:${booking.id}]`;
      const existingNote = customer.note || '';
      if (existingNote.includes(marker)) {
        out.skipped = 'already reminded';
        results.push(out);
        continue;
      }

      if (dry) {
        out.wouldSend = normalizedPhone;
        results.push(out);
        continue;
      }

      await sendQuoSms(normalizedPhone, messageText);

      const newNote = existingNote ? `${existingNote}\n${marker}` : marker;
      await updateCustomerNote(customer.id, newNote);

      out.sent = normalizedPhone;
      results.push(out);
    } catch (err) {
      out.error = err.message;
      results.push(out);
    }
  }

  const sent = results.filter((r) => r.sent).length;
  const failed = results.filter((r) => r.error);

  // Structured line for Vercel logs (greppable, one per run).
  // Log COUNTS only (failed.length, not failed) so client phone numbers never
  // land in Vercel logs. PII stays in the email to Hunter's own inbox.
  console.log('[reminders] summary ' + JSON.stringify({
    mode, dry, total: bookings.length, sent, failed: failed.length,
    window: { startAtMin, startAtMax },
  }));

  // A failed send means a real client did NOT get their form link — email Hunter.
  if (!dry && failed.length > 0) {
    const lines = failed.map((r) => `- booking ${r.id} (${r.start}): ${r.error}`).join('\n');
    await sendAlertEmail(
      `Lumiere Luxe: ${failed.length} reminder text(s) failed to send`,
      `The nightly appointment-reminder job ran but ${failed.length} of ${bookings.length} ` +
      `text(s) failed.\n\nFailed:\n${lines}\n\nTexted OK: ${sent}\nTime (UTC): ${now.toISOString()}`
    );
  }

  return res.status(200).json({
    ran: true,
    mode,
    dry,
    window: { startAtMin, startAtMax },
    total: bookings.length,
    sent,
    wouldSend: results.filter((r) => r.wouldSend).length,
    failed: failed.length,
    results,
  });
  } catch (err) {
    // Anything that escapes the per-booking loop (Square down, date bug, bad
    // env) lands here. This is the case that silently sent zero texts before.
    console.error('[reminders] FATAL ' + (err?.stack || err?.message || err));
    await sendAlertEmail(
      'Lumiere Luxe: appointment-reminder job CRASHED (no texts sent)',
      `The nightly appointment-reminder job threw an error before it could send ` +
      `texts, so NO clients were reminded.\n\nError: ${err?.message || err}\n\n` +
      `Where:\n${err?.stack || '(no stack)'}\n\nTime (UTC): ${now.toISOString()}`
    );
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
