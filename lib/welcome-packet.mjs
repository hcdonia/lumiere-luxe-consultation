// Single source of truth for the Michelle Sanders new-guest WELCOME PACKET:
// the link, the copy (SMS + email), who counts as "booking for Michelle", and the
// actual delivery. Imported by BOTH:
//   - api/square-webhook.mjs        -> immediate send, for a new guest who ALREADY
//                                      had the new-guest form on file when they booked
//   - api/send-welcome-packets.mjs  -> deferred send, once a guest who owed the form
//                                      finally completes it (so they never get two
//                                      links at once)
// Keeping it here means the link + copy live in ONE place and the two paths can
// never drift apart.

// Vercel occasionally stores a BOM / literal "\n" / trailing space on env vars.
const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();

// ===========================================================================
// The welcome packet link (Michelle's Canva welcome guide). It is baked in as the
// default so the feature works with zero env config, and can be overridden any
// time by setting WELCOME_PACKET_URL in Vercel. WELCOME_PACKET_READY guards
// against ever sending a blank/placeholder link (e.g. if the env is set to junk).
// ===========================================================================
export const WELCOME_PACKET_URL =
  clean(process.env.WELCOME_PACKET_URL) ||
  'https://hunterdonia.my.canva.site/ll-salon-welcome-guide-template';
export const WELCOME_PACKET_READY =
  /^https?:\/\/\S+/.test(WELCOME_PACKET_URL) && !/REPLACE-WITH/.test(WELCOME_PACKET_URL);

// Delivery channel: 'sms' (default, proven) or 'email'. Email automatically falls
// back to SMS when we have no email on file (and vice-versa) so we always reach them.
export const WELCOME_PACKET_CHANNEL =
  (clean(process.env.WELCOME_PACKET_CHANNEL) || 'sms').toLowerCase();

// "Booking for Michelle" = her own chair OR her second/overlap chair ("Chair 2
// Sanders"). If Chair 2 turns out to be another stylist, delete that second id.
export const MICHELLE_TEAM_MEMBER_IDS = new Set([
  'TM3kfAwpj5uuL3Fh', // Michelle Sanders (owner)
  'TMt2F_XckJb-AYLj', // Chair 2 Sanders (assumed Michelle's overlap chair)
]);
export const isMichelleBooking = (teamMemberId) => MICHELLE_TEAM_MEMBER_IDS.has(teamMemberId);

// One packet per guest, ever. The marker is written to the Square customer note by
// the caller AFTER a successful send; both paths check for it before sending.
export const WELCOME_PACKET_MARKER = (bookingId) => `[WELCOMEPACKET:${bookingId}]`;
export const HAS_PACKET_MARKER = (note) => (note || '').includes('[WELCOMEPACKET:');

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const squareHeaders = () => ({
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
  'Square-Version': '2025-03-19',
});

// Robustly persist the dedup marker on the Square customer note. Re-reads fresh
// each attempt (so it never clobbers another job's marker), returns early if the
// marker is already present, and RETRIES on a failed write. Returns true only when
// the marker is confirmed on file. This closes the "packet sent but marker write
// silently failed -> hourly cron re-sends" hole: callers only treat a send as done
// when this returns true, and surface a warning otherwise.
export async function markPacketSent(customerId, bookingId) {
  const marker = WELCOME_PACKET_MARKER(bookingId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const getRes = await fetch(`${SQUARE_BASE_URL}/v2/customers/${customerId}`, {
        headers: squareHeaders(),
      });
      const note = (await getRes.json())?.customer?.note || '';
      if (HAS_PACKET_MARKER(note)) return true; // already marked (this or a prior run)
      const putRes = await fetch(`${SQUARE_BASE_URL}/v2/customers/${customerId}`, {
        method: 'PUT',
        headers: squareHeaders(),
        body: JSON.stringify({ note: note ? `${note}\n${marker}` : marker }),
      });
      if (putRes.ok) return true;
      console.error(`[packet] marker write attempt ${attempt + 1} failed: ${putRes.status}`);
    } catch (err) {
      console.error(`[packet] marker write attempt ${attempt + 1} threw: ${err.message}`);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export const firstNameOf = (customer) =>
  ((customer?.given_name || '').trim() || 'there').slice(0, 40);

// --- Credentials (same envs the rest of the app already uses) ---------------
const OPENPHONE_API_KEY = clean(process.env.OPENPHONE_API_KEY);
const OPENPHONE_FROM_NUMBER = clean(process.env.OPENPHONE_FROM_NUMBER);
const RESEND_KEY = clean(process.env.RESEND_API_KEY);
// hunterdonia.com is already verified in Resend (used for alert emails). Ideally
// verify a Lumiere Luxe domain and point WELCOME_PACKET_EMAIL_FROM at it.
const PACKET_EMAIL_FROM =
  clean(process.env.WELCOME_PACKET_EMAIL_FROM) || 'Lumiere Luxe Salon <noreply@hunterdonia.com>';

const toE164 = (raw) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
};

// ===========================================================================
// COPY  (Michelle's voice, warm, no em-dashes)
// ===========================================================================
export const welcomePacketSms = (first) =>
  `Hi ${first}, welcome to Lumiere Luxe! We're so excited to have you and can't wait ` +
  `to see you for your first visit with Michelle. Here is your new guest welcome ` +
  `packet with everything you need to know before you come in: ${WELCOME_PACKET_URL}`;

export const welcomePacketEmailSubject = "Welcome to Lumiere Luxe, here's your new guest packet";

// Plain, no marketing template. One <p> per paragraph, a real link, looks like
// Michelle typed it.
export const welcomePacketEmailHtml = (first) => `
<p>Hi ${first},</p>
<p>Welcome to Lumiere Luxe! I'm so glad you booked and I can't wait to see you for your first visit with me.</p>
<p>To make your appointment as smooth as possible, I put together a new guest welcome packet with everything you need to know before you come in: what to expect, how to find us, and how to get the most out of your time in my chair.</p>
<p><a href="${WELCOME_PACKET_URL}">Open your new guest welcome packet</a></p>
<p>If any questions come up before your visit, just give us a text or a call and we are happy to help. See you soon!</p>
<p>Michelle<br>Lumiere Luxe Salon</p>
`.trim();

// Plain-text fallback for the email (some clients render this instead).
export const welcomePacketEmailText = (first) =>
  `Hi ${first},\n\n` +
  `Welcome to Lumiere Luxe! I'm so glad you booked and I can't wait to see you for your first visit with me.\n\n` +
  `To make your appointment as smooth as possible, I put together a new guest welcome packet with everything you need to know before you come in: what to expect, how to find us, and how to get the most out of your time in my chair.\n\n` +
  `Here is your packet: ${WELCOME_PACKET_URL}\n\n` +
  `If any questions come up before your visit, just give us a text or a call and we are happy to help. See you soon!\n\n` +
  `Michelle\nLumiere Luxe Salon`;

// --- Senders ---------------------------------------------------------------
async function sendSms(toPhone, content) {
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: OPENPHONE_FROM_NUMBER, to: [toPhone], content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Quo ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendEmail(to, first) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: PACKET_EMAIL_FROM,
      to: [to],
      subject: welcomePacketEmailSubject,
      html: welcomePacketEmailHtml(first),
      text: welcomePacketEmailText(first),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// Deliver the packet via the configured channel, with automatic fallback to the
// other channel if the preferred contact detail is missing. Never touches the
// Square note; the caller writes the marker after this resolves successfully.
// Returns { sent:true, channel } or { sent:false, reason }.
export async function deliverWelcomePacket(customer) {
  if (!WELCOME_PACKET_READY) return { sent: false, reason: 'packet url not set' };
  const first = firstNameOf(customer);
  const email = (customer?.email_address || '').trim();
  const phone = toE164(customer?.phone_number);

  const wantEmail = WELCOME_PACKET_CHANNEL === 'email';

  if (wantEmail && email) {
    await sendEmail(email, first);
    return { sent: true, channel: 'email' };
  }
  if (!wantEmail && phone) {
    await sendSms(phone, welcomePacketSms(first));
    return { sent: true, channel: 'sms' };
  }
  // Preferred channel's contact detail is missing -> use whatever we do have.
  if (phone) {
    await sendSms(phone, welcomePacketSms(first));
    return { sent: true, channel: 'sms-fallback' };
  }
  if (email) {
    await sendEmail(email, first);
    return { sent: true, channel: 'email-fallback' };
  }
  return { sent: false, reason: 'no phone or email on file' };
}
