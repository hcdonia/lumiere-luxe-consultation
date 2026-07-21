// Single source of truth for tagging people into Michelle's Kit (ConvertKit)
// account. This is the app-side replacement for the Zapier zaps that used to
// "add subscriber + apply tag" whenever a new guest booked or filled out a form.
//
// IMPORTANT (see this project's CLAUDE.md): these tag IDs and the API key belong
// to MICHELLE's own Kit account, never Hunter's. The key lives only in this
// project's Vercel env.
//
// Used by:
//   - api/square-webhook.mjs     -> tag "New Client" when a new guest books
//   - api/jotform-kit-webhook.mjs -> tag the Halo forms on submission
//   - api/sync-kit-tags.mjs       -> daily reconcile (self-heals a missed webhook)

// Vercel occasionally stores a BOM / literal "\n" / trailing space on env vars.
const clean = (v) => (v || '').replace(/﻿/g, '').replace(/\\n/g, '').trim();

// ===========================================================================
// Michelle's Kit tag IDs (from her account — stable, so hardcoded here the same
// way the app hardcodes Square team-member IDs and Jotform form IDs). These are
// exactly the tag IDs the Zapier zaps applied.
// ===========================================================================
export const KIT_TAG_NEW_CLIENT = '3580905';      // "New Client"
export const KIT_TAG_HALO_INTERESTED = '5640850'; // "Halo Couture- Interested"
export const KIT_TAG_HALO_AGREEMENT = '5640848';  // "Halo Couture- Signed Agreement"

// ===========================================================================
// Auth. Kit's v3 tag-subscribe endpoint authenticates with api_secret (the
// public api_key also works). Michelle can hand over either one — set whichever
// she gives us and we send it under the right param name:
//   KIT_API_SECRET  (preferred — works for every v3 endpoint)
//   KIT_API_KEY     (public key — also fine for tag-subscribe)
// Until one of these is set the helper is a graceful no-op, so this ships and
// deploys safely BEFORE the key exists ("build now, key later").
// ===========================================================================
const KIT_API_SECRET = clean(process.env.KIT_API_SECRET);
const KIT_API_KEY = clean(process.env.KIT_API_KEY);
const KIT_BASE_URL = 'https://api.convertkit.com/v3';

export const KIT_READY = Boolean(KIT_API_SECRET || KIT_API_KEY);

function authField() {
  // api_secret takes precedence (broader scope); fall back to the public key.
  if (KIT_API_SECRET) return { api_secret: KIT_API_SECRET };
  if (KIT_API_KEY) return { api_key: KIT_API_KEY };
  return null;
}

// Add a subscriber (creating them if needed) to a tag, optionally setting the
// first name and custom fields. This is the exact analog of the ConvertKit
// "tagCreate" action the zaps used: POST /v3/tags/{tag_id}/subscribe.
//
// Naturally IDEMPOTENT — re-applying a tag the subscriber already has is a safe
// no-op, which is why the reconcile cron can re-run freely.
//
// NEVER throws: returns { ok:false, ... } on any problem so a Kit hiccup can't
// break the welcome packet / Slack / conversion work that runs alongside it.
//
// `fields` are Kit custom fields (e.g. { last_name: 'Doe' }). Per Kit, a custom
// field must already exist on the account or it's ignored/rejected — Michelle's
// account already has the ones her zaps used (e.g. last_name).
export async function tagSubscriber(tagId, { email, firstName, lastName, fields } = {}) {
  const auth = authField();
  if (!auth) return { ok: false, skipped: 'no-kit-key' };
  if (!tagId) return { ok: false, skipped: 'no-tag-id' };

  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail) return { ok: false, skipped: 'no-email' }; // Kit requires an email

  const customFields = { ...(fields || {}) };
  // last_name isn't a native Kit field; the zaps passed it as a custom field.
  const ln = (lastName || '').trim();
  if (ln && customFields.last_name == null) customFields.last_name = ln;

  const body = { ...auth, email: cleanEmail };
  const fn = (firstName || '').trim();
  if (fn) body.first_name = fn;
  if (Object.keys(customFields).length > 0) body.fields = customFields;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${KIT_BASE_URL}/tags/${tagId}/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[kit] tag ${tagId} subscribe ${res.status}: ${JSON.stringify(data)}`);
      return { ok: false, status: res.status, error: data };
    }
    return { ok: true, status: res.status, subscription: data.subscription || data };
  } catch (err) {
    console.error(`[kit] tag ${tagId} subscribe threw: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
