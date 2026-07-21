// Single source of truth for tagging people into Michelle's Kit account. This is
// the app-side replacement for the Zapier zaps that used to "add subscriber +
// apply tag" whenever a new guest booked or filled out a form.
//
// IMPORTANT (see this project's CLAUDE.md): these tag IDs and the API key belong
// to MICHELLE's own Kit account ("Lumiere Luxe Salon"), never Hunter's. The key
// lives only in this project's Vercel env.
//
// Uses the Kit v4 API (https://api.kit.com/v4, header X-Kit-Api-Key). Michelle's
// key is a v4 key (kit_...). Unlike v3, v4's tag endpoint requires the subscriber
// to already exist, so tagging is a two-step upsert-then-tag. Both steps are
// idempotent, so re-tagging is a safe no-op.
//
// Used by:
//   - api/square-webhook.mjs      -> tag "New Client" when a new guest books
//   - api/jotform-kit-webhook.mjs -> tag the Halo forms on submission
//   - api/sync-kit-tags.mjs       -> daily reconcile (self-heals a missed webhook)

// Vercel occasionally stores a BOM / literal "\n" / trailing space on env vars.
const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();

// ===========================================================================
// Michelle's Kit tag IDs (verified live in her account — stable, so hardcoded
// here the same way the app hardcodes Square team-member IDs and Jotform form
// IDs). These are exactly the tag IDs the Zapier zaps applied.
// ===========================================================================
export const KIT_TAG_NEW_CLIENT = '3580905';      // "New Client"
export const KIT_TAG_HALO_INTERESTED = '5640850'; // "Halo Couture- Interested"
export const KIT_TAG_HALO_AGREEMENT = '5640848';  // "Halo Couture- Signed Agreement"

// v4 API key (kit_...), used as the X-Kit-Api-Key header. Until it's set the
// helper is a graceful no-op, so this ships/deploys safely before the key exists.
const KIT_API_KEY = clean(process.env.KIT_API_KEY);
const KIT_BASE_URL = 'https://api.kit.com/v4';

export const KIT_READY = Boolean(KIT_API_KEY);

async function kitPost(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${KIT_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': KIT_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

// Add a subscriber (creating/updating them first) to a tag, optionally setting
// the first name and custom fields. This is the v4 equivalent of the ConvertKit
// "tagCreate" action the zaps used.
//
// NEVER throws: returns { ok:false, ... } on any problem so a Kit hiccup can't
// break the welcome packet / Slack / conversion work that runs alongside it.
//
// `fields` are Kit custom fields (e.g. { last_name: 'Doe' }). Michelle's account
// already has the fields her zaps used (last_name, care-note fields, etc.).
export async function tagSubscriber(tagId, { email, firstName, lastName, fields } = {}) {
  if (!KIT_API_KEY) return { ok: false, skipped: 'no-kit-key' };
  if (!tagId) return { ok: false, skipped: 'no-tag-id' };

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail) return { ok: false, skipped: 'no-email' }; // Kit requires an email

  // last_name isn't a native Kit field; the zaps passed it as a custom field.
  const customFields = { ...(fields || {}) };
  const ln = (lastName || '').trim();
  if (ln && customFields.last_name == null) customFields.last_name = ln;

  // Step 1: upsert the subscriber (v4's tag endpoint needs them to exist first).
  // POST /v4/subscribers creates OR updates by email_address (returns 200/201).
  const subBody = { email_address: cleanEmail };
  const fn = (firstName || '').trim();
  if (fn) subBody.first_name = fn;
  if (Object.keys(customFields).length > 0) subBody.fields = customFields;

  const up = await kitPost('/subscribers', subBody);
  if (!up.ok) {
    console.error(`[kit] upsert subscriber ${up.status}: ${JSON.stringify(up.data)}`);
    return { ok: false, step: 'upsert', status: up.status, error: up.data };
  }

  // Step 2: apply the tag.
  const tg = await kitPost(`/tags/${tagId}/subscribers`, { email_address: cleanEmail });
  if (!tg.ok) {
    console.error(`[kit] tag ${tagId} ${tg.status}: ${JSON.stringify(tg.data)}`);
    return { ok: false, step: 'tag', status: tg.status, error: tg.data };
  }

  return { ok: true, status: tg.status, subscriber: up.data?.subscriber };
}
