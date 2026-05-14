const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const JOTFORM_LINK = 'https://form.jotform.com/260438977572067';
const SALON_TZ = 'America/Los_Angeles';
const FIRE_HOUR_LOCAL = 19;

const MESSAGE_BODY =
  "Good evening from Lumiere Luxe, please fill out this form to make sure we can prepare for your salon visit today. " +
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

// Returns ISO timestamps spanning "tomorrow" in salon-local time.
// e.g. if it's Mon 7pm LA, this returns [Tue 00:00 LA, Wed 00:00 LA] as UTC ISO strings.
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

  // Convert a "wall-clock" salon-local date to its UTC instant.
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

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const hour = laHour(now);
  const force = req.query?.force === '1';
  const dry = req.query?.dry === '1';
  if (hour !== FIRE_HOUR_LOCAL && !force) {
    return res.status(200).json({ skipped: `LA hour is ${hour}, waiting for ${FIRE_HOUR_LOCAL}` });
  }

  const { startAtMin, startAtMax } = tomorrowRangeUtc(now);

  let bookings;
  try {
    bookings = await searchBookings(startAtMin, startAtMax);
  } catch (err) {
    return res.status(500).json({ error: `Square search failed: ${err.message}` });
  }

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

      await sendQuoSms(normalizedPhone, MESSAGE_BODY);

      const newNote = existingNote ? `${existingNote}\n${marker}` : marker;
      await updateCustomerNote(customer.id, newNote);

      out.sent = normalizedPhone;
      results.push(out);
    } catch (err) {
      out.error = err.message;
      results.push(out);
    }
  }

  return res.status(200).json({
    ran: true,
    dry,
    window: { startAtMin, startAtMax },
    total: bookings.length,
    sent: results.filter((r) => r.sent).length,
    wouldSend: results.filter((r) => r.wouldSend).length,
    results,
  });
}
