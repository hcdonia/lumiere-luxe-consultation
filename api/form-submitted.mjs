// Jotform webhook receiver for the NEW GUEST CONSULTATION FORM (251448462902155).
//
// Why this exists (Michelle's report, 2026-07-28): guests filled out the form and
// got NOTHING by text/email — the AI recommendation + booking link only existed on
// the redirect page, so closing the tab lost everything. This webhook fires on
// every submission and, independent of whether the guest ever opens that page:
//   1. Texts (or emails, when no phone) the guest a recap: their recommended
//      service + a personal link back to their results/booking page. A guest who
//      ALREADY booked (hidden alreadybooked field, prefped via the form links we
//      text to booked guests) gets a "you're all set" message with no booking push.
//   2. Saves the consultation prep notes to the Square customer (deduped by
//      submissionID against the results-page write path).
//   3. Slacks Michelle about the submission (she ran out of Jotform notification
//      emails, so Jotform's own notifications are unreliable).
//
// Safety posture:
//   - Token-gated (?token=JOTFORM_WEBHOOK_SECRET) — Jotform can't sign webhooks.
//   - Re-fetches the submission from the Jotform API (never trusts the raw body).
//   - Dedupe: hidden `recapsent` field on the form. Jotform re-fires webhooks when
//     a submission is EDITED (e.g. Michelle in Tables), so we claim the marker
//     BEFORE sending (claim-then-send). A failed send after a claim alerts Hunter
//     by email rather than silently retrying into a double-text.
//   - Always returns 200 so Jotform never retry-storms.
//   - ?dry=1 computes everything and sends/claims nothing (for testing).

import {
  fetchSubmission,
  wantsExtensions,
  wantsHaircutOnly,
  buildHaircutRecommendation,
  generateRecommendation,
  extractClientInfo,
  hiddenField,
} from '../lib/recommendation.mjs';
import { saveConsultation } from '../lib/consultation-note.mjs';

// Jotform posts multipart/form-data; keep the raw bytes so we can parse it.
export const config = { api: { bodyParser: false } };

const NEW_GUEST_FORM_ID = '251448462902155';
const JOTFORM_TABLES_URL = `https://www.jotform.com/tables/${NEW_GUEST_FORM_ID}`;
const RESULTS_BASE_URL = 'https://lumiere-luxe-consultation.vercel.app';

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const WEBHOOK_SECRET = clean(process.env.JOTFORM_WEBHOOK_SECRET);
const OPENPHONE_API_KEY = clean(process.env.OPENPHONE_API_KEY);
const OPENPHONE_FROM_NUMBER = clean(process.env.OPENPHONE_FROM_NUMBER);
const RESEND_KEY = clean(process.env.RESEND_API_KEY);
const ALERT_TO = clean(process.env.ALERT_EMAIL_TO) || 'hunter@hairbyhunty.com';
const ALERT_FROM = clean(process.env.ALERT_EMAIL_FROM) || 'Lumiere Luxe Bot <noreply@hunterdonia.com>';
const RECAP_EMAIL_FROM =
  clean(process.env.WELCOME_PACKET_EMAIL_FROM) || 'Lumiere Luxe Salon <noreply@hunterdonia.com>';

// --- Raw body parsing (same as jotform-kit-webhook) -------------------------
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

function getField(raw, contentType, fieldName) {
  if (!raw) return null;
  const ct = (contentType || '').toLowerCase();

  if (ct.includes('application/json') || raw.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && j[fieldName] != null) return String(j[fieldName]).trim();
    } catch { /* fall through */ }
  }

  const re = new RegExp(`name="${fieldName}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`, 'i');
  const m = raw.match(re);
  if (m) return m[1].trim();

  try {
    const v = new URLSearchParams(raw).get(fieldName);
    if (v != null) return String(v).trim();
  } catch { /* ignore */ }

  return null;
}

// --- Messaging --------------------------------------------------------------
const toE164 = (raw) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
};

async function sendQuoSms(toPhone, content) {
  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: { Authorization: OPENPHONE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: OPENPHONE_FROM_NUMBER, to: [toPhone], content }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Quo ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendRecapEmail(to, subject, html, text) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RECAP_EMAIL_FROM, to: [to], subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendAlertEmail(subject, text) {
  if (!RESEND_KEY) { console.error('[form-submitted] RESEND_API_KEY not set:', subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text }),
    });
  } catch (e) { console.error('[form-submitted] alert email threw:', e.message); }
}

// --- Slack (DM Michelle; email-alert fallback) ------------------------------
async function findSlackUser(name) {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) return null;
  const n = name.toLowerCase();
  return data.members.find((u) => {
    if (u.is_bot || u.deleted || u.id === 'USLACKBOT') return false;
    const real = (u.real_name || '').toLowerCase(), disp = (u.profile?.display_name || '').toLowerCase();
    return real === n || disp === n || real.includes(n) || n.includes(real);
  });
}
async function slackDM(userId, text) {
  const open = await (await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: userId }),
  })).json();
  if (!open.ok) { console.error('[form-submitted] Slack open error:', open.error); return false; }
  const msg = await (await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: open.channel.id, text, mrkdwn: true }),
  })).json();
  if (!msg.ok) { console.error('[form-submitted] Slack post error:', msg.error); return false; }
  return true;
}
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tellMichelle(text) {
  try {
    const michelle = await findSlackUser('Michelle Sanders');
    if (michelle && (await slackDM(michelle.id, text))) return 'slack';
  } catch (e) {
    console.error('[form-submitted] Slack notify threw:', e.message);
  }
  await sendAlertEmail('Lumiere Luxe: new guest form submitted (Slack to Michelle failed)', text.replace(/[*_`>]/g, ''));
  return 'email-fallback';
}

// --- Dedupe marker (hidden `recapsent` field, set via the submission-edit API)
async function claimRecapMarker(submissionID, qid) {
  const body = new URLSearchParams({ [`submission[${qid}]`]: `sent ${new Date().toISOString()}` });
  const res = await fetch(`https://api.jotform.com/submission/${submissionID}?apiKey=${JOTFORM_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Jotform submission edit failed: ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.responseCode && data.responseCode !== 200) {
    throw new Error(`Jotform submission edit error: ${data.message || data.responseCode}`);
  }
}

// --- Copy (Michelle's voice, no em-dashes) ----------------------------------
const smsStandard = (first, serviceName, link) =>
  `Hi ${first}, thanks for filling out our new guest form at Lumiere Luxe! Based on your answers, ` +
  `we recommend our ${serviceName}. You can see your full recommendation and book your appointment ` +
  `right here whenever you're ready: ${link}`;
const smsExtensions = (first, link) =>
  `Hi ${first}, thanks for filling out our new guest form at Lumiere Luxe! The next step for ` +
  `extensions is a consultation with our extensionist, and a $35 deposit reserves your spot. ` +
  `Pick your time here: ${link}`;
const smsAllSet = (first) =>
  `Hi ${first}, thanks for filling out your new guest form at Lumiere Luxe! You're all set for ` +
  `your upcoming appointment and we can't wait to see you.`;

const emailHtml = (first, bodyLines) => [
  `<p>Hi ${first},</p>`,
  ...bodyLines.map((l) => `<p>${l}</p>`),
  `<p>Lumiere Luxe Salon</p>`,
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (WEBHOOK_SECRET) {
    const rawToken = req.query?.token;
    const token = clean(Array.isArray(rawToken) ? rawToken[0] : rawToken);
    if (token !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid token' });
    }
  }

  const dry = req.query?.dry === '1';

  try {
    const raw = await readRawBody(req);
    const contentType = req.headers['content-type'] || '';
    const formID = getField(raw, contentType, 'formID');
    const submissionID = getField(raw, contentType, 'submissionID');

    if (formID && formID !== NEW_GUEST_FORM_ID) {
      return res.status(200).json({ received: true, skipped: `unmapped form: ${formID}` });
    }
    if (!submissionID) {
      return res.status(200).json({ received: true, skipped: 'no submissionID' });
    }
    if (!JOTFORM_KEY) {
      console.error('[form-submitted] JOTFORM_API_KEY not set');
      return res.status(200).json({ received: true, skipped: 'no jotform key' });
    }

    // Re-fetch the full submission (don't trust the raw webhook body).
    const submission = await fetchSubmission(submissionID);

    // Dedupe: a set recapsent marker means we've handled this submission (Jotform
    // re-fires webhooks on submission EDITS, so this is load-bearing, not paranoia).
    const recapField = hiddenField(submission, 'recapsent');
    if (recapField?.value) {
      return res.status(200).json({ received: true, skipped: 'recap already sent' });
    }

    const alreadyBooked = !!hiddenField(submission, 'alreadybooked')?.value;
    const gclid = hiddenField(submission, 'gclid')?.value || '';
    const isExtensions = wantsExtensions(submission);
    const clientInfo = extractClientInfo(submission);
    const first = ((clientInfo.givenName || '').trim() || 'there').slice(0, 40);
    const e164 = toE164(clientInfo.phone);
    const email = (clientInfo.email || '').trim();

    const resultsParams = new URLSearchParams({ submissionID });
    if (gclid) resultsParams.set('gclid', gclid);
    const resultsLink = `${RESULTS_BASE_URL}/?${resultsParams.toString()}`;

    // Claim the dedupe marker BEFORE sending. If the claim fails we still proceed
    // (a missing recap is the failure Michelle reported; a rare double-text on an
    // edited submission is the lesser evil), but we log it.
    if (!dry && recapField) {
      try {
        await claimRecapMarker(submissionID, recapField.qid);
      } catch (e) {
        console.error('[form-submitted] recap marker claim failed:', e.message);
      }
    }

    // --- Work out the recommendation + guest message -----------------------
    let serviceName = null;
    let noteResult = { status: 'skipped' };
    let smsBody, emailSubject, emailBodyLines;

    if (isExtensions) {
      // Extensions guests book via the deposit flow on the results page; their
      // Square profile is created at deposit time, so no prep-note write here.
      serviceName = 'Extensions consultation';
      if (alreadyBooked) {
        smsBody = smsAllSet(first);
        emailSubject = 'Your new guest form is in, you are all set';
        emailBodyLines = [
          `Thanks for filling out your new guest form! You're all set for your upcoming appointment and we can't wait to see you.`,
        ];
      } else {
        smsBody = smsExtensions(first, resultsLink);
        emailSubject = 'Your next step for extensions at Lumiere Luxe';
        emailBodyLines = [
          `Thanks for filling out our new guest form! The next step for extensions is a consultation with our extensionist, and a $35 deposit reserves your spot.`,
          `<a href="${resultsLink}">Pick your consultation time here</a>`,
        ];
      }
    } else {
      const recommendation = wantsHaircutOnly(submission)
        ? buildHaircutRecommendation(submission)
        : await generateRecommendation(submission);
      serviceName = recommendation.serviceName;

      // Save prep notes for Michelle. For already-booked guests (who skip the
      // results page entirely now) this webhook is the ONLY write path.
      try {
        if (!dry) {
          noteResult = await saveConsultation({
            clientInfo,
            consultationSummary: recommendation.consultationSummary,
            recommendedService: recommendation.serviceName,
            submissionID,
          });
        } else {
          noteResult = { status: 'dry' };
        }
      } catch (e) {
        console.error('[form-submitted] saveConsultation failed:', e.message);
        noteResult = { status: 'error', error: e.message };
      }

      if (alreadyBooked) {
        smsBody = smsAllSet(first);
        emailSubject = 'Your new guest form is in, you are all set';
        emailBodyLines = [
          `Thanks for filling out your new guest form! You're all set for your upcoming appointment and we can't wait to see you.`,
        ];
      } else {
        smsBody = smsStandard(first, recommendation.serviceName, resultsLink);
        emailSubject = `Your personalized recommendation from Lumiere Luxe`;
        emailBodyLines = [
          `Thanks for filling out our new guest form! Based on your answers, we recommend our <strong>${recommendation.serviceName}</strong>.`,
          `<a href="${resultsLink}">See your full recommendation and book your appointment here</a>`,
          `If any questions come up, just give us a text or a call and we are happy to help.`,
        ];
      }
    }

    // --- Send to the guest (SMS first, email when no usable phone) ---------
    let sent = { channel: null };
    if (dry) {
      sent = { channel: 'dry', smsBody, emailSubject, to: e164 || email || 'none' };
    } else if (e164) {
      try {
        await sendQuoSms(e164, smsBody);
        sent = { channel: 'sms' };
      } catch (e) {
        console.error('[form-submitted] SMS failed:', e.message);
        if (email) {
          try {
            await sendRecapEmail(email, emailSubject, emailHtml(first, emailBodyLines), smsBody);
            sent = { channel: 'email-fallback' };
          } catch (e2) {
            sent = { channel: null, error: e2.message };
          }
        } else {
          sent = { channel: null, error: e.message };
        }
      }
    } else if (email) {
      try {
        await sendRecapEmail(email, emailSubject, emailHtml(first, emailBodyLines), smsBody);
        sent = { channel: 'email' };
      } catch (e) {
        sent = { channel: null, error: e.message };
      }
    } else {
      sent = { channel: null, error: 'no phone or email on submission' };
    }

    if (!dry && !sent.channel) {
      await sendAlertEmail(
        'Lumiere Luxe: new-guest recap FAILED to send',
        `Could not text or email the recap for submission ${submissionID} ` +
        `(${clientInfo.givenName || ''} ${clientInfo.familyName || ''}, ${clientInfo.phone || 'no phone'}, ${clientInfo.email || 'no email'}).\n` +
        `Error: ${sent.error || 'unknown'}\nTime (UTC): ${new Date().toISOString()}`
      );
    }

    // --- Slack Michelle (every submission; her Jotform emails ran out) -----
    const name = `${clientInfo.givenName || ''} ${clientInfo.familyName || ''}`.trim() || 'Unknown';
    const sentLabel = { sms: 'texted', email: 'emailed', 'email-fallback': 'emailed (SMS failed)' }[sent.channel]
      || (dry ? 'DRY RUN, nothing sent' : 'NOT sent (no phone/email worked)');
    const michelleMsg = [
      `📝 *New Guest Form Submitted*`,
      ``,
      `*${slackEscape(name)}* just filled out the new guest consultation form.`,
      serviceName ? `💇 Recommended: *${slackEscape(serviceName)}*` : '',
      alreadyBooked ? `✅ They already have an appointment booked, so I sent a "you're all set" note (no booking link).` : `💬 They've been ${sentLabel} their recommendation and booking link.`,
      clientInfo.phone ? `📱 ${slackEscape(clientInfo.phone)}` : '',
      clientInfo.email ? `📧 ${slackEscape(clientInfo.email)}` : '',
      ``,
      `👉 <${JOTFORM_TABLES_URL}|View the full submission>`,
    ].filter(Boolean).join('\n');
    const michelleNotified = dry ? 'dry' : await tellMichelle(michelleMsg);

    return res.status(200).json({
      received: true,
      dry,
      submissionID,
      flow: isExtensions ? 'extensions' : serviceName,
      alreadyBooked,
      sent,
      note: noteResult,
      michelleNotified,
    });
  } catch (err) {
    // Never make Jotform retry-storm — log, alert, acknowledge.
    console.error('[form-submitted] processing error:', err.message);
    await sendAlertEmail('Lumiere Luxe: form-submitted webhook FAILED', `${err.message}\n${err.stack || ''}`);
    return res.status(200).json({ received: true, error: true });
  }
}
