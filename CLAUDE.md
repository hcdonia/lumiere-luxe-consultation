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
