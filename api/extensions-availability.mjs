// Searches Square for available CM Extensions Consultation slots with J Ladner.
const SQUARE_BASE_URL = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

const LOCATION_ID = 'LWJX3SDVSAD04';
const SERVICE_VARIATION_ID = 'F6SW42MPSJBYS3ORE6GOGJWG'; // CM Extensions Consultation
const TEAM_MEMBER_ID = 'TMxBIVi-i-sW0xmq'; // J Ladner
const SEARCH_WINDOW_DAYS = 14;

async function squareRequest(method, path, body) {
  const env = process.env.SQUARE_ENVIRONMENT || 'sandbox';
  const baseUrl = SQUARE_BASE_URL[env] || SQUARE_BASE_URL.sandbox;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.errors?.[0]?.detail || `Square API error: ${res.status}`);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Default start: ~2 hours from now (Square requires future times)
    const now = new Date();
    const defaultStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    let startAt = defaultStart;
    if (req.query.startDate) {
      const parsed = new Date(req.query.startDate);
      if (!isNaN(parsed.getTime()) && parsed > defaultStart) {
        startAt = parsed;
      }
    }

    const endAt = new Date(startAt.getTime() + SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const data = await squareRequest('POST', '/v2/bookings/availability/search', {
      query: {
        filter: {
          location_id: LOCATION_ID,
          start_at_range: {
            start_at: startAt.toISOString(),
            end_at: endAt.toISOString(),
          },
          segment_filters: [
            {
              service_variation_id: SERVICE_VARIATION_ID,
              team_member_id_filter: { any: [TEAM_MEMBER_ID] },
            },
          ],
        },
      },
    });

    const slots = (data.availabilities || []).map((a) => ({
      startAt: a.start_at,
      durationMinutes: Math.round((a.appointment_segments?.[0]?.duration_minutes) || 15),
    }));

    return res.status(200).json({ slots });
  } catch (err) {
    console.error('Extensions availability error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch availability', detail: err.message });
  }
}
