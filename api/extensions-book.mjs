// Books an extensions consultation: create customer → create booking → charge deposit → update note.
// On any failure after booking creation, the booking is canceled to roll back state.
import { randomUUID } from 'crypto';

const SQUARE_BASE_URL = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

const LOCATION_ID = 'LWJX3SDVSAD04';
const SERVICE_VARIATION_ID = 'F6SW42MPSJBYS3ORE6GOGJWG';
const TEAM_MEMBER_ID = 'TMxBIVi-i-sW0xmq';
const DEPOSIT_AMOUNT_CENTS = 3500;
const SERVICE_DURATION_MINUTES = 15;

async function squareRequest(method, path, body) {
  const env = process.env.SQUARE_ENVIRONMENT || 'sandbox';
  const baseUrl = SQUARE_BASE_URL[env] || SQUARE_BASE_URL.sandbox;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
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

async function findOrCreateCustomer({ givenName, familyName, email, phone, submissionID }) {
  if (email) {
    const search = await squareRequest('POST', '/v2/customers/search', {
      query: { filter: { email_address: { exact: email } } },
    });
    if (search.customers && search.customers.length > 0) {
      return search.customers[0];
    }
  }

  const created = await squareRequest('POST', '/v2/customers', {
    idempotency_key: randomUUID(),
    given_name: givenName || undefined,
    family_name: familyName || undefined,
    email_address: email || undefined,
    phone_number: phone || undefined,
    reference_id: submissionID || undefined,
    note: `--- Extensions Consultation Inquiry (${new Date().toLocaleDateString('en-US')}) ---`,
  });
  return created.customer;
}

async function safeCancelBooking(bookingId) {
  try {
    await squareRequest('POST', `/v2/bookings/${bookingId}/cancel`, {
      idempotency_key: randomUUID(),
    });
  } catch (err) {
    console.error('Failed to roll back booking', bookingId, err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { submissionID, clientInfo, slotStartAt, sourceId } = req.body || {};

    if (!clientInfo || (!clientInfo.email && !clientInfo.phone)) {
      return res.status(400).json({ error: 'Missing client contact info' });
    }
    if (!slotStartAt) {
      return res.status(400).json({ error: 'Missing slotStartAt' });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'Missing sourceId (payment token)' });
    }

    // 1. Customer
    const customer = await findOrCreateCustomer({ ...clientInfo, submissionID });

    // 2. Booking — try this BEFORE charging so a slot conflict doesn't leave a stranded payment.
    let booking;
    try {
      const bookingRes = await squareRequest('POST', '/v2/bookings', {
        idempotency_key: randomUUID(),
        booking: {
          start_at: slotStartAt,
          location_id: LOCATION_ID,
          customer_id: customer.id,
          appointment_segments: [
            {
              duration_minutes: SERVICE_DURATION_MINUTES,
              service_variation_id: SERVICE_VARIATION_ID,
              team_member_id: TEAM_MEMBER_ID,
              service_variation_version: 1,
            },
          ],
        },
      });
      booking = bookingRes.booking;
    } catch (err) {
      console.error('Booking failed:', err.message);
      return res.status(409).json({
        error: 'slot_unavailable',
        detail: 'That time slot is no longer available. Please pick another.',
      });
    }

    // 3. Payment — if this fails, cancel the booking we just created.
    let payment;
    try {
      const paymentRes = await squareRequest('POST', '/v2/payments', {
        idempotency_key: randomUUID(),
        source_id: sourceId,
        amount_money: { amount: DEPOSIT_AMOUNT_CENTS, currency: 'USD' },
        customer_id: customer.id,
        location_id: LOCATION_ID,
        reference_id: booking.id.slice(0, 40),
        note: 'Extensions Consultation Deposit',
      });
      payment = paymentRes.payment;
    } catch (err) {
      console.error('Payment failed, rolling back booking:', err.message);
      await safeCancelBooking(booking.id);
      return res.status(402).json({
        error: 'payment_failed',
        detail: err.message || 'Your card could not be charged. Please try a different card.',
      });
    }

    // 4. Append deposit-paid header to customer note (best-effort).
    try {
      const existing = await squareRequest('GET', `/v2/customers/${customer.id}`);
      const existingNote = existing.customer?.note || '';
      const bookingDateStr = new Date(slotStartAt).toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Los_Angeles',
      });
      const depositHeader = [
        `--- DEPOSIT PAID — $35 ---`,
        `Extensions consultation booked for ${bookingDateStr}`,
        `Booking ID: ${booking.id}`,
        `Payment ID: ${payment.id}`,
        `Apply $35 credit toward extension services if guest moves forward.`,
      ].join('\n');
      const updatedNote = existingNote ? `${depositHeader}\n\n${existingNote}` : depositHeader;
      await squareRequest('PUT', `/v2/customers/${customer.id}`, { note: updatedNote });
    } catch (err) {
      // Non-fatal — booking + payment already succeeded.
      console.error('Failed to update customer note:', err.message);
    }

    return res.status(200).json({
      success: true,
      bookingId: booking.id,
      paymentId: payment.id,
      slotStartAt,
    });
  } catch (err) {
    console.error('Extensions book error:', err.message);
    return res.status(500).json({ error: 'Failed to book consultation', detail: err.message });
  }
}
