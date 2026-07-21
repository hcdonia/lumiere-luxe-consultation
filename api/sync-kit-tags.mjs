// Daily safety-net reconcile for the Kit Halo tags. Mirrors the app's existing
// "webhook + daily reconcile" pattern (square-webhook + sync-square-conversions):
// if a Jotform webhook is ever missed or removed, this re-applies the correct tag
// to any submission from the last couple of days. Tagging is idempotent, so
// re-running is always safe.
//
// Cron: see vercel.json. Auth: Bearer CRON_SECRET (same as the other crons).

import { extractContact } from '../lib/jotform-contact.mjs';
import {
  tagSubscriber,
  KIT_READY,
  KIT_TAG_HALO_INTERESTED,
  KIT_TAG_HALO_AGREEMENT,
} from '../lib/kit.mjs';

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const CRON_SECRET = clean(process.env.CRON_SECRET);

// Same two forms the webhook handles.
const FORMS = [
  { id: '243147261286053', tag: KIT_TAG_HALO_INTERESTED, label: 'Halo Interest' },
  { id: '250136134986055', tag: KIT_TAG_HALO_AGREEMENT, label: 'Halo Agreement' },
];

const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000; // reconcile the last 2 days

// Jotform created_at is "YYYY-MM-DD HH:MM:SS" in UTC. Parse as UTC.
function createdMs(sub) {
  const raw = (sub.created_at || '').trim();
  if (!raw) return NaN;
  return new Date(raw.replace(' ', 'T') + 'Z').getTime();
}

async function recentSubmissions(formId) {
  // These forms are low-volume, so limit=100 returns everything; we filter by
  // date in code (order doesn't matter).
  const res = await fetch(
    `https://api.jotform.com/form/${formId}/submissions?apiKey=${JOTFORM_KEY}&limit=100`
  );
  if (!res.ok) throw new Error(`Jotform HTTP ${res.status}`);
  const data = await res.json();
  // Jotform can return HTTP 200 with responseCode 401 (bad/expired key) and null
  // content — fail loud so it lands in the per-form error summary instead of
  // silently reconciling nothing.
  if (data.responseCode !== 200) throw new Error(`Jotform responseCode ${data.responseCode}`);
  return data.content || [];
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!KIT_READY) {
    return res.status(200).json({ ok: true, skipped: 'KIT key not set yet' });
  }
  if (!JOTFORM_KEY) {
    return res.status(200).json({ ok: true, skipped: 'JOTFORM_API_KEY not set' });
  }

  const cutoff = Date.now() - LOOKBACK_MS;
  const summary = [];

  for (const form of FORMS) {
    let considered = 0, tagged = 0, skipped = 0, failed = 0;
    try {
      const subs = await recentSubmissions(form.id);
      for (const sub of subs) {
        const created = createdMs(sub);
        // Skip clearly-old submissions; a malformed/NaN date falls through and
        // gets (idempotently) re-tagged, which is harmless on these tiny forms.
        if (!Number.isNaN(created) && created < cutoff) continue;
        considered++;
        const contact = extractContact(sub);
        if (!contact.email) { skipped++; continue; }
        const r = await tagSubscriber(form.tag, {
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
        });
        if (r.ok) tagged++; else failed++;
      }
      summary.push({ form: form.label, considered, tagged, skipped, failed });
    } catch (err) {
      console.error(`[sync-kit] ${form.label} failed: ${err.message}`);
      summary.push({ form: form.label, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, summary });
}
