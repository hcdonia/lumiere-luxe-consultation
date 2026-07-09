/**
 * Lumiere Luxe — Square booking → Google Ads conversion sheet
 * -----------------------------------------------------------
 * This is a Google Apps Script bound to the spreadsheet:
 *   "Lumiere Luxe — Square Bookings → Google Ads"
 *   https://docs.google.com/spreadsheets/d/1d5eA6TLMlRqhyCsWlszFmG764lXlyQ_QiQLEeqqB8Co/edit
 *
 * It receives a POST from the Square webhook (api/square-webhook.mjs) and appends
 * one row per new-guest booking. Google Ads Data Manager reads this sheet on a
 * schedule and imports the rows as "Square Booking" conversions, matched by the
 * hashed email/phone (enhanced conversions for leads).
 *
 * SETUP (do this once):
 *   1. Open the spreadsheet above → Extensions → Apps Script.
 *   2. Delete anything there and paste this whole file. Save.
 *   3. Run ▸ setup   (authorize when prompted) — this writes the header row.
 *   4. Deploy ▸ New deployment ▸ Web app:
 *        - Execute as: Me
 *        - Who has access: Anyone
 *      Deploy, copy the Web app URL (ends in /exec), and send it back.
 *
 * The SHARED_SECRET below must match the GOOGLE_SHEETS_WEBHOOK_SECRET env var
 * on the Vercel app, so only our webhook can write here.
 */

const SHARED_SECRET = '62fd5ff376c06c2273975518f13251be8084223b26b509ba';

const HEADERS = [
  'Conversion Name', 'Conversion Time', 'Email', 'Phone',
  'GCLID', 'Conversion Value', 'Conversion Currency', 'Order ID',
];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'unauthorized' });
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    ensureHeaders(sheet);

    // Idempotency: if this Order ID is already present, don't append it twice
    // (Square can resend, and Data Manager re-reads recent rows on every run).
    const orderId = String(body.orderId || '');
    if (orderId && orderIdExists(sheet, orderId)) {
      return json({ ok: true, skipped: 'duplicate order id' });
    }

    sheet.appendRow([
      body.conversionName || 'Square Booking',
      body.conversionTime || '',
      body.email || '',
      body.phone || '',
      body.gclid || '',
      body.value || '',
      body.currency || '',
      orderId,
    ]);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function ensureHeaders(sheet) {
  const first = sheet.getRange(1, 1).getValue();
  if (!first) sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
}

function orderIdExists(sheet, orderId) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const ids = sheet.getRange(2, 8, last - 1, 1).getValues(); // column 8 = Order ID
  return ids.some(function (r) { return String(r[0]) === orderId; });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the editor to make sure the header row exists. */
function setup() {
  ensureHeaders(SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]);
}
