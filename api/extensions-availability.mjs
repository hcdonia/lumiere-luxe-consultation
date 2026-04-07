// Searches Square for available CM Extensions Consultation slots with J Ladner.
// Square's SearchAvailability caps at 32 days per call, so we make 2 sequential
// calls to span ~60 days and merge the results.
const SQUARE_BASE_URL = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

const LOCATION_ID = 'LWJX3SDVSAD04';
const SERVICE_VARIATION_ID = 'F6SW42MPSJBYS3ORE6GOGJWG'; // CM Extensions Consultation
const TEAM_MEMBER_ID = 'TMxBIVi-i-sW0xmq'; // J Ladner
const CHUNK_DAYS = 31; // Square max per call
const TOTAL_WINDOW_DAYS = 62; // ~2 months

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

async function fetchChunk(startAt, endAt) {
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
  return data.availabilities || [];
}

// Format an ISO instant as a YYYY-MM-DD string in America/Los_Angeles (the salon's timezone)
function toLocalDateKey(isoString) {
  const d = new Date(isoString);
  // en-CA gives ISO-style YYYY-MM-DD
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Default start: ~2 hours from now (Square requires future times)
    const now = new Date();
    const startAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const finalEnd = new Date(startAt.getTime() + TOTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Build chunks of <= 31 days
    const chunks = [];
    let cursor = startAt;
    while (cursor < finalEnd) {
      const chunkEnd = new Date(Math.min(
        cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000,
        finalEnd.getTime()
      ));
      chunks.push([new Date(cursor), chunkEnd]);
      cursor = chunkEnd;
    }

    // Fetch all chunks in parallel
    const results = await Promise.all(chunks.map(([s, e]) => fetchChunk(s, e)));
    const availabilities = results.flat();

    // Group by local date (LA timezone)
    const slotsByDate = {};
    for (const a of availabilities) {
      const key = toLocalDateKey(a.start_at);
      if (!slotsByDate[key]) slotsByDate[key] = [];
      slotsByDate[key].push({
        startAt: a.start_at,
        durationMinutes: Math.round((a.appointment_segments?.[0]?.duration_minutes) || 15),
      });
    }

    return res.status(200).json({
      slotsByDate,
      windowStart: toLocalDateKey(startAt.toISOString()),
      windowEnd: toLocalDateKey(finalEnd.toISOString()),
    });
  } catch (err) {
    console.error('Extensions availability error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch availability', detail: err.message });
  }
}
