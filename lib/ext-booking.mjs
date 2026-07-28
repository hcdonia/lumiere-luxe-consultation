// Shared lookup for the extensions-consultation deposit flow. Used by:
//   - api/extensions-deposit.mjs  -> the guest-facing deposit page endpoints
//   - api/form-submitted.mjs      -> server-side truth check: a guest can edit the
//                                    ?alreadybooked=ext URL prefill down to =1, so
//                                    "owes the deposit" must be derived from their
//                                    LIVE Square booking, never from the form value
//
// Finds the guest's next live extensions-consult booking by their email/phone and
// reports whether ITS deposit is paid (the DEPOSIT PAID note header is scoped to
// the booking id, so a stale header from a previous visit can never read as paid).

const SQUARE_BASE_URL = 'https://connect.squareup.com';
export const LOCATION_ID = 'LWJX3SDVSAD04';
export const EXT_CONSULT_VARIATION_ID = 'F6SW42MPSJBYS3ORE6GOGJWG';
const DEAD_STATUSES = new Set(['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW']);

export async function squareRequest(method, path, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.errors?.[0]?.detail || `Square API error: ${res.status}`);
    err.status = res.status;
    err.code = data.errors?.[0]?.code;
    throw err;
  }
  return data;
}

export const last10 = (raw) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

// Find Square customer records matching an email and/or phone.
export async function findMatchingCustomers({ email, phone }) {
  const out = new Map();
  const em = (email || '').trim().toLowerCase();
  const p10 = last10(phone);
  if (em) {
    const d = await squareRequest('POST', '/v2/customers/search', {
      query: { filter: { email_address: { exact: em } } }, limit: 50,
    });
    for (const c of d.customers || []) out.set(c.id, c);
  }
  if (p10) {
    const d = await squareRequest('POST', '/v2/customers/search', {
      query: { filter: { phone_number: { fuzzy: p10 } } }, limit: 50,
    });
    for (const c of d.customers || []) {
      if (last10(c.phone_number) === p10) out.set(c.id, c);
    }
  }
  return [...out.values()];
}

// Find the guest's next live extensions-consultation booking. Square caps each
// bookings query at a 31-day range, so walk three windows (93 days out) — the
// original single window silently stranded any consult booked >31 days ahead.
export async function findExtConsultBooking(customerIds) {
  if (customerIds.length === 0) return null;
  const ids = new Set(customerIds);
  const now = Date.now();
  const matches = [];
  for (let w = 0; w < 3; w++) {
    const min = new Date(now + w * 31 * 864e5).toISOString();
    const max = new Date(now + (w + 1) * 31 * 864e5).toISOString();
    let cursor;
    do {
      const params = new URLSearchParams({ location_id: LOCATION_ID, start_at_min: min, start_at_max: max, limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const data = await squareRequest('GET', `/v2/bookings?${params.toString()}`);
      for (const b of data.bookings || []) {
        if (!ids.has(b.customer_id)) continue;
        if (DEAD_STATUSES.has(b.status)) continue;
        if (new Date(b.start_at).getTime() <= now) continue;
        if (!(b.appointment_segments || []).some((s) => s.service_variation_id === EXT_CONSULT_VARIATION_ID)) continue;
        matches.push(b);
      }
      cursor = data.cursor;
    } while (cursor);
  }
  matches.sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  return matches[0] || null;
}

// Deposit-paid check scoped to THIS booking: the header written on payment
// contains "Booking ID: <id>", so a DEPOSIT PAID header from a previous visit
// (or from the normal extensions-book flow's own booking) can never match.
export const depositPaidForBooking = (note, bookingId) =>
  (note || '').includes('DEPOSIT PAID') && (note || '').includes(bookingId);

// One-call convenience: does this contact have a live ext-consult booking whose
// deposit is NOT yet paid? Returns { owes, booking, customer } (owes=false when
// no booking or already paid). Throws on Square errors — callers decide fallback.
export async function extDepositOwed(contact) {
  const customers = await findMatchingCustomers(contact);
  const booking = await findExtConsultBooking(customers.map((c) => c.id));
  if (!booking) return { owes: false, booking: null, customer: null };
  const customer = customers.find((c) => c.id === booking.customer_id);
  const paid = depositPaidForBooking(customer?.note, booking.id);
  return { owes: !paid, booking, customer };
}
