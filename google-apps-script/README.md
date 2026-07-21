# Mastermind → Michelle's calendar sync (Google Apps Script)

Auto-copies Hunter's **Mastermind** Google Calendar into Michelle's **primary**
calendar as events she **owns**, so they block her availability in **Square
Appointments** (and she can mark any Busy/Free). Runs hourly inside her Google account.

Why copies onto her primary, specifically (all confirmed the hard way):
- Square only blocks events you **own** — events she's merely *invited* to (the
  Mastermind calls) do **not** block, even when accepted.
- Square syncs only **one** calendar, and hers is her **primary** — so a separate
  calendar would be ignored.
- A *subscription* is read-only (no Busy/Free) and Square won't sync it.

So the fix is to *create* owned copies on her primary. `WRITE_TO_PRIMARY` (default
`true`) controls this; set it false only if you deliberately point Square at
`DEST_CAL_NAME` instead.

Note: the group calls will appear twice on her primary — her accepted invite plus
the owned copy that actually blocks Square. To avoid the visual double, remove her
as a guest from the call invites (the owned copies carry the Hunty Meet link).

## Files
- `mastermind-calendar-sync.gs` — the whole thing (paste into script.google.com).

## Setup (signed in as m@michellesandershair.com)
1. https://script.google.com → **New project** → paste in `mastermind-calendar-sync.gs` → Save.
2. Run **`syncMastermind`** once → approve the Google permission prompt. This
   creates the `Mastermind (Hunter)` calendar and does the first copy.
3. Run **`installHourlyTrigger`** once → it now runs itself every hour.
4. In **Square Appointments** → Google Calendar sync → pick **`Mastermind (Hunter)`**
   (Import). If Square only offers her primary calendar, change `DEST_CAL_NAME`
   handling accordingly (see below).

## Behavior / safety
- Adds new calls, updates moved ones, removes cancelled ones.
- New copies default to **Busy** so Square blocks the time; Michelle can flip any
  one to **Free** and the script never overrides her choice.
- Only touches events it created (tagged `mastermindSrcKey`) — her own events on
  that calendar are left alone.
- **Fails safe:** if the Mastermind calendar can't be read, it changes nothing and
  emails `hunter@hairbyhunty.com`. Same alert on any error.

## Config (top of the .gs)
- `SOURCE_CAL_ID` — Hunter's Mastermind calendar id (verified 2026-07-21).
- `DEST_CAL_NAME` — the owned calendar name Square points at.
- `DAYS_AHEAD` — how far ahead to sync (210 days).
- `ALERT_EMAIL` — where failures are emailed.

This is a standalone script that runs in Michelle's Google account — it is **not**
part of the Vercel app and does not deploy with it.
