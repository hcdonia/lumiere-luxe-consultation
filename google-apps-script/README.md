# Mastermind → Michelle's calendar sync (Google Apps Script)

Auto-copies Hunter's **Mastermind** Google Calendar into a calendar Michelle
**owns** (`Mastermind (Hunter)`), so she can mark events Busy/Free and sync that
calendar to **Square Appointments**. Runs hourly inside Michelle's Google account.

Why a mirror and not a plain subscription: a *subscribed* calendar is read-only
(can't set Busy/Free), and Square won't reliably sync a calendar that's only
shared to you from another account. The events have to live on a calendar she
owns — this script keeps that owned calendar in sync automatically.

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
