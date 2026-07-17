// Escalation sweep for new guests who booked WITHOUT the new-guest form.
// (Michelle's policy, 2026-07-02.) Cron: every 4h (see vercel.json).
//
//  FULL TRACK  (appointment comfortably >=52h out):
//    +24h no form -> reminder    +36h no form -> final reminder    +48h no form -> AUTO-CANCEL
//    (cancel also triggers once the appt is within ~18h, so the last business-hours
//     run before the appointment always catches it and no early-morning appt slips through.)
//  SHORT-NOTICE (appointment <52h out): Slack Michelle immediately + compressed
//    reminders, NO auto-cancel.
//
//  Forward-only (never touches bookings created before GO_LIVE), soft re-booking,
//  re-checks the form every run AND fresh right before cancelling, fails CLOSED if
//  the Jotform lookup is incomplete, and never auto-cancels when the guest's NAME is
//  in the submissions (likely filled it with a different phone/email -> Slack Michelle).
//  Customer texts only go out in salon business hours; Slack-to-Michelle can go anytime.

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const SALON_TZ = 'America/Los_Angeles';

const NEW_GUEST_FORM_ID = '251448462902155';
const NEW_GUEST_FORM_URL = `https://form.jotform.com/${NEW_GUEST_FORM_ID}`;
const CONSULT_ATTR_KEY = 'square:9084740e-1f93-4c87-8937-cce6569f2faa';

// Forward-only anchor: bookings created before this are never escalated/cancelled.
const GO_LIVE = new Date('2026-07-02T21:00:00Z');

const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const R24_H = 24;
const R36_H = 36;
const CANCEL_H = 48;
const FULL_TRACK_MIN_LEAD_H = 52;    // cancel (at 48h) must land safely before the appt
const OVERNIGHT_SAFETY_H = 18;       // also cancel once appt is this close, so the last
                                     // business-hours run before it catches the overnight gap
const BUSINESS_START = 8;            // LA hour: customer texts only 8am-8pm
const BUSINESS_END = 20;

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const OPENPHONE_API_KEY = clean(process.env.OPENPHONE_API_KEY);
const OPENPHONE_FROM_NUMBER = clean(process.env.OPENPHONE_FROM_NUMBER);

const M = {
  R24: '[NGF-R24]', R36: '[NGF-R36]', CANCELLED: '[NGF-CANCELLED]', NAMEHOLD: '[NGF-NAMEHOLD]',
  SN1: '[NGF-SN1]', SN2: '[NGF-SN2]', SN_NOTIFY: '[NGF-SN-NOTIFY]',
};
// Actions that send an SMS to the guest are held to business hours; Slack-only is not.
const NEEDS_BUSINESS_HOURS = new Set(['r24', 'r36', 'sn1', 'sn2', 'cancel']);

// --- Copy (Michelle's voice; no em-dashes) --------------------------------
// Full-track reminders WARN about the auto-cancel (these bookings do get cancelled at 48h).
const reminderFullR24 = (first) =>
  `Hi ${first}, just a friendly reminder from Lumiere Luxe. We still need your new guest form to confirm your appointment, and it will be automatically canceled if we don't receive it. It only takes a couple minutes: ${NEW_GUEST_FORM_URL}`;
const reminderFullR36 = (first) =>
  `Hi ${first}, this is your final reminder from Lumiere Luxe. We still haven't received your new guest form, so your appointment will be automatically canceled soon if we don't get it. Please fill it out here to keep your spot: ${NEW_GUEST_FORM_URL}`;
// Short-notice reminders do NOT threaten auto-cancel (these are never auto-cancelled; Michelle decides).
const reminderShort1 = (first) =>
  `Hi ${first}, just a friendly reminder from Lumiere Luxe. We still need your new guest form to confirm your appointment, it only takes a couple minutes: ${NEW_GUEST_FORM_URL}`;
const reminderShort2 = (first) =>
  `Hi ${first}, quick heads up from Lumiere Luxe. We still haven't received your new guest form, and we need it to keep your appointment on the books. Please fill it out here so we can confirm you: ${NEW_GUEST_FORM_URL}`;
const cancelText = (first) =>
  `Hi ${first}, since we didn't receive your new guest form we've had to release your appointment at Lumiere Luxe. We would still love to see you, just fill out the form and you can book again anytime: ${NEW_GUEST_FORM_URL}`;

// --- Square ---------------------------------------------------------------
async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-03-19' },
  });
  return res.json();
}
async function squarePut(path, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-03-19' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function squarePost(path, body) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-03-19' },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function getCustomer(customerId) { return (await squareGet(`/v2/customers/${customerId}`)).customer; }
async function getBooking(bookingId) { return (await squareGet(`/v2/bookings/${bookingId}`)).booking; }
async function cancelBooking(bookingId, version) {
  const res = await fetch(`${SQUARE_BASE_URL}/v2/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-03-19' },
    body: JSON.stringify({ booking_version: version }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`cancel ${res.status}: ${JSON.stringify(data.errors || data)}`);
  return data;
}
async function searchUpcomingBookings(now) {
  const min = now.toISOString();
  const max = new Date(now.getTime() + 31 * 864e5).toISOString(); // Square caps range at 31 days
  const out = [];
  let cursor;
  do {
    const params = new URLSearchParams({ location_id: LOCATION_ID, start_at_min: min, start_at_max: max, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await squareGet(`/v2/bookings?${params.toString()}`);
    for (const b of data.bookings || []) out.push(b);
    cursor = data.cursor;
  } while (cursor && out.length < 2000);
  return out;
}

// --- Phone / name / form detection ---------------------------------------
const toE164 = (raw) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
};
const last10 = (raw) => { if (!raw) return null; const d = String(raw).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const nameKey = (first, last) => `${first || ''}${last || ''}`.toLowerCase().replace(/[^a-z]/g, '') || null;

async function fetchNewGuestFormIndex() {
  const LIMIT = 1000, MAX_PAGES = 50;
  const phones = new Set(), emails = new Set(), names = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`https://api.jotform.com/form/${NEW_GUEST_FORM_ID}/submissions?apiKey=${JOTFORM_KEY}&limit=${LIMIT}&offset=${page * LIMIT}`);
      if (!res.ok) { console.error(`[escalate] Jotform lookup failed: ${res.status}`); return { ok: false, phones: new Set(), emails: new Set(), names: new Set() }; }
      const data = await res.json();
      const rows = data.content || [];
      for (const sub of rows) {
        let first = '', last = '';
        for (const ans of Object.values(sub.answers || {})) {
          if (ans.type === 'control_phone') { const p = last10(ans.answer?.full || ans.answer); if (p) phones.add(p); }
          if (ans.type === 'control_email' && ans.answer) emails.add(String(ans.answer).toLowerCase());
          if (ans.type === 'control_fullname' && ans.answer) { first = first || ans.answer.first || ''; last = last || ans.answer.last || ''; }
          if (ans.type === 'control_textbox' && ans.answer) {
            const label = (ans.text || '').toLowerCase();
            if (label.includes('first name')) first = first || ans.answer;
            if (label.includes('last name')) last = last || ans.answer;
          }
        }
        const nk = nameKey(first, last);
        if (nk) names.add(nk);
      }
      if (rows.length < LIMIT) return { ok: true, phones, emails, names };
    }
    console.error('[escalate] Jotform pagination exceeded MAX_PAGES — failing closed');
    return { ok: false, phones: new Set(), emails: new Set(), names: new Set() };
  } catch (err) { console.error('[escalate] Jotform lookup threw:', err.message); return { ok: false, phones: new Set(), emails: new Set(), names: new Set() }; }
}
async function hasConsultationAttribute(customerId) {
  try {
    const data = await squareGet(`/v2/customers/${customerId}/custom-attributes/${encodeURIComponent(CONSULT_ATTR_KEY)}`);
    return !!data.custom_attribute?.value;
  } catch { return false; }
}
async function hasFormOnFile(customer, formIndex) {
  const p10 = last10(customer.phone_number), email = (customer.email_address || '').toLowerCase();
  if ((p10 && formIndex.phones.has(p10)) || (email && formIndex.emails.has(email))) return true;
  if (customer.reference_id) return true;
  const note = customer.note || '';
  if (note.includes('Hair Consultation') || note.includes('DEPOSIT PAID')) return true; // incl. extensions guests
  return await hasConsultationAttribute(customer.id);
}
const nameInSubmissions = (customer, formIndex) => {
  const nk = nameKey(customer.given_name, customer.family_name);
  return !!nk && formIndex.names.has(nk);
};
function isNewCustomer(customer, bookingCreatedAt) {
  const diffMin = Math.abs(new Date(bookingCreatedAt) - new Date(customer.created_at)) / 6e4;
  return diffMin <= NEW_CUSTOMER_THRESHOLD_MINUTES;
}

// A returning client can still look brand new: Square's online booking / booking-request
// flow creates a FRESH customer record when they re-enter their info, even if they've been
// in for years. That fresh record trips isNewCustomer(), so without this guard we'd chase a
// real existing client for the new-guest form and eventually auto-cancel them.
//
// Layered so a returning client can never slip through:
//   1. buildCustomerIndex() maps EVERY customer by phone, email, AND first+last name to the
//      earliest record for that key. returningMatch() flags the guest if ANY of those keys
//      already existed before their record — a match on any one of the four fields is enough.
//   2. The index build fails CLOSED: if it can't page the full customer list, the whole run is
//      skipped (no texts, no cancels), so a broken lookup can never fabricate a "new guest".
//   3. returningByLiveSearch() is a fresh, independent live re-check run right before the
//      irreversible cancel; if it finds an older record OR errors, the cancel is aborted.
const RETURNING_MARGIN_MS = 10 * 60 * 1000; // an "older" record must predate this one by >10 min

async function buildCustomerIndex() {
  const MAX_PAGES = 200; // 200 * 100 = 20k customers; guards against an unbounded loop
  const byPhone = new Map(), byEmail = new Map(), byName = new Map();
  const addEarliest = (map, key, ms) => {
    if (!key || Number.isNaN(ms)) return;
    const prev = map.get(key);
    if (prev === undefined || ms < prev) map.set(key, ms);
  };
  try {
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = { limit: 100 };
      if (cursor) body.cursor = cursor;
      const data = await squarePost('/v2/customers/search', body);
      if (data.errors) { console.error('[escalate] customer index error:', JSON.stringify(data.errors)); return { ok: false }; }
      for (const c of data.customers || []) {
        const ms = new Date(c.created_at).getTime();
        addEarliest(byPhone, last10(c.phone_number), ms);
        addEarliest(byEmail, (c.email_address || '').toLowerCase() || null, ms);
        addEarliest(byName, nameKey(c.given_name, c.family_name), ms);
      }
      cursor = data.cursor;
      if (!cursor) return { ok: true, byPhone, byEmail, byName };
    }
    console.error('[escalate] customer index exceeded MAX_PAGES — failing closed');
    return { ok: false };
  } catch (e) {
    console.error('[escalate] customer index threw:', e.message);
    return { ok: false };
  }
}

// Returns which field matched an OLDER record ('phone' | 'email' | 'name'), or null.
function returningMatch(customer, index) {
  const created = new Date(customer.created_at).getTime();
  if (Number.isNaN(created)) return null;
  const older = (ms) => ms !== undefined && ms < created - RETURNING_MARGIN_MS;
  if (older(index.byPhone.get(last10(customer.phone_number)))) return 'phone';
  if (older(index.byEmail.get((customer.email_address || '').toLowerCase() || null))) return 'email';
  if (older(index.byName.get(nameKey(customer.given_name, customer.family_name)))) return 'name';
  return null;
}

// Independent last-line fallback used right before an irreversible cancel. Live-searches Square
// by phone and email for an older record. Returns the matched field, or 'lookup-error' so the
// caller can DEFER the cancel (never cancel on an inconclusive check), or null if truly clear.
async function returningByLiveSearch(customer) {
  const p10 = last10(customer.phone_number);
  const email = (customer.email_address || '').toLowerCase();
  if (!p10 && !email) return null;
  const created = new Date(customer.created_at).getTime();
  const filters = [];
  if (p10) filters.push(['phone', { phone_number: { fuzzy: p10 } }]);
  if (email) filters.push(['email', { email_address: { fuzzy: email } }]);
  try {
    for (const [field, filter] of filters) {
      const data = await squarePost('/v2/customers/search', { query: { filter }, limit: 50 });
      if (data.errors) { console.error('[escalate] live returning search error:', JSON.stringify(data.errors)); return 'lookup-error'; }
      for (const c of data.customers || []) {
        if (c.id === customer.id) continue;
        const cp10 = last10(c.phone_number), cemail = (c.email_address || '').toLowerCase();
        const match = (p10 && cp10 === p10) || (email && cemail === email);
        if (!match) continue;
        if (new Date(c.created_at).getTime() < created - RETURNING_MARGIN_MS) return field;
      }
    }
  } catch (e) {
    console.error('[escalate] live returning search threw:', e.message);
    return 'lookup-error';
  }
  return null;
}

// --- Messaging ------------------------------------------------------------
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
async function findSlackUser(name) {
  const res = await fetch('https://slack.com/api/users.list', { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
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
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ users: userId }),
  })).json();
  if (!open.ok) { console.error('Slack open error:', open.error); return false; }
  const msg = await (await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: open.channel.id, text, mrkdwn: true }),
  })).json();
  if (!msg.ok) { console.error('Slack post error:', msg.error); return false; }
  return true;
}
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Slack to Michelle, with an email fallback if she can't be found on Slack.
async function tellMichelle(michelle, text) {
  if (michelle) { await slackDM(michelle.id, text); return; }
  await sendAlertEmail('Lumiere Luxe: new-guest escalation (Michelle not on Slack)', text.replace(/[*_`>]/g, ''));
}

const RESEND_KEY = clean(process.env.RESEND_API_KEY);
const ALERT_TO = clean(process.env.ALERT_EMAIL_TO) || 'hunter@hairbyhunty.com';
const ALERT_FROM = clean(process.env.ALERT_EMAIL_FROM) || 'Lumiere Luxe Bot <noreply@hunterdonia.com>';
async function sendAlertEmail(subject, text) {
  if (!RESEND_KEY) { console.error('[escalate] RESEND_API_KEY not set:', subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, text }),
    });
  } catch (e) { console.error('[escalate] alert email threw:', e.message); }
}

// Re-read the note fresh right before writing so we never clobber another job's marker.
async function appendMarker(customerId, marker) {
  const fresh = await getCustomer(customerId);
  const note = fresh?.note || '';
  if (note.includes(marker)) return;
  await squarePut(`/v2/customers/${customerId}`, { note: note ? `${note}\n${marker}` : marker });
}

const laHour = (date) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: SALON_TZ, hour: 'numeric', hour12: false }).format(date), 10);

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const dry = req.query?.dry === '1';
  const ignoreHours = req.query?.anyhour === '1'; // testing only

  // Forward-only anchor. The ?golive override is testing-only: it must be a valid
  // date AND dry=1, so a typo can never silently strip forward-only protection.
  let goLive = GO_LIVE;
  if (req.query?.golive) {
    const g = new Date(req.query.golive);
    if (Number.isNaN(g.getTime()) || !dry) {
      return res.status(400).json({ error: 'golive override requires a valid ISO date and dry=1' });
    }
    goLive = g;
  }

  try {
    const inBusinessHours = (laHour(now) >= BUSINESS_START && laHour(now) < BUSINESS_END) || ignoreHours;

    const formIndex = await fetchNewGuestFormIndex();
    if (!formIndex.ok) {
      await sendAlertEmail('Lumiere Luxe: escalation sweep skipped (Jotform lookup failed)',
        `The new-guest escalation sweep could not build a complete Jotform index, so it took NO actions this run. Check JOTFORM_API_KEY. Time (UTC): ${now.toISOString()}`);
      return res.status(200).json({ ran: true, skipped: 'jotform lookup failed (failed closed)' });
    }

    // Returning-client index (phone/email/name). Fails CLOSED: without a complete customer
    // list we can't be sure a "new guest" isn't a returning client, so we take no actions.
    const customerIndex = await buildCustomerIndex();
    if (!customerIndex.ok) {
      await sendAlertEmail('Lumiere Luxe: escalation sweep skipped (customer index failed)',
        `The new-guest escalation sweep could not build a complete customer index, so it took NO actions this run (to avoid chasing or cancelling an existing client). Time (UTC): ${now.toISOString()}`);
      return res.status(200).json({ ran: true, skipped: 'customer index failed (failed closed)' });
    }

    const bookings = await searchUpcomingBookings(now);
    const michelle = await findSlackUser('Michelle Sanders');

    const results = [];
    for (const b of bookings) {
      const out = { id: b.id };
      try {
        if (['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'].includes(b.status)) { out.skip = `status ${b.status}`; results.push(out); continue; }
        if (!b.customer_id) { out.skip = 'no customer'; results.push(out); continue; }
        if (!b.appointment_segments?.[0]) { out.skip = 'no appointment segment'; results.push(out); continue; }
        if (new Date(b.created_at) < goLive) { out.skip = 'before go-live'; results.push(out); continue; }
        if (new Date(b.start_at) <= now) { out.skip = 'appt passed'; results.push(out); continue; }

        const customer = await getCustomer(b.customer_id);
        if (!customer) { out.skip = 'customer not found'; results.push(out); continue; }
        if (!isNewCustomer(customer, b.created_at)) { out.skip = 'not a new guest'; results.push(out); continue; }
        if (await hasFormOnFile(customer, formIndex)) { out.skip = 'has form'; results.push(out); continue; }
        const rmatch = returningMatch(customer, customerIndex);
        if (rmatch) { out.skip = `returning client (older record matches ${rmatch})`; results.push(out); continue; }

        const hoursSince = (now - new Date(b.created_at)) / 36e5;
        const hoursUntilAppt = (new Date(b.start_at) - now) / 36e5;
        const leadH = (new Date(b.start_at) - new Date(b.created_at)) / 36e5;
        const note = customer.note || '';
        const fullTrack = leadH >= FULL_TRACK_MIN_LEAD_H;
        const name = `${customer.given_name || ''} ${customer.family_name || ''}`.trim() || 'Unknown';
        const first = ((customer.given_name || '').trim() || 'there').slice(0, 40);
        const e164 = toE164(customer.phone_number);
        const apptLabel = new Date(b.start_at).toLocaleString('en-US', { timeZone: SALON_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        Object.assign(out, { name, hoursSince: Math.round(hoursSince), leadH: Math.round(leadH), track: fullTrack ? 'full' : 'short' });

        // Pick the single highest-priority action not yet done.
        let action = null;
        if (fullTrack) {
          const cancelReady = hoursSince >= CANCEL_H || hoursUntilAppt <= OVERNIGHT_SAFETY_H;
          const hasReminder = note.includes(M.R24) || note.includes(M.R36);
          const held = note.includes(M.CANCELLED) || note.includes(M.NAMEHOLD);
          if (cancelReady && (hasReminder || hoursUntilAppt <= 6) && !held) action = 'cancel';
          else if ((hoursSince >= R36_H || cancelReady) && !note.includes(M.R36) && !held) action = 'r36';
          else if (hoursSince >= R24_H && !note.includes(M.R24) && !held) action = 'r24';
        } else {
          if (!note.includes(M.SN_NOTIFY)) action = 'sn_notify';                       // tell Michelle ASAP
          else if (hoursSince >= leadH * (2 / 3) && !note.includes(M.SN2)) action = 'sn2';
          else if (hoursSince >= leadH * (1 / 3) && !note.includes(M.SN1)) action = 'sn1';
        }
        out.action = action || 'none';
        if (!action) { results.push(out); continue; }

        if (NEEDS_BUSINESS_HOURS.has(action) && !inBusinessHours) { out.action = `defer (${action}, off-hours)`; results.push(out); continue; }
        if (dry) { out.dry = true; results.push(out); continue; }

        if (action === 'cancel') {
          // Fresh re-checks right before the destructive action.
          const freshIdx = await fetchNewGuestFormIndex();
          if (!freshIdx.ok) { out.action = 'cancel deferred: jotform recheck failed'; results.push(out); continue; }
          const fb = await getBooking(b.id);
          if (!fb || ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_SELLER', 'DECLINED', 'NO_SHOW'].includes(fb.status)) { out.action = 'already inactive'; results.push(out); continue; }
          if (new Date(fb.start_at) <= now) { out.action = 'appt passed'; results.push(out); continue; }
          const fc = (await getCustomer(b.customer_id)) || customer;
          if (await hasFormOnFile(fc, freshIdx)) { out.action = 'skip: form now on file'; results.push(out); continue; }
          // Two independent returning-client nets before the irreversible cancel: the run's
          // index, plus a fresh live search. A live lookup error DEFERS (never cancels blind).
          const idxMatch = returningMatch(fc, customerIndex);
          if (idxMatch) { out.action = `skip: returning client (older record matches ${idxMatch})`; results.push(out); continue; }
          const liveMatch = await returningByLiveSearch(fc);
          if (liveMatch === 'lookup-error') { out.action = 'cancel deferred: returning-client recheck failed'; results.push(out); continue; }
          if (liveMatch) { out.action = `skip: returning client (live match ${liveMatch})`; results.push(out); continue; }
          if (nameInSubmissions(fc, freshIdx)) {
            // Name in submissions but no phone/email match — likely a different contact
            // on file. Do NOT auto-cancel; hand to Michelle.
            await appendMarker(fc.id, M.NAMEHOLD);
            await tellMichelle(michelle, `⚠️ *${slackEscape(name)}* is at ${Math.round(hoursSince)}h with no new-guest form match, but their name appears in your form submissions. They may have filled it out with a different phone or email, so I did NOT auto-cancel. Please check and cancel manually if needed. Appt: ${apptLabel}.`);
            out.action = 'name-hold -> michelle'; results.push(out); continue;
          }
          await cancelBooking(fb.id, fb.version);
          await appendMarker(fc.id, M.CANCELLED);
          if (e164) { try { await sendQuoSms(e164, cancelText(first)); } catch (e) { console.error('[escalate] cancel text failed:', e.message); } }
          await tellMichelle(michelle, `🚫 Auto-canceling *${slackEscape(name)}*'s appointment on ${apptLabel}. They booked ${Math.round(hoursSince)}h ago and never submitted the new guest form. They'll need the form to book again.`);
        } else if (action === 'sn_notify') {
          await appendMarker(customer.id, M.SN_NOTIFY);
          await tellMichelle(michelle, `⏰ Heads up: *${slackEscape(name)}* booked for ${apptLabel} (under 48h out) and hasn't submitted the new guest form. I'll text reminders but I don't auto-cancel short-notice bookings. Your call on whether to keep or cancel them.`);
        } else {
          if (!e164) { out.action = `skip ${action}: no phone`; results.push(out); continue; }
          const copy = { r24: reminderFullR24, r36: reminderFullR36, sn1: reminderShort1, sn2: reminderShort2 }[action];
          await sendQuoSms(e164, copy(first));
          await appendMarker(customer.id, { r24: M.R24, r36: M.R36, sn1: M.SN1, sn2: M.SN2 }[action]);
        }
        out.done = true;
        results.push(out);
      } catch (err) {
        out.error = err.message;
        results.push(out);
        await sendAlertEmail('Lumiere Luxe: escalation action failed', `Booking ${b.id} (${out.name || '?'}): ${err.message}\nTime (UTC): ${now.toISOString()}`);
      }
    }

    const acted = results.filter((r) => r.done);
    console.log('[escalate] summary ' + JSON.stringify({
      dry, businessHours: inBusinessHours, total: bookings.length,
      candidates: results.filter((r) => r.track).length,
      cancelled: acted.filter((r) => r.action === 'cancel').length,
      reminders: acted.filter((r) => ['r24', 'r36', 'sn1', 'sn2'].includes(r.action)).length,
      michelleNotified: results.filter((r) => r.action === 'sn_notify' || r.action === 'cancel' || r.action === 'name-hold -> michelle').length,
    }));

    return res.status(200).json({ ran: true, dry, businessHours: inBusinessHours, total: bookings.length, results: results.filter((r) => r.track) });
  } catch (err) {
    console.error('[escalate] FATAL ' + (err?.stack || err?.message || err));
    await sendAlertEmail('Lumiere Luxe: escalation sweep CRASHED', `${err?.message || err}\n\n${err?.stack || ''}\nTime (UTC): ${now.toISOString()}`);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
