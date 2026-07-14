// Daily reconciliation: the safety net behind the real-time webhook conversion send.
// Sweeps recent Square bookings and (re)posts every qualifying one to the conversion
// Sheet, so a booking can never be silently lost if the webhook's real-time send
// fails (cold-start timeout, transient error, missed event). Idempotent — the Apps
// Script dedups by Order ID, so re-posting an already-synced booking is a no-op.
//
// Mirrors the EXACT gate in api/square-webhook.mjs: a booking qualifies when it was
// created since the pipeline went live, has an active status (PENDING/ACCEPTED), is a
// NEW customer (created within 30 min of the booking), and has an email or phone to
// match on. Runs daily (see vercel.json) shortly before the daily Data Manager import.
//
// Auth: CRON_SECRET (Vercel injects it). Manual/dry run: GET ?dry=1 with the Bearer.

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const LOCATION_ID = 'LWJX3SDVSAD04';
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;
const ACTIVE = new Set(['PENDING', 'ACCEPTED']);

// Never post bookings created before the pipeline existed, and only look back a bounded
// window (the webhook handles real-time; this just catches recent misses).
const CONVERSION_GO_LIVE = new Date('2026-07-08T00:00:00Z');
const LOOKBACK_DAYS = 14;

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/[\r\n]/g, '').trim();
const SHEETS_WEBHOOK_URL = clean(process.env.GOOGLE_SHEETS_WEBHOOK_URL);
const SHEETS_WEBHOOK_SECRET = clean(process.env.GOOGLE_SHEETS_WEBHOOK_SECRET);
const SQUARE_ACCESS_TOKEN = clean(process.env.SQUARE_ACCESS_TOKEN);

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2025-03-19' },
  });
  return res.json();
}

// --- hashing: identical normalization to api/square-webhook.mjs ---
import { createHash } from 'crypto';
const sha256Hex = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const hashEmail = (email) => { const e = (email || '').trim().toLowerCase(); return e ? sha256Hex(e) : ''; };
function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (String(raw).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}
const hashPhone = (phone) => { const e164 = toE164(phone); return e164 ? sha256Hex(e164) : ''; };

// POST one booking to the conversion Sheet. Two attempts, generous timeout (no
// guest-facing latency pressure in a cron). Idempotent via Order-ID dedup upstream.
async function postConversion(customer, booking) {
  const payload = {
    secret: SHEETS_WEBHOOK_SECRET,
    conversionName: 'Square Booking',
    conversionTime: booking.created_at || new Date().toISOString(),
    email: hashEmail(customer.email_address),
    phone: hashPhone(customer.phone_number),
    gclid: '', value: '', currency: '',
    orderId: booking.id || '',
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(SHEETS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, body };
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.name === 'AbortError' ? 'timeout(15s)' : (err?.message || String(err));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastErr };
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SHEETS_WEBHOOK_URL || !SHEETS_WEBHOOK_SECRET) {
    return res.status(200).json({ ran: false, skipped: 'sheets webhook not configured' });
  }

  const dry = req.query?.dry === '1';
  const now = Date.now();
  // Only consider bookings created within the lookback window AND on/after go-live.
  const floor = new Date(Math.max(CONVERSION_GO_LIVE.getTime(), now - LOOKBACK_DAYS * 864e5));

  try {
    // Bookings are queried by appointment start_at (Square caps each query at 31 days).
    // Sweep from just before the lookback floor out to +90d so we catch every recently
    // created booking regardless of how far out its appointment sits.
    const byId = new Map();
    for (let offset = -(LOOKBACK_DAYS + 2); offset < 90; offset += 30) {
      const min = new Date(now + offset * 864e5).toISOString();
      const max = new Date(now + Math.min(offset + 30, 90) * 864e5).toISOString();
      const bk = await squareGet(`/v2/bookings?location_id=${LOCATION_ID}&start_at_min=${min}&start_at_max=${max}&limit=200`);
      if (bk.errors?.length) {
        console.error('[sync-conversions] Square error:', JSON.stringify(bk.errors));
        return res.status(502).json({ error: 'square list bookings failed', detail: bk.errors });
      }
      for (const b of (bk.bookings || [])) byId.set(b.id, b);
    }

    const posted = [], skipped = [], failed = [];
    for (const b of byId.values()) {
      if (!b.created_at || new Date(b.created_at) < floor) continue;
      if (!ACTIVE.has(b.status)) continue;
      if (!b.customer_id) continue;
      const customer = (await squareGet(`/v2/customers/${b.customer_id}`)).customer;
      if (!customer) continue;
      const isNew = customer.created_at
        ? Math.abs(new Date(b.created_at) - new Date(customer.created_at)) / 6e4 <= NEW_CUSTOMER_THRESHOLD_MINUTES
        : false;
      if (!isNew) continue;
      if (!customer.email_address && !customer.phone_number) continue;

      const label = `${customer.given_name || ''} ${customer.family_name || ''}`.trim() || b.id;
      if (dry) { skipped.push({ label, orderId: b.id, reason: 'dry-run' }); continue; }

      const r = await postConversion(customer, b);
      if (r.ok) {
        // {ok:true} = appended; {ok:true, skipped:'duplicate order id'} = already there.
        (r.body?.skipped ? skipped : posted).push({ label, orderId: b.id, result: r.body });
      } else {
        console.error(`[sync-conversions] post failed for ${b.id}: ${r.error}`);
        failed.push({ label, orderId: b.id, error: r.error });
      }
    }

    return res.status(200).json({
      ran: true, dry, floor: floor.toISOString(),
      candidates: byId.size, posted: posted.length, alreadyThere: skipped.length, failed: failed.length,
      details: { posted, skipped, failed },
    });
  } catch (err) {
    console.error('[sync-conversions] FATAL ' + (err?.stack || err?.message || err));
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
