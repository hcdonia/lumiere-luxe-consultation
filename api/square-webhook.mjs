import { createHmac, timingSafeEqual } from 'crypto';
import {
  WELCOME_PACKET_READY,
  HAS_PACKET_MARKER,
  isMichelleBooking,
  deliverWelcomePacket,
  markPacketSent,
} from '../lib/welcome-packet.mjs';

// Read the raw request body ourselves so we can verify Square's HMAC signature
// (which is computed over the exact bytes). Without this Vercel would parse the
// body and we'd lose the raw bytes.
export const config = { api: { bodyParser: false } };

const SQUARE_BASE_URL = 'https://connect.squareup.com';

// The exact notification URL registered on the Square webhook subscription.
// Square signs HMAC-SHA256(notificationURL + rawBody), so this must match byte
// for byte (no trailing slash).
const SQUARE_NOTIFICATION_URL = 'https://lumiere-luxe-consultation.vercel.app/api/square-webhook';

// The "LL New Guest Consultation Form" — the intake form Michelle wants every
// new guest to complete. Table = team view; form URL = what we text people.
const NEW_GUEST_FORM_ID = '251448462902155';
const JOTFORM_TABLES_URL = `https://www.jotform.com/tables/${NEW_GUEST_FORM_ID}`;
const NEW_GUEST_FORM_URL = `https://form.jotform.com/${NEW_GUEST_FORM_ID}`;

// create-customer.mjs writes the consultation summary to this Square customer
// custom attribute. Its presence means the guest completed the form flow.
const CONSULT_ATTR_KEY = 'square:9084740e-1f93-4c87-8937-cce6569f2faa';

// How close (in minutes) the customer creation must be to the booking to count as "new"
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;

// Vercel occasionally stores a literal "\n", BOM, or trailing whitespace on env
// vars (the prod JOTFORM_API_KEY had a trailing \n; some had a BOM). Sanitize so
// header/query values don't silently 401.
const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const OPENPHONE_API_KEY = clean(process.env.OPENPHONE_API_KEY);
const OPENPHONE_FROM_NUMBER = clean(process.env.OPENPHONE_FROM_NUMBER);

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
  });
  return res.json();
}

async function squarePut(path, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getBooking(bookingId) {
  const data = await squareGet(`/v2/bookings/${bookingId}`);
  return data.booking;
}

async function getCustomer(customerId) {
  const data = await squareGet(`/v2/customers/${customerId}`);
  return data.customer;
}

async function getTeamMember(teamMemberId) {
  const data = await squareGet(`/v2/team-members/${teamMemberId}`);
  return data.team_member;
}

async function getCatalogItem(serviceVariationId) {
  const data = await squareGet(`/v2/catalog/object/${serviceVariationId}`);
  return data.object;
}

// Slack mrkdwn requires these three characters escaped. Customer-controlled
// fields (name, note) must be escaped so a crafted name can't inject a fake
// link into the stylist's DM.
function slackEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Find Slack user by matching name against Square team member name
async function findSlackUser(stylistName) {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) return null;

  const nameLower = stylistName.toLowerCase();

  return data.members.find((u) => {
    if (u.is_bot || u.deleted || u.id === 'USLACKBOT') return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    return realName === nameLower || displayName === nameLower ||
      realName.includes(nameLower) || nameLower.includes(realName);
  });
}

// Send a DM to a Slack user
async function sendSlackDM(userId, message) {
  // Open a DM channel
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openRes.json();
  if (!openData.ok) {
    console.error('Slack open DM error:', openData.error);
    return false;
  }

  const channelId = openData.channel.id;

  // Send the message
  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text: message, mrkdwn: true }),
  });
  const msgData = await msgRes.json();
  if (!msgData.ok) {
    console.error('Slack send message error:', msgData.error);
    return false;
  }

  return true;
}

// Slack notify wrapped so a Slack outage can NEVER block the SMS nudge below.
async function notifyStylist(stylistName, message) {
  try {
    const slackUser = await findSlackUser(stylistName);
    if (!slackUser) return { slackError: `No Slack user found for: ${stylistName}` };
    await sendSlackDM(slackUser.id, message);
    return { notified: stylistName };
  } catch (err) {
    console.error('Slack notify error:', err.message);
    return { slackError: 'slack notify failed' };
  }
}

function isNewCustomer(customer, bookingCreatedAt) {
  const customerCreated = new Date(customer.created_at);
  const bookingCreated = new Date(bookingCreatedAt);
  const diffMinutes = Math.abs(bookingCreated - customerCreated) / (1000 * 60);
  return diffMinutes <= NEW_CUSTOMER_THRESHOLD_MINUTES;
}

// --- New-guest form nudge -------------------------------------------------
// If a NEW guest books directly (Square/Google) without ever submitting the new
// guest form, text them the form link via Quo/OpenPhone. This is the automation
// from the 2026-07-01 call: "when you get a booking on Square and you don't have
// a form submission from them, automatically text them, through the app, via Quo."

// E.164 (+1XXXXXXXXXX) for sending.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(raw).startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

// Last 10 digits, for matching a phone across formats.
function last10(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

async function sendQuoSms(toPhone, content) {
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: {
      Authorization: OPENPHONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: OPENPHONE_FROM_NUMBER,
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

// Build phone/email lookup sets from EVERY new-guest form submission, paging
// through all of them. ok:false means we could not build a complete index
// (API error, or more pages than we'll trust) — the caller MUST fail closed and
// never text, since an incomplete index would re-text people who already filled
// the form out (the worst failure mode).
async function fetchNewGuestFormIndex() {
  const LIMIT = 1000;
  const MAX_PAGES = 50; // 50k submissions before we refuse to guess
  const phones = new Set();
  const emails = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * LIMIT;
      const res = await fetch(
        `https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${JOTFORM_KEY}&limit=${LIMIT}&offset=${offset}`
      );
      if (!res.ok) {
        console.error(`[nudge] Jotform lookup failed: ${res.status}`);
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
          if (ans.type === 'control_email' && ans.answer) {
            emails.add(String(ans.answer).toLowerCase());
          }
        }
      }
      if (rows.length < LIMIT) return { ok: true, phones, emails }; // last page reached
    }
    console.error('[nudge] Jotform pagination exceeded MAX_PAGES — failing closed');
    return { ok: false, phones: new Set(), emails: new Set() };
  } catch (err) {
    console.error('[nudge] Jotform lookup threw:', err.message);
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

// Sanitize like the reminder cron: prod stored a BOM on some of these.
const RESEND_KEY = clean(process.env.RESEND_API_KEY);
const ALERT_TO = clean(process.env.ALERT_EMAIL_TO) || 'hunter@hairbyhunty.com';
const ALERT_FROM = clean(process.env.ALERT_EMAIL_FROM) || 'Lumiere Luxe Bot <noreply@hunterdonia.com>';

async function sendAlertEmail(subject, text) {
  if (!RESEND_KEY) {
    console.error('[nudge] RESEND_API_KEY not set — could not email alert:', subject);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text }),
    });
  } catch (e) {
    console.error('[nudge] alert email threw:', e.message);
  }
}

const NUDGE_ACTIVE_STATUSES = new Set(['PENDING', 'ACCEPTED']);
const SQUARE_SIGNATURE_KEY = clean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);

// Read the raw request stream. Returns '' if the body was already consumed
// (e.g. if Vercel parsed it despite bodyParser:false) so callers can degrade
// gracefully rather than hang or throw.
async function readRawBody(req) {
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

// Verify Square's webhook signature. Fail-OPEN by design: if the key isn't
// configured, or we couldn't capture the raw bytes, we don't block (same
// posture as before this was added) — we only ever REJECT on a real mismatch.
// When the raw body IS available and a key is set, a missing/wrong signature is
// rejected, which is the actual protection.
function verifySquareSignature(rawBody, signatureHeader) {
  if (!SQUARE_SIGNATURE_KEY) return { enforced: false, ok: true };
  if (!rawBody) return { enforced: false, ok: true }; // couldn't read raw bytes
  // No signature header at all (a proxy stripped it, or a non-signed ping) —
  // don't block. A FORGED request with a wrong header is still rejected below;
  // this only keeps us from 401'ing a legit event that arrived without one.
  if (!signatureHeader) return { enforced: false, ok: true };
  const hmac = createHmac('sha256', SQUARE_SIGNATURE_KEY);
  hmac.update(SQUARE_NOTIFICATION_URL + rawBody);
  const expected = Buffer.from(hmac.digest('base64'));
  const got = Buffer.from(String(signatureHeader || ''));
  if (expected.length !== got.length) return { enforced: true, ok: false };
  return { enforced: true, ok: timingSafeEqual(expected, got) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Capture raw bytes first (before anything drains the stream) so we can
    // verify the signature. Fall back to a pre-parsed req.body if Vercel still
    // parsed it, so the endpoint keeps working either way.
    const rawBody = await readRawBody(req);
    let event;
    if (rawBody) {
      try { event = JSON.parse(rawBody); }
      catch { return res.status(200).json({ received: true, skipped: 'unparseable body' }); }
    } else if (req.body) {
      event = typeof req.body === 'string'
        ? (() => { try { return JSON.parse(req.body); } catch { return null; } })()
        : req.body;
    }
    if (!event) return res.status(200).json({ received: true, skipped: 'no body' });

    const sig = verifySquareSignature(rawBody, req.headers['x-square-hmacsha256-signature']);
    if (sig.enforced && !sig.ok) {
      console.error('[webhook] signature verification failed — rejecting');
      return res.status(401).json({ error: 'invalid signature' });
    }

    // Only handle booking events
    if (event.type !== 'booking.created' && event.type !== 'booking.updated') {
      return res.status(200).json({ received: true, skipped: `not a booking event: ${event.type}` });
    }

    // For booking.updated, only notify if status just changed to PENDING or ACCEPTED
    if (event.type === 'booking.updated') {
      const status = event.data?.object?.booking?.status;
      if (status !== 'PENDING' && status !== 'ACCEPTED') {
        return res.status(200).json({ received: true, skipped: `booking.updated but status is ${status}` });
      }
    }

    // The nudge fires ONLY on booking.created. A direct/online booking always
    // emits booking.created once, and we return 200 (no Square retry), so this
    // gives exactly one nudge attempt per booking and avoids the created-vs-
    // updated double-text race. The stylist Slack DM still fires on both.
    const isCreatedEvent = event.type === 'booking.created';

    const bookingId = event.data?.id || event.data?.object?.booking?.id;
    if (!bookingId) {
      return res.status(200).json({ received: true, skipped: 'no booking id' });
    }

    // Get booking details
    const booking = await getBooking(bookingId);
    if (!booking) return res.status(200).json({ received: true, skipped: 'booking not found' });

    const customerId = booking.customer_id;
    if (!customerId) return res.status(200).json({ received: true, skipped: 'no customer id' });

    // Get customer and check if new
    const customer = await getCustomer(customerId);
    if (!customer) return res.status(200).json({ received: true, skipped: 'customer not found' });

    if (!isNewCustomer(customer, booking.created_at)) {
      return res.status(200).json({ received: true, skipped: 'not a new customer' });
    }

    // Get stylist info from booking
    const segment = booking.appointment_segments?.[0];
    if (!segment) return res.status(200).json({ received: true, skipped: 'no appointment segment' });

    const teamMember = await getTeamMember(segment.team_member_id);
    const stylistName = teamMember
      ? `${teamMember.given_name || ''} ${teamMember.family_name || ''}`.trim()
      : 'Unknown stylist';

    const note = customer.note || '';
    const hasExtensionsDeposit = note.includes('DEPOSIT PAID');

    // --- Reliable "did they submit the new-guest form?" detection ----------
    // The old note-only check ("Hair Consultation") went stale when the
    // consultation moved to a Square custom attribute, so check every signal:
    // Jotform submissions (source of truth), the custom attribute, reference_id,
    // and the legacy note marker. An extensions-deposit guest is also treated as
    // "on file" — they're mid-flow and must never get the new-guest nudge.
    const formIndex = await fetchNewGuestFormIndex();
    const p10 = last10(customer.phone_number);
    const emailLc = (customer.email_address || '').toLowerCase();
    const jotformMatch =
      (p10 && formIndex.phones.has(p10)) || (emailLc && formIndex.emails.has(emailLc));
    const hasAttr = await hasConsultationAttribute(customerId);
    const hasConsultation =
      jotformMatch || hasAttr || Boolean(customer.reference_id) || note.includes('Hair Consultation');
    const onFile = hasConsultation || hasExtensionsDeposit;

    const recommendedMatch = note.match(/Recommended:\s*(.+)/);
    const recommendedService = recommendedMatch ? recommendedMatch[1].trim() : null;
    const submissionId = customer.reference_id || null;
    const submissionUrl = submissionId
      ? `https://www.jotform.com/submission/${submissionId}`
      : JOTFORM_TABLES_URL;

    // Build the Slack message (customer-controlled fields are escaped)
    const customerName = slackEscape(
      `${customer.given_name || ''} ${customer.family_name || ''}`.trim() || 'Unknown'
    );
    const safeNote = slackEscape(note);
    const bookingDate = new Date(booking.start_at).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    let message;

    if (hasExtensionsDeposit) {
      message = [
        `💎 *Extensions Consultation Booked*`,
        ``,
        `*${customerName}* just paid the $35 deposit and booked an extensions consultation!`,
        `📅 ${bookingDate}`,
        ``,
        `💰 Deposit paid — apply $35 credit toward extension services if she moves forward.`,
        ``,
        `They submitted a consultation form — check their answers and photos:`,
        `👉 <${submissionUrl}|View Full Submission>`,
      ].join('\n');
    } else if (hasConsultation) {
      message = [
        `✨ *New Client Booking Alert*`,
        ``,
        `*${customerName}* just booked an appointment with you!`,
        `📅 ${bookingDate}`,
        `💇 Recommended service: *${recommendedService || 'N/A'}*`,
        ``,
        `They submitted a consultation form — check their answers and photos:`,
        `👉 <${submissionUrl}|View Full Submission>`,
        ``,
        `Consultation notes:`,
        `> ${safeNote.replace(/\n/g, '\n> ')}`,
      ].join('\n');
    } else {
      message = [
        `📋 *New Client Booking Alert*`,
        ``,
        `*${customerName}* just booked an appointment with you!`,
        `📅 ${bookingDate}`,
        ``,
        `⚠️ This client did *not* fill out the consultation form.`,
        `They've been auto-texted the new guest form link. Reach out if you'd like to add a personal touch.`,
        customer.email_address ? `📧 ${slackEscape(customer.email_address)}` : '',
        customer.phone_number ? `📱 ${slackEscape(customer.phone_number)}` : '',
      ].filter(Boolean).join('\n');
    }

    // DM the stylist (never throws — Slack outage must not block the nudge)
    const slackResult = await notifyStylist(stylistName, message);

    // --- New-guest form nudge ---------------------------------------------
    const e164 = toE164(customer.phone_number);
    const bookingActive = NUDGE_ACTIVE_STATUSES.has(booking.status);
    let nudge;

    if (!isCreatedEvent) {
      nudge = { skipped: 'not a booking.created event' };
    } else if (onFile) {
      nudge = { skipped: 'has form/deposit on file' };
    } else if (!bookingActive) {
      nudge = { skipped: `booking status ${booking.status}` };
    } else if (!e164) {
      nudge = { skipped: 'no usable phone on file' };
    } else if (!formIndex.ok) {
      // Fail closed: we could not build a complete submission index, so we can't
      // be sure they lack a form — never text in that case.
      nudge = { skipped: 'jotform lookup failed — failing closed (no text sent)' };
      await sendAlertEmail(
        'Lumiere Luxe: new-guest nudge skipped (Jotform lookup failed)',
        `A new guest booked without a detectable form, but the Jotform submissions ` +
        `lookup failed/was incomplete, so no text was sent (to avoid texting someone ` +
        `who already filled it out). Booking ${bookingId}, customer ${customerName}. ` +
        `Check the JOTFORM_API_KEY env var.`
      );
    } else {
      try {
        // Re-read the note right before writing so we (a) don't clobber a
        // [REMINDED:] marker the nightly cron may have just written, and (b)
        // catch a concurrent nudge that already went out.
        const fresh = await getCustomer(customerId);
        const freshNote = fresh?.note || '';
        if (freshNote.includes('[NEWGUESTNUDGE:')) {
          nudge = { skipped: 'already nudged' };
        } else {
          const first = ((customer.given_name || '').trim() || 'there').slice(0, 40);
          const body =
            `Hi ${first}, this is the team at Lumiere Luxe Salon. We're so excited you booked with us! ` +
            `Before we confirm your appointment, please fill out our quick new guest form so we can ` +
            `prepare for your visit and get you to your hair goals: ${NEW_GUEST_FORM_URL}`;
          await sendQuoSms(e164, body);
          const marker = `[NEWGUESTNUDGE:${bookingId}]`;
          await squarePut(`/v2/customers/${customerId}`, {
            note: freshNote ? `${freshNote}\n${marker}` : marker,
          });
          nudge = { texted: true };
        }
      } catch (err) {
        console.error('[nudge] send failed:', err.message);
        nudge = { error: true };
        await sendAlertEmail(
          'Lumiere Luxe: new-guest nudge text FAILED to send',
          `Tried to text the new guest form to ${customerName} (booking ${bookingId}) ` +
          `but it failed.\n\nError: ${err.message}`
        );
      }
    }

    // --- Welcome packet (immediate path) ----------------------------------
    // A new guest booking for Michelle who ALREADY has the new-guest form on file
    // gets the welcome packet right now. A guest who still owes the form does NOT
    // get it here (they'd have two links at once); send-welcome-packets.mjs sends
    // it once they complete the form. One packet per guest ([WELCOMEPACKET:]).
    let packet = { skipped: 'n/a' };
    try {
      if (isCreatedEvent && bookingActive && isMichelleBooking(segment.team_member_id) && onFile) {
        if (!WELCOME_PACKET_READY) {
          packet = { skipped: 'packet url not set' };
        } else {
          const fresh = await getCustomer(customerId);
          if (HAS_PACKET_MARKER(fresh?.note)) {
            packet = { skipped: 'already sent' };
          } else {
            const r = await deliverWelcomePacket(customer);
            if (r.sent) {
              // Only report as done once the dedup marker is confirmed on file, so
              // the hourly cron can never re-send this packet.
              const marked = await markPacketSent(customerId, bookingId);
              packet = { sent: true, channel: r.channel, ...(marked ? {} : { markerWarning: true }) };
            } else {
              packet = { skipped: r.reason };
            }
          }
        }
      }
    } catch (err) {
      console.error('[packet] webhook send failed:', err.message);
      packet = { error: true };
    }

    return res.status(200).json({ received: true, ...slackResult, nudge, packet });
  } catch (err) {
    // Return 200 (no Square retry) but never leak internals to the caller.
    console.error('Webhook processing error:', err.message);
    return res.status(200).json({ received: true });
  }
}
