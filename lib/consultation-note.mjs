// Upserts the Square customer + writes the consultation prep notes to the
// customer's "Hair Consultation" custom attribute. Used by BOTH:
//   - api/create-customer.mjs  -> called from the results page
//   - api/form-submitted.mjs   -> the Jotform webhook (covers guests who never
//                                 open the results page, e.g. already-booked)
//
// Entries are tagged with the submissionID and each write path skips if that
// submission's entry is already on file, so the two paths (or a page refresh)
// can never stack duplicate notes for the same form submission.

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

// Returns { status: 'created'|'updated'|'duplicate', customerId }.
export async function saveConsultation({ clientInfo, consultationSummary, recommendedService, submissionID }) {
  const { givenName, familyName, email, phone } = clientInfo || {};

  if (!email && !phone) {
    throw new Error('Email or phone is required');
  }

  // Build consultation summary entry. The [SUB:...] tag is the dedupe key.
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const subTag = submissionID ? ` [SUB:${submissionID}]` : '';
  const entry = `--- Hair Consultation (${date})${subTag} ---\nRecommended: ${recommendedService || 'N/A'}\n${consultationSummary || ''}`;

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

    // This submission's notes are already on file (other write path, or a page
    // refresh) — don't stack a duplicate entry.
    if (submissionID && existingValue.includes(`[SUB:${submissionID}]`)) {
      return { status: 'duplicate', customerId: existingCustomerId };
    }

    const updatedValue = existingValue ? `${entry}\n\n${existingValue}` : entry;

    await squareRequest('POST', `/v2/customers/${existingCustomerId}/custom-attributes/${encodedKey}`, {
      custom_attribute: { value: updatedValue },
    });

    return { status: 'updated', customerId: existingCustomerId };
  }

  // Create new customer
  const createData = await squareRequest('POST', '/v2/customers', {
    idempotency_key: submissionID ? `consult-${submissionID}` : randomUUID(),
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

  return { status: 'created', customerId };
}
