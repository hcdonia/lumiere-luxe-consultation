// Catches JotForm's POST redirect and sends the user to the static page with the submission ID
export default async function handler(req, res) {
  // Get submission ID from query params or POST body
  const submissionID =
    req.query.submissionID ||
    req.body?.submissionID ||
    req.body?.submissionId ||
    req.body?.submission_id;

  if (submissionID) {
    res.redirect(302, `/?submissionID=${submissionID}`);
  } else {
    res.redirect(302, '/');
  }
}
