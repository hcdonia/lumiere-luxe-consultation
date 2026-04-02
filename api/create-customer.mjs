import { SquareClient, SquareEnvironment } from 'square';
import { randomUUID } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const squareClient = new SquareClient({
      token: process.env.SQUARE_ACCESS_TOKEN,
      environment:
        process.env.SQUARE_ENVIRONMENT === 'production'
          ? SquareEnvironment.Production
          : SquareEnvironment.Sandbox,
    });

    const { clientInfo, consultationSummary, recommendedService } = req.body;

    if (!clientInfo) {
      return res.status(400).json({ error: 'Missing client info' });
    }

    const { givenName, familyName, email, phone } = clientInfo;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Email or phone is required' });
    }

    // Build the note with AI summary
    const date = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const note = `--- Hair Consultation (${date}) ---\nRecommended: ${recommendedService || 'N/A'}\n${consultationSummary || ''}`;

    // Search for existing customer by email
    let existingCustomerId = null;

    if (email) {
      const searchResponse = await squareClient.customers.search({
        query: {
          filter: {
            emailAddress: {
              exact: email,
            },
          },
        },
      });

      const customers = searchResponse.customers;
      if (customers && customers.length > 0) {
        existingCustomerId = customers[0].id;
      }
    }

    if (existingCustomerId) {
      // Update existing customer — append new consultation to existing note
      const existingCustomer = await squareClient.customers.get({ customerId: existingCustomerId });
      const existingNote = existingCustomer.customer.note || '';
      const updatedNote = existingNote ? `${note}\n\n${existingNote}` : note;

      await squareClient.customers.update({ customerId: existingCustomerId, note: updatedNote });

      return res.status(200).json({ status: 'updated', customerId: existingCustomerId });
    } else {
      // Create new customer
      const createResponse = await squareClient.customers.create({
        idempotencyKey: randomUUID(),
        givenName: givenName || undefined,
        familyName: familyName || undefined,
        emailAddress: email || undefined,
        phoneNumber: phone || undefined,
        note,
      });

      const newCustomerId = createResponse.customer.id;
      return res.status(201).json({ status: 'created', customerId: newCustomerId });
    }
  } catch (err) {
    console.error('Square customer error:', err.message);
    return res.status(500).json({ error: 'Failed to create/update customer' });
  }
}
