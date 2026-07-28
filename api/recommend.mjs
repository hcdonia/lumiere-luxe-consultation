// Thin HTTP wrapper for the results page. All real logic lives in
// lib/recommendation.mjs (shared with the form-submitted webhook).
import {
  fetchSubmission,
  wantsExtensions,
  wantsHaircutOnly,
  buildHaircutRecommendation,
  generateRecommendation,
  extractClientInfo,
} from '../lib/recommendation.mjs';

// Re-exported because scripts/tools import extractClientInfo from here historically.
export { extractClientInfo };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { submissionID } = req.body;

    if (!submissionID) {
      return res.status(400).json({ error: 'Missing submissionID' });
    }

    // Fetch submission from JotForm
    const submission = await fetchSubmission(submissionID);

    // Extensions short-circuit: skip AI entirely and route to the dedicated booking flow.
    if (wantsExtensions(submission)) {
      return res.status(200).json({
        flow: 'extensions',
        clientInfo: extractClientInfo(submission),
      });
    }

    // Haircut-only short-circuit: skip AI and return the haircut booking widget directly.
    if (wantsHaircutOnly(submission)) {
      return res.status(200).json(buildHaircutRecommendation(submission));
    }

    const recommendation = await generateRecommendation(submission);
    return res.status(200).json(recommendation);
  } catch (err) {
    console.error('Recommend error:', err.message);
    return res.status(500).json({ error: 'Failed to generate recommendation' });
  }
}
