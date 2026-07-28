// Thin HTTP wrapper for the results page. All real logic lives in
// lib/consultation-note.mjs (shared with the form-submitted webhook).
import { saveConsultation } from '../lib/consultation-note.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { clientInfo, consultationSummary, recommendedService, submissionID } = req.body;

    if (!clientInfo) {
      return res.status(400).json({ error: 'Missing client info' });
    }

    const result = await saveConsultation({ clientInfo, consultationSummary, recommendedService, submissionID });
    return res.status(result.status === 'created' ? 201 : 200).json(result);
  } catch (err) {
    console.error('Square customer error:', err.message);
    const status = err.message === 'Email or phone is required' ? 400 : 500;
    return res.status(status).json({ error: 'Failed to create/update customer', detail: err.message });
  }
}
