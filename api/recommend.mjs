import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serviceGuide = readFileSync(join(__dirname, '..', 'data', 'service-guide.md'), 'utf-8');

const LOCATION_ID = 'LWJX3SDVSAD04';

const WIDGET_IDS = {
  'new-luxe': '31h9cf9wirzwgf',
  'natural-luxe': '8siltkx9sfo1nm',
  'mini-luxe': 'ftjxx4b9kxr3ku',
  'platinum-blonding': 'zgtkor6o5q87ub',
  'gray-blending': 'sawk2vj5xja6u3',
};

const SYSTEM_PROMPT = `You are an AI hair consultation specialist for Lumiere Luxe Salon in Los Angeles & South Bay.

Your job is to analyze a guest's consultation form answers and recommend the single best session from the service guide below.

SERVICE GUIDE:
${serviceGuide}

INSTRUCTIONS:
- Recommend exactly ONE service based on the guest's answers.
- Use the "Who This Is For" and "Who This Is NOT For" criteria to make your decision.
- Pay close attention to the Quick Decision Matrix for common scenarios.
- Do NOT simply go with whatever service the guest selected on the form. Clients often pick based on price, not what's actually right for their hair. Use their hair history, goals, and the service guide criteria to determine the best match independently.
- If the guest's answers suggest they need an in-person consultation first (e.g., very dark/box-colored hair wanting platinum, severely damaged hair), still recommend the closest service but note that a consultation is recommended.
- Speak directly to the guest in a warm, professional, and encouraging tone.

Respond in JSON format ONLY (no markdown, no code fences):
{
  "serviceKey": "<one of: new-luxe, natural-luxe, mini-luxe, platinum-blonding, gray-blending>",
  "serviceName": "<full service name as listed in the guide>",
  "explanation": "<2-3 sentences explaining why this session is perfect for her, referencing her specific answers. Be warm and personal.>",
  "details": "<duration and price range for this service>",
  "consultationSummary": "<2-3 sentence summary of the guest's hair situation, goals, and recommended service — written for the salon stylist, not the guest. Include key details like current hair state, desired outcome, and any flags.>"
}`;

// Fetch submission data from JotForm API
async function fetchSubmission(submissionID) {
  const res = await fetch(
    `https://api.jotform.com/submission/${submissionID}?apiKey=${process.env.JOTFORM_API_KEY}`
  );
  if (!res.ok) {
    throw new Error(`JotForm API error: ${res.status}`);
  }
  const data = await res.json();
  if (data.responseCode !== 200) {
    throw new Error(`JotForm error: ${data.message}`);
  }
  return data.content;
}

// Convert JotForm submission answers into readable text for the AI
function formatSubmissionForAI(submission) {
  const answers = submission.answers || {};
  const lines = [];

  for (const [, field] of Object.entries(answers)) {
    // Skip non-answer fields (headings, buttons, etc.)
    if (!field.answer || field.type === 'control_head' || field.type === 'control_button') {
      continue;
    }

    const label = field.text || field.name;
    let value = field.prettyFormat || field.answer;

    // Handle object answers (like name fields with first/last)
    if (typeof value === 'object') {
      value = Object.values(value).filter(Boolean).join(' ');
    }

    if (value) {
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join('\n');
}

// Extract client info (name, email, phone) from submission
export function extractClientInfo(submission) {
  const answers = submission.answers || {};
  const info = { givenName: '', familyName: '', email: '', phone: '' };

  for (const [, field] of Object.entries(answers)) {
    if (!field.answer) continue;

    const name = (field.name || '').toLowerCase();
    const type = (field.type || '').toLowerCase();

    if (type === 'control_fullname' || name.includes('name')) {
      if (typeof field.answer === 'object') {
        info.givenName = info.givenName || field.answer.first || '';
        info.familyName = info.familyName || field.answer.last || '';
      }
    }
    if (name === 'firstname' || name === 'first_name') {
      info.givenName = info.givenName || String(field.answer);
    }
    if (name === 'lastname' || name === 'last_name') {
      info.familyName = info.familyName || String(field.answer);
    }
    if (type === 'control_email' || name.includes('email')) {
      info.email = info.email || String(field.answer);
    }
    if (type === 'control_phone' || name.includes('phone')) {
      const phone = field.prettyFormat || field.answer;
      info.phone = info.phone || String(typeof phone === 'object' ? Object.values(phone).join('') : phone);
    }
  }

  return info;
}

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
    const formattedAnswers = formatSubmissionForAI(submission);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Here are my consultation form answers:\n\n${formattedAnswers}`,
        },
      ],
      system: SYSTEM_PROMPT,
    });

    const responseText = message.content[0].text;
    const recommendation = JSON.parse(responseText);

    // Attach widget info for embedding + fallback link
    const widgetId = WIDGET_IDS[recommendation.serviceKey] || '';
    recommendation.widgetId = widgetId;
    recommendation.locationId = LOCATION_ID;
    recommendation.bookingUrl = widgetId
      ? `https://squareup.com/appointments/book/${widgetId}/${LOCATION_ID}/services`
      : '';
    recommendation.widgetScriptUrl = widgetId
      ? `https://app.squareup.com/appointments/buyer/widget/${widgetId}/${LOCATION_ID}.js`
      : '';

    // Include client info + summary so create-customer can use it
    recommendation.clientInfo = extractClientInfo(submission);

    return res.status(200).json(recommendation);
  } catch (err) {
    console.error('Recommend error:', err.message);
    return res.status(500).json({ error: 'Failed to generate recommendation' });
  }
}
