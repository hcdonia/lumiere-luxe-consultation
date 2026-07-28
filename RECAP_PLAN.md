# New-guest form: recap message + already-booked fix (2026-07-28)

Michelle's report: clients fill out the new guest form but "don't get the online booking
email or text." Root cause: nothing was ever sent at form-submit time — the AI
recommendation + booking widget existed ONLY on the redirect page. Close the tab, lose it.
Also: people who already booked on Square still got funneled to the recommender.

## The fixes (all in this repo + Jotform form 251448462902155)

1. **Recap text/email after every form submission** — new Jotform webhook →
   `api/form-submitted.mjs`:
   - Re-fetches the submission (never trusts the webhook body), token-gated
     (`?token=JOTFORM_WEBHOOK_SECRET`, same pattern as jotform-kit-webhook).
   - Standard/color flow: runs the AI recommendation server-side, texts the guest their
     recommended service + a link back to their personal results page
     (`https://lumiere-luxe-consultation.vercel.app/?submissionID=...`), saves the
     consultation prep notes to Square. Email via Resend when no phone.
   - Extensions flow: no AI; texts the link to finish booking ($35 deposit page).
   - Already-booked (see #2): "you're all set" text, no booking push; prep notes still saved.
   - Slacks Michelle on every submission (she ran out of Jotform notification emails).
   - Dedupe/edit-refire guard: hidden `recapsent` field on the form, set via the Jotform
     submission-edit API BEFORE sending (claim-then-send; failures alert Hunter by email).
2. **Already-booked guests skip the recommender** — hidden `alreadybooked` field on the
   form; the form links we text to people who ALREADY booked (square-webhook nudge +
   escalate r24/r36/sn1/sn2) now carry `?alreadybooked=1` (prefill). The cancel text keeps
   the plain link (they no longer have a booking). Redirect passes
   `&alreadybooked={alreadybooked}` through; `api/intake.mjs` sends those guests to a new
   static "You're all set" state instead of the AI recommender.
3. **Consultation-note dedupe** — notes now tagged with the submissionID; both write paths
   (webhook + results page) skip if that submission's entry already exists. Also fixes the
   old page-refresh-duplicates-notes bug.

## Refactors
- `lib/recommendation.mjs`: core AI/recommendation logic extracted from `api/recommend.mjs`
  (which is now a thin HTTP wrapper). Both the page and the webhook use it.
- `lib/consultation-note.mjs`: Square customer upsert + note write extracted from
  `api/create-customer.mjs` (now a thin wrapper).

## Go-live steps
- [x] Code (all files above)
- [x] Add hidden fields `alreadybooked` + `recapsent` to the Jotform via API
- [x] Append `&alreadybooked={alreadybooked}` to the form's thank-you redirect URL
- [x] Commit + push (Vercel auto-deploys)
- [x] Register the webhook on the form via API
- [x] Dry-run verify against a real past submission (`?token=...&dry=1`)

## Status: LIVE 2026-07-28. First real submission is the end-to-end proof; watch for
## Michelle's Slack DM + the guest text.
