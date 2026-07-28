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

  // Hidden alreadybooked field: set (via link prefill) when we texted this guest
  // the form BECAUSE they already booked on Square. Those guests skip the AI
  // recommender and get a simple "you're all set" page — no booking push. Jotform
  // leaves the literal "{alreadybooked}" placeholder when the field is empty, so
  // treat that (and empty) as not set.
  const rawAlready = req.query.alreadybooked || req.body?.alreadybooked || '';
  const alreadyBooked = !!rawAlready && !/^\{.*\}$/.test(String(rawAlready));

  if (alreadyBooked) {
    return res.redirect(302, '/?allset=1');
  }

  if (submissionID) {
    const params = new URLSearchParams({ submissionID });
    if (gclid) params.set('gclid', gclid);
    res.redirect(302, `/?${params.toString()}`);
  } else {
    res.redirect(302, '/');
  }
}
