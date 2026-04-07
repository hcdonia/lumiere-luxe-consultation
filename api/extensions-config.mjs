// Returns the public Square Web Payments SDK config for the extensions booking page.
// Application ID is safe to expose to the browser; access token is NOT.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const applicationId = (process.env.SQUARE_APP_ID || '').trim();
  const locationId = 'LWJX3SDVSAD04';
  const environment = process.env.SQUARE_ENVIRONMENT || 'sandbox';

  if (!applicationId) {
    return res.status(500).json({ error: 'Missing SQUARE_APP_ID' });
  }

  return res.status(200).json({ applicationId, locationId, environment });
}
