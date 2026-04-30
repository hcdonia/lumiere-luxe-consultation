import { randomUUID } from 'crypto';

const SQUARE_BASE_URL = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

const CONSULTATION_ATTR_KEY = 'square:9084740e-1f93-4c87-8937-cce6569f2faa';

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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { clientInfo, consultationSummary, recommendedService, submissionID } = req.body;

    if (!clientInfo) {
      return res.status(400).json({ error: 'Missing client info' });
    }

    const { givenName, familyName, email, phone } = clientInfo;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone is required' });
    }

    // Build consultation summary entry
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const entry = `--- Hair Consultation (${date}) ---\nRecommended: ${recommendedService || 'N/A'}\n${consultationSummary || ''}`;

    // Search for existing customer by email
    let existingCustomerId = null;

    if (email) {
      const searchData = await squareRequest('POST', '/v2/customers/search', {
        query: {
          filter: {
            email_address: {
              exact: email,
            },
          },
        },
      });

      if (searchData.customers && searchData.customers.length > 0) {
        existingCustomerId = searchData.customers[0].id;
      }
    }

    const encodedKey = encodeURIComponent(CONSULTATION_ATTR_KEY);

    if (existingCustomerId) {
      // Fetch existing custom attribute to prepend new entry
      let existingValue = '';
      try {
        const attrData = await squareRequest('GET', `/v2/customers/${existingCustomerId}/custom-attributes/${encodedKey}`);
        existingValue = attrData.custom_attribute?.value || '';
      } catch {
        // Attribute not set yet — fine, start fresh
      }

      const updatedValue = existingValue ? `${entry}\n\n${existingValue}` : entry;

      await squareRequest('POST', `/v2/customers/${existingCustomerId}/custom-attributes/${encodedKey}`, {
        custom_attribute: { value: updatedValue },
      });

      return res.status(200).json({ status: 'updated', customerId: existingCustomerId });
    } else {
      // Create new customer
      const createData = await squareRequest('POST', '/v2/customers', {
        idempotency_key: randomUUID(),
        given_name: givenName || undefined,
        family_name: familyName || undefined,
        email_address: email || undefined,
        phone_number: phone || undefined,
        reference_id: submissionID || undefined,
      });

      const customerId = createData.customer.id;

      await squareRequest('POST', `/v2/customers/${customerId}/custom-attributes/${encodedKey}`, {
        custom_attribute: { value: entry },
      });

      return res.status(201).json({ status: 'created', customerId });
    }
  } catch (err) {
    console.error('Square customer error:', err.message);
    return res.status(500).json({ error: 'Failed to create/update customer', detail: err.message });
  }
}
