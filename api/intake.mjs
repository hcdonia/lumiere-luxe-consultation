// Catches JotForm's POST redirect and sends the user to the static page with the submission ID
export default async function handler(req, res) {
  // Get submission ID from query params or POST body
  const submissionID =
    req.query.submissionID ||
    req.body?.submissionID ||
    req.body?.submissionId ||
    req.body?.submission_id;

  // Google Ads click id, passed through from lumiereluxesalon.com via the JotForm redirect.
  const gclid = req.query.gclid || req.body?.gclid || '';

  if (submissionID) {
    const params = new URLSearchParams({ submissionID });
    if (gclid) params.set('gclid', gclid);
    res.redirect(302, `/?${params.toString()}`);
  } else {
    res.redirect(302, '/');
  }
}
