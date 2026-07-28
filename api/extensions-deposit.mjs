// Deposit-only flow for a guest who booked the extensions consultation DIRECTLY
// on Square (bypassing the form, so no $35 deposit was collected). The nudge
// texts them the form link with ?alreadybooked=ext; after they submit, intake.mjs
// routes them here (results page ?extdeposit=1) instead of "you're all set".
//
// They already HAVE the booking, so this never creates one:
//   GET  ?submissionID=...          -> find their upcoming extensions-consult
//                                      booking (matched by the submission's
//                                      email/phone) and report its time + whether
//                                      THIS booking's deposit is already paid
//   POST { submissionID, sourceId } -> charge the $35 against that booking,
//                                      write the same DEPOSIT PAID note header
//                                      extensions-book.mjs writes (so every
//                                      existing detection keeps working), and
//                                      Slack Michelle
//
// Hardening (2026-07-28 review panel):
//   - The submission must belong to the new-guest form AND carry the
//     alreadybooked=ext prefill — a random submissionID from another form is
//     rejected, so this can't be used to look up strangers across the account.
//   - sourceId must be a fresh Web Payments nonce (cnon:...), never a stored
//     card id; the amount is fixed server-side.
//   - Card declines return ONE generic message (Square's per-decline detail is
//     a card-testing oracle) and 5xx bodies carry no internal error text.
//   - The deposit-paid check is scoped to this booking id, so a stale DEPOSIT
//     PAID header from a previous visit can never read as paid.
//   - Two-tabs race: if a concurrent charge won between our fresh check and our
//     note write, the losing payment is auto-REFUNDED and reported as paid.
//   - Every dead-end (no booking found on GET or POST) alert-emails Hunter so a
//     guest stranded without a deposit path is never silent.

import { extractContact } from '../lib/jotform-contact.mjs';
import {
  squareRequest,
  findMatchingCustomers,
  findExtConsultBooking,
  depositPaidForBooking,
  LOCATION_ID,
} from '../lib/ext-booking.mjs';

const NEW_GUEST_FORM_ID = '251448462902155';
const DEPOSIT_AMOUNT_CENTS = 3500;
const SALON_TZ = 'America/Los_Angeles';

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const RESEND_KEY = clean(process.env.RESEND_API_KEY);
const ALERT_TO = clean(process.env.ALERT_EMAIL_TO) || 'hunter@hairbyhunty.com';
const ALERT_FROM = clean(process.env.ALERT_EMAIL_FROM) || 'Lumiere Luxe Bot <noreply@hunterdonia.com>';

const GENERIC_DECLINE = 'Your card could not be charged. Please double-check the details or try a different card.';

async function fetchSubmission(submissionID) {
  const res = await fetch(`https://api.jotform.com/submission/${submissionID}?apiKey=${JOTFORM_KEY}`);
  if (!res.ok) throw new Error(`Jotform ${res.status}`);
  const data = await res.json();
  if (data.responseCode !== 200 || !data.content) throw new Error('Jotform submission not found');
  return data.content;
}

const hiddenValue = (submission, fieldName) => {
  for (const ans of Object.values(submission.answers || {})) {
    if ((ans.name || '').toLowerCase() === fieldName) return String(ans.answer ?? '').trim().toLowerCase();
  }
  return '';
};

const fmtStart = (iso) => new Date(iso).toLocaleString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: SALON_TZ,
});

async function sendAlertEmail(subject, text) {
  if (!RESEND_KEY) { console.error('[ext-deposit] RESEND_API_KEY not set:', subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text }),
    });
  } catch (e) { console.error('[ext-deposit] alert email threw:', e.message); }
}

const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function slackMichelle(text) {
  try {
    const users = await (await fetch('https://slack.com/api/users.list', {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })).json();
    if (!users.ok) throw new Error(users.error);
    const m = users.members.find((u) => !u.is_bot && !u.deleted &&
      ((u.real_name || '').toLowerCase().includes('michelle sanders') ||
       (u.profile?.display_name || '').toLowerCase().includes('michelle sanders')));
    if (!m) throw new Error('Michelle not found on Slack');
    const open = await (await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: m.id }),
    })).json();
    if (!open.ok) throw new Error(open.error);
    const msg = await (await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: open.channel.id, text, mrkdwn: true }),
    })).json();
    if (!msg.ok) throw new Error(msg.error);
  } catch (e) {
    console.error('[ext-deposit] Slack failed:', e.message);
    await sendAlertEmail('Lumiere Luxe: deposit paid (Slack to Michelle failed)', text.replace(/[*_`>]/g, ''));
  }
}

// Shared lookup for GET and POST. Only submissions from the new-guest form that
// carry an alreadybooked prefill are honored (any truthy value, not just 'ext':
// the webhook's live-truth check can route a guest here whose prefill was '1',
// and the REAL gate is the live ext-consult booking match below anyway).
async function locate(submissionID) {
  const submission = await fetchSubmission(submissionID);
  if (String(submission.form_id) !== NEW_GUEST_FORM_ID) return { eligible: false };
  if (!hiddenValue(submission, 'alreadybooked')) return { eligible: false };
  const contact = extractContact(submission);
  const customers = await findMatchingCustomers({ email: contact.email, phone: contact.phone });
  const booking = await findExtConsultBooking(customers.map((c) => c.id));
  if (!booking) return { eligible: true, found: false, contact };
  const customer = customers.find((c) => c.id === booking.customer_id);
  return {
    eligible: true,
    found: true,
    contact,
    booking,
    customer,
    depositPaid: depositPaidForBooking(customer?.note, booking.id),
  };
}

export default async function handler(req, res) {
  try {
    const submissionID = req.method === 'GET' ? req.query?.submissionID : req.body?.submissionID;
    if (!submissionID || !/^\d{5,25}$/.test(String(submissionID))) {
      return res.status(400).json({ error: 'Missing or invalid submissionID' });
    }

    if (req.method === 'GET') {
      const loc = await locate(String(submissionID));
      if (!loc.eligible) return res.status(404).json({ found: false });
      if (!loc.found) {
        await sendAlertEmail(
          'Lumiere Luxe: deposit page could not match a booking',
          `A guest opened the deposit page for submission ${submissionID} but no live extensions-consult ` +
          `booking matched their form email/phone (${loc.contact?.email || 'no email'}, ${loc.contact?.phone || 'no phone'}). ` +
          `They were told to contact the salon. Their $35 deposit is NOT collected.`
        );
        return res.status(200).json({ found: false });
      }
      return res.status(200).json({
        found: true,
        depositPaid: loc.depositPaid,
        startAt: loc.booking.start_at,
        startLabel: fmtStart(loc.booking.start_at),
        firstName: loc.contact.firstName || '',
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const { sourceId } = req.body || {};
    // Only fresh Web Payments nonces — never a stored card-on-file id.
    if (!sourceId || !/^cnon:/.test(String(sourceId))) {
      return res.status(400).json({ error: 'invalid_source', detail: GENERIC_DECLINE });
    }

    const loc = await locate(String(submissionID));
    if (!loc.eligible || !loc.found) {
      if (loc.eligible) {
        await sendAlertEmail(
          'Lumiere Luxe: deposit PAYMENT attempt could not match a booking',
          `A guest pressed Pay on the deposit page (submission ${submissionID}) but no live ` +
          `extensions-consult booking matched. No charge was made.`
        );
      }
      return res.status(404).json({
        error: 'booking_not_found',
        detail: 'We could not find your consultation appointment, and your card has not been charged. Please text or call the salon and we will sort out your deposit together.',
      });
    }

    // Fresh double-charge guard: re-read the note right before charging.
    const freshCustomer = (await squareRequest('GET', `/v2/customers/${loc.booking.customer_id}`)).customer;
    if (depositPaidForBooking(freshCustomer?.note, loc.booking.id)) {
      return res.status(200).json({ success: true, alreadyPaid: true, startLabel: fmtStart(loc.booking.start_at) });
    }

    let payment;
    try {
      const paymentRes = await squareRequest('POST', '/v2/payments', {
        // Nonce-scoped key: a retry with a NEW card is a new key (never replays an
        // old decline), the same nonce double-submitted dedupes. Nonces are long,
        // so slice from the token side and never truncate it away.
        idempotency_key: `extdep-${String(sourceId).slice(-37)}`.slice(0, 45),
        source_id: sourceId,
        amount_money: { amount: DEPOSIT_AMOUNT_CENTS, currency: 'USD' },
        customer_id: loc.booking.customer_id,
        location_id: LOCATION_ID,
        reference_id: loc.booking.id.slice(0, 40),
        note: 'Extensions Consultation Deposit',
      });
      payment = paymentRes.payment;
    } catch (err) {
      // Generic message only: per-decline detail (CVV vs AVS vs insufficient
      // funds) is exactly what card-testing scripts harvest.
      console.error('[ext-deposit] payment failed:', err.message);
      return res.status(402).json({ error: 'payment_failed', detail: GENERIC_DECLINE });
    }

    // Two-tabs race: if another request charged and marked this booking while we
    // were charging, refund OUR payment and report paid.
    let raceLost = false;
    try {
      const afterCustomer = (await squareRequest('GET', `/v2/customers/${loc.booking.customer_id}`)).customer;
      if (depositPaidForBooking(afterCustomer?.note, loc.booking.id)) {
        raceLost = true;
        await squareRequest('POST', '/v2/refunds', {
          idempotency_key: `extdeprefund-${payment.id}`.slice(0, 45),
          payment_id: payment.id,
          amount_money: { amount: DEPOSIT_AMOUNT_CENTS, currency: 'USD' },
          reason: 'Duplicate extensions deposit (concurrent submission)',
        });
        return res.status(200).json({ success: true, alreadyPaid: true, startLabel: fmtStart(loc.booking.start_at) });
      }

      // Same header format extensions-book.mjs writes, so every existing
      // "DEPOSIT PAID" detection (nudge skip, escalation skip, Slack booking
      // alert) keeps working unchanged.
      const depositHeader = [
        `--- DEPOSIT PAID — $35 ---`,
        `Extensions consultation booked for ${fmtStart(loc.booking.start_at)}`,
        `Booking ID: ${loc.booking.id}`,
        `Payment ID: ${payment.id}`,
        `Apply $35 credit toward extension services if guest moves forward.`,
        `(Deposit collected after a direct Square booking, via the new guest form.)`,
      ].join('\n');
      const existingNote = afterCustomer?.note || '';
      await squareRequest('PUT', `/v2/customers/${loc.booking.customer_id}`, {
        note: existingNote ? `${depositHeader}\n\n${existingNote}` : depositHeader,
      });
    } catch (err) {
      if (raceLost) {
        console.error('[ext-deposit] refund of duplicate payment FAILED:', err.message);
        await sendAlertEmail(
          'Lumiere Luxe: DUPLICATE deposit charged and refund FAILED',
          `Payment ${payment.id} for booking ${loc.booking.id} duplicates an earlier deposit and the automatic ` +
          `refund failed. Refund it by hand in Square.\nError: ${err.message}`
        );
        return res.status(200).json({ success: true, alreadyPaid: true, startLabel: fmtStart(loc.booking.start_at) });
      }
      console.error('[ext-deposit] note update failed (payment succeeded):', err.message);
      await sendAlertEmail(
        'Lumiere Luxe: deposit charged but DEPOSIT PAID note write FAILED',
        `Payment ${payment.id} for booking ${loc.booking.id} succeeded but the customer note update failed, ` +
        `so the deposit is not marked in Square. Fix the note by hand.\nError: ${err.message}`
      );
    }

    const name = slackEscape(`${loc.contact.firstName || ''} ${loc.contact.lastName || ''}`.trim() || 'A guest');
    const pendingWarning = loc.booking.status === 'PENDING'
      ? `\n⚠️ Their booking request is still PENDING your acceptance in Square. If you decline it, refund the $35.`
      : '';
    await slackMichelle(
      `💎 *Extensions Deposit Collected*\n\n*${name}* booked their extensions consultation directly on Square, ` +
      `then paid the $35 deposit through the new guest form flow.\n📅 ${fmtStart(loc.booking.start_at)}\n` +
      `💰 Deposit paid — apply $35 credit toward extension services if they move forward.${pendingWarning}\n` +
      `👉 <https://www.jotform.com/tables/${NEW_GUEST_FORM_ID}|View their form submission>`
    );

    return res.status(200).json({ success: true, startLabel: fmtStart(loc.booking.start_at) });
  } catch (err) {
    console.error('[ext-deposit] error:', err.message);
    // No internal error text to the public.
    return res.status(500).json({ error: 'lookup_failed' });
  }
}
