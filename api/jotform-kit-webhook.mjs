// Jotform webhook receiver -> Kit tag. Replaces the two active Zapier zaps that
// fired "on new submission" for Michelle's Halo forms and applied a Kit tag:
//   - Halo Extension Interest Form   -> "Halo Couture- Interested"
//   - Halo Couture Extension Agreement -> "Halo Couture- Signed Agreement"
//
// Register the webhook on each form (Jotform doesn't sign webhooks, so we gate on
// a shared-secret ?token=), pointing at:
//   https://lumiere-luxe-consultation.vercel.app/api/jotform-kit-webhook?token=<JOTFORM_WEBHOOK_SECRET>
//
// We read the raw POST ourselves (Jotform posts multipart/form-data, which
// Vercel's default parser leaves empty), pull out formID + submissionID, then
// RE-FETCH the full submission from the Jotform API (never trust the raw body)
// and apply the mapped tag. Always returns 200 so Jotform never retry-storms.

import { extractContact } from '../lib/jotform-contact.mjs';
import {
  tagSubscriber,
  KIT_TAG_HALO_INTERESTED,
  KIT_TAG_HALO_AGREEMENT,
} from '../lib/kit.mjs';

// Jotform posts multipart/form-data; keep the raw bytes so we can parse it.
export const config = { api: { bodyParser: false } };

const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();
const JOTFORM_KEY = clean(process.env.JOTFORM_API_KEY);
const WEBHOOK_SECRET = clean(process.env.JOTFORM_WEBHOOK_SECRET);

// Jotform form ID -> Kit tag applied on a new submission.
const FORM_TAGS = {
  '243147261286053': KIT_TAG_HALO_INTERESTED, // Halo Extension Interest Form
  '250136134986055': KIT_TAG_HALO_AGREEMENT,  // Halo Couture Extension Agreement
};

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

// Pull one named field out of whatever Jotform sent. Handles multipart/form-data
// (the default), urlencoded, and a JSON test payload.
function getField(raw, contentType, fieldName) {
  if (!raw) return null;
  const ct = (contentType || '').toLowerCase();

  if (ct.includes('application/json') || raw.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      if (j && j[fieldName] != null) return String(j[fieldName]).trim();
    } catch { /* fall through */ }
  }

  // multipart/form-data: value sits between the field header's blank line and
  // the next boundary.
  const re = new RegExp(`name="${fieldName}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`, 'i');
  const m = raw.match(re);
  if (m) return m[1].trim();

  // urlencoded (or a last-ditch attempt on anything key=value&…).
  try {
    const v = new URLSearchParams(raw).get(fieldName);
    if (v != null) return String(v).trim();
  } catch { /* ignore */ }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Shared-secret token. Enforced only when the secret is configured, so the
  // endpoint still works before JOTFORM_WEBHOOK_SECRET is set in Vercel.
  if (WEBHOOK_SECRET) {
    const token = clean(req.query?.token);
    if (token !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'invalid token' });
    }
  }

  try {
    const raw = await readRawBody(req);
    const contentType = req.headers['content-type'] || '';
    const formID = getField(raw, contentType, 'formID');
    const submissionID = getField(raw, contentType, 'submissionID');

    const tagId = formID ? FORM_TAGS[formID] : null;
    if (!tagId) {
      return res.status(200).json({ received: true, skipped: `unmapped form: ${formID || 'none'}` });
    }
    if (!submissionID) {
      return res.status(200).json({ received: true, skipped: 'no submissionID' });
    }
    if (!JOTFORM_KEY) {
      console.error('[kit-webhook] JOTFORM_API_KEY not set');
      return res.status(200).json({ received: true, skipped: 'no jotform key' });
    }

    // Re-fetch the full submission (don't trust the raw webhook body).
    let contact;
    try {
      const jr = await fetch(`https://api.jotform.com/submission/${submissionID}?apiKey=${JOTFORM_KEY}`);
      const jd = await jr.json().catch(() => ({}));
      if (!jr.ok || jd.responseCode !== 200 || !jd.content) {
        console.error(`[kit-webhook] Jotform fetch failed for ${submissionID}: HTTP ${jr.status}`);
        return res.status(200).json({ received: true, skipped: 'jotform fetch failed' });
      }
      contact = extractContact(jd.content);
    } catch (err) {
      console.error(`[kit-webhook] Jotform fetch threw: ${err.message}`);
      return res.status(200).json({ received: true, skipped: 'jotform fetch threw' });
    }

    if (!contact.email) {
      return res.status(200).json({ received: true, skipped: 'no email in submission' });
    }

    const kit = await tagSubscriber(tagId, {
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
    });

    return res.status(200).json({ received: true, formID, tag: tagId, kit });
  } catch (err) {
    // Never make Jotform retry — log and acknowledge.
    console.error('[kit-webhook] processing error:', err.message);
    return res.status(200).json({ received: true });
  }
}
