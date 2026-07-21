# Michelle (Lumiere Luxe) — CLIENT PROJECT (read this first)

**This is a client project. Michelle is Hunter's customer.** Hunter builds and maintains this app
*for* Michelle at Lumiere Luxe; the accounts, data, and credentials here belong to **Michelle, not
Hunter**.

## ⚠️ Never use Hunter's personal accounts or claude.ai connectors for this project
The claude.ai connectors (Gmail, Google Ads, Google Drive, Calendar, Kit/ConvertKit, Slack, Stripe,
Wix, Supabase, etc.) and any of Hunter's own logins are authenticated to **Hunter's** accounts —
**not** Michelle's. Using them here reads or writes the **wrong account**, so the result is
**incorrect** (wrong ad account, wrong analytics, wrong inbox, wrong data) even when it looks like
it worked.

- **Do NOT** use a claude.ai connector to touch Michelle's data — it's Hunter's account, not hers.
- **Do** use Michelle's OWN credentials, which live in THIS project — its `.env` / Vercel project
  env vars, its API keys, its Google Ads / analytics / site accounts. Go through the project's own
  code and keys.
- Need her live data (ad performance, conversions, leads, bookings, inbox…)? Pull it via **this
  project's** stored keys or her own accounts — never via Hunter's connectors.
- If the only path to something runs through one of Hunter's personal accounts/connectors,
  **STOP and ask Hunter** — don't guess and don't substitute his account.

A wrong-account action is worse than no action.

## Kit (ConvertKit) tagging — migrated from Zapier (2026-07-20)

Michelle's active Zapier zaps that "add subscriber + apply a Kit tag" now run inside this app
(`lib/kit.mjs`). Everything uses **Michelle's own Kit account** ("Lumiere Luxe Salon",
m@michellesandershair.com) — never Hunter's Kit connector (different account; the tag IDs don't even
match). Uses the **Kit v4 API** (`api.kit.com/v4`, `X-Kit-Api-Key` header). v4's tag endpoint
requires the subscriber to exist first, so `tagSubscriber()` is a two-step upsert-then-tag
(`POST /v4/subscribers`, then `POST /v4/tags/{id}/subscribers`); both steps idempotent (re-tagging
is a safe no-op).

- **Auth env:** `KIT_API_KEY` — Michelle's v4 key (`kit_...`). Until it's set, all Kit calls are a
  graceful no-op, so the code ships/deploys safely before the key exists.
- **Tag IDs** (hardcoded in `lib/kit.mjs`, from Michelle's account): New Client `3580905`,
  Halo Couture- Interested `5640850`, Halo Couture- Signed Agreement `5640848`.
- **Triggers:**
  - *New Client* → `api/square-webhook.mjs`, on the Square **`customer.created`** event (any new
    customer, no filter — matches the old zap exactly). Michelle wants every new customer in her Kit
    list immediately to nurture/convert non-booked leads. Fires for online bookers, walk-ins/manual
    adds, AND app-created profiles (consultation form → `create-customer.mjs`; $35 deposit →
    `extensions-book.mjs`); returning guests are an update, not a create, so they never re-fire. The
    Square webhook subscription (`wbhk_e3a6670b38c04fd49a1cc881bdbfffe8`) is subscribed to
    `booking.created`, `booking.updated`, `customer.created`. Replaces both the old Square-new-customer
    zap and the stale New-Guest-Intake-form zap (`212805390003141`, quiet since Apr 2026).
  - *Halo Interested / Signed Agreement* → `api/jotform-kit-webhook.mjs`, a Jotform webhook receiver
    for forms `243147261286053` and `250136134986055`. Gated by `?token=<JOTFORM_WEBHOOK_SECRET>`
    (Jotform can't sign webhooks). Re-fetches the submission from the Jotform API, then tags.
  - Safety net: `api/sync-kit-tags.mjs` (daily cron) re-applies the Halo tags for the last 2 days of
    submissions, so a missed/removed webhook self-heals.
- **NOT migrated:** the DCF consultation zap (its form `230655589965171` has had no submission since
  July 2023 — dead). If it's ever revived, repoint it in `lib/kit.mjs` + a form mapping.
- **Contact parsing:** `lib/jotform-contact.mjs` (`extractContact`) — a dependency-free twin of
  `extractClientInfo` in `recommend.mjs` (that one drags in sharp/heic/Anthropic at import, too heavy
  for the webhook/cron).
- **Go-live steps:** (1) set `KIT_API_KEY` + `JOTFORM_WEBHOOK_SECRET` in Vercel;
  (2) register the two Jotform webhooks via the Jotform API pointing at
  `/api/jotform-kit-webhook?token=…`; (3) turn OFF the 3 migrated zaps in Zapier once verified.
- **Test:** `node --env-file=.env.local scripts/probe-kit.mjs <email> <new-client|halo-interested|halo-agreement>`.
