// Deferred welcome-packet sender.
//
// A NEW guest who books with MICHELLE but did NOT have the new-guest form on file
// when they booked gets the form-request text (from square-webhook.mjs), NOT the
// packet, so they never receive two links at once. This cron watches for the
// moment they COMPLETE the form and then sends the welcome packet.
//
// Safety posture (mirrors escalate-new-guest-forms.mjs):
//   - forward-only: never touches bookings created before GO_LIVE (no retroactive
//     "welcome to your first visit" blast on the very first run)
//   - business hours only (LA 8am-8pm) for the customer-facing text/email
//   - fails CLOSED if the Jotform submissions index is incomplete
//   - one packet per guest, ever ([WELCOMEPACKET:] marker, re-checked fresh)
//   - sends nothing at all until WELCOME_PACKET_URL is a real link
//
// Cron: hourly (see vercel.json); off-hours runs no-op cheaply.

import {
  WELCOME_PACKET_READY,
  HAS_PACKET_MARKER,
  isMichelleBooking,
  deliverWelcomePacket,
  markPacketSent,
} from '../lib/welcome-packet.mjs';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const SALON_TZ = 'America/Los_Angeles';

const NEW_GUEST_FORM_ID = '251448462902155';
const CONSULT_ATTR_KEY = 'square:9084740e-1f93-4c87-8937-cce6569f2faa';

const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const BUSINESS_START = 8; // LA hour
const BUSINESS_END = 20;

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);

// Forward-only anchor. IMPORTANT: set WELCOME_PACKET_GO_LIVE (env) to the moment
// this goes live so guests who already have an upcoming booking + form on file
// don't get a retroactive packet. A missing OR unparseable env falls back to the
// fixed default (never to an Invalid Date, which would silently disable the
// forward-only skip and allow a retroactive blast).
const GO_LIVE_DEFAULT = '2026-07-06T13:01:18Z'; // deploy moment: forward-only from here
const GO_LIVE = (() => {
  const d = new Date(clean(process.env.WELCOME_PACKET_GO_LIVE) || GO_LIVE_DEFAULT);
  return Number.isNaN(d.getTime()) ? new Date(GO_LIVE_DEFAULT) : d;
})();

// --- Square helpers --------------------------------------------------------
async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
  });
  return res.json();
}
async function getCustomer(customerId) {
  return (await squareGet(`/v2/customers/${customerId}`)).customer;
}
async function searchUpcomingBookings(now) {
  const min = now.toISOString();
  const max = new Date(now.getTime() + 31 * 864e5).toISOString(); // Square caps range at 31 days
  const out = [];
  let cursor;
  do {
    const params = new URLSearchParams({
      location_id: LOCATION_ID,
      start_at_min: min,
      start_at_max: max,
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await squareGet(`/v2/bookings?${params.toString()}`);
    for (const b of data.bookings || []) out.push(b);
    cursor = data.cursor;
  } while (cursor && out.length < 2000);
  return out;
}

// --- Form-on-file detection (same signals as escalate) ---------------------
const last10 = (raw) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
};

async function fetchNewGuestFormIndex() {
  const LIMIT = 1000, MAX_PAGES = 50;
  const phones = new Set(), emails = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${JOTFORM_KEY}&limit=${LIMIT}&offset=${page * LIMIT}`
      );
      if (!res.ok) {
        console.error(`[welcome-packet] Jotform lookup failed: ${res.status}`);
        return { ok: false, phones: new Set(), emails: new Set() };
      }
      const data = await res.json();
      const rows = data.content || [];
      for (const sub of rows) {
        for (const ans of Object.values(sub.answers || {})) {
          if (ans.type === 'control_phone') {
            const p = last10(ans.answer?.full || ans.answer);
            if (p) phones.add(p);
          }
          if (ans.type === 'control_email' && ans.answer) emails.add(String(ans.answer).toLowerCase());
        }
      }
      if (rows.length < LIMIT) return { ok: true, phones, emails };
    }
    console.error('[welcome-packet] Jotform pagination exceeded MAX_PAGES — failing closed');
    return { ok: false, phones: new Set(), emails: new Set() };
  } catch (err) {
    console.error('[welcome-packet] Jotform lookup threw:', err.message);
    return { ok: false, phones: new Set(), emails: new Set() };
  }
}
async function hasConsultationAttribute(customerId) {
  try {
    const data = await squareGet(
      `/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(CONSULT_ATTR_KEY)}`
    );
    return !!data.custom_attribute?.value;
  } catch {
    return false;
  }
}
async function hasFormOnFile(customer, formIndex) {
  const p10 = last10(customer.phone_number);
  const email = (customer.email_address || '').toLowerCase();
  if ((p10 && formIndex.phones.has(p10)) || (email && formIndex.emails.has(email))) return true;
  if (customer.reference_id) return true;
  const note = customer.note || '';
  if (note.includes('Hair Consultation') || note.includes('DEPOSIT PAID')) return true;
  return await hasConsultationAttribute(customer.id);
}
function isNewCustomer(customer, bookingCreatedAt) {
  const diffMin = Math.abs(new Date(bookingCreatedAt) - new Date(customer.created_at)) / 6e4;
  return diffMin <= NEW_CUSTOMER_THRESHOLD_MINUTES;
}

const laHour = (date) =>
  parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: SALON_TZ, hour: 'numeric', hour12: false }).format(date),
    10
  );

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const dry = req.query?.dry === '1';
  const ignoreHours = req.query?.anyhour === '1'; // testing only

  if (!WELCOME_PACKET_READY) {
    return res.status(200).json({ ran: true, skipped: 'welcome packet url not set' });
  }

  try {
    const inBusinessHours = (laHour(now) >= BUSINESS_START && laHour(now) < BUSINESS_END) || ignoreHours;
    if (!inBusinessHours) return res.status(200).json({ ran: true, skipped: 'off business hours' });

    const formIndex = await fetchNewGuestFormIndex();
    if (!formIndex.ok) {
      // Fail closed: an incomplete index could wrongly read "no form" and we'd
      // never wrongly-send here, but we also can't confirm form completion, so skip.
      return res.status(200).json({ ran: true, skipped: 'jotform lookup failed (failed closed)' });
    }

    const bookings = await searchUpcomingBookings(now);
    const results = [];

    for (const b of bookings) {
      const out = { id: b.id };
      try {
        if (['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'].includes(b.status)) {
          out.skip = `status ${b.status}`; results.push(out); continue;
        }
        const seg = b.appointment_segments?.[0];
        if (!b.customer_id || !seg) { out.skip = 'no customer/segment'; results.push(out); continue; }
        if (!isMichelleBooking(seg.team_member_id)) { out.skip = 'not michelle'; results.push(out); continue; }
        if (new Date(b.created_at) < GO_LIVE) { out.skip = 'before go-live'; results.push(out); continue; }
        if (new Date(b.start_at) <= now) { out.skip = 'appt passed'; results.push(out); continue; }

        const customer = await getCustomer(b.customer_id);
        if (!customer) { out.skip = 'customer not found'; results.push(out); continue; }
        if (!isNewCustomer(customer, b.created_at)) { out.skip = 'not a new guest'; results.push(out); continue; }
        if (HAS_PACKET_MARKER(customer.note)) { out.skip = 'packet already sent'; results.push(out); continue; }
        if (!(await hasFormOnFile(customer, formIndex))) {
          out.skip = 'form not completed yet'; results.push(out); continue;
        }

        out.name = `${customer.given_name || ''} ${customer.family_name || ''}`.trim() || 'Unknown';
        out.willSend = true;
        if (dry) { out.dry = true; results.push(out); continue; }

        // Fresh re-read right before sending, so a concurrent webhook/cron run that
        // just sent the packet can't cause a double.
        const fresh = (await getCustomer(b.customer_id)) || customer;
        if (HAS_PACKET_MARKER(fresh.note)) { out.skip = 'packet already sent (fresh)'; results.push(out); continue; }

        const r = await deliverWelcomePacket(fresh);
        if (r.sent) {
          const marked = await markPacketSent(b.customer_id, b.id);
          out.sent = r.channel;
          if (!marked) out.markerWarning = true; // sent, but marker not confirmed
        } else {
          out.skip = r.reason;
        }
        results.push(out);
      } catch (err) {
        out.error = err.message;
        results.push(out);
      }
    }

    const sent = results.filter((r) => r.sent);
    console.log('[welcome-packet] summary ' + JSON.stringify({
      dry, businessHours: inBusinessHours, total: bookings.length,
      sent: sent.length, willSend: results.filter((r) => r.willSend).length,
    }));

    return res.status(200).json({
      ran: true, dry, total: bookings.length,
      sent, willSend: results.filter((r) => r.willSend && !r.sent),
    });
  } catch (err) {
    console.error('[welcome-packet] FATAL ' + (err?.stack || err?.message || err));
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
