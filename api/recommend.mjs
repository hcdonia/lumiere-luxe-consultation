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
  'haircut': '5oai4fqfchxlrg',
};

const SYSTEM_PROMPT = `You are an AI hair consultation specialist for Lumiere Luxe Salon in Los Angeles & South Bay.

Your job is to analyze a guest's consultation form answers and recommend the single best session from the service guide below.

SERVICE GUIDE:
${serviceGuide}

INSTRUCTIONS:
- Recommend exactly ONE service based on the guest's answers AND any photos they uploaded.
- If photos of their current hair are included, use them to assess: current color level, existing highlights/balayage, gray percentage, hair condition, texture, and length. This visual assessment should heavily inform your recommendation.
- If inspiration photos are included, use them to understand the guest's desired outcome and match it to the right service.
- Use the "Who This Is For" and "Who This Is NOT For" criteria to make your decision.
- Pay close attention to the Quick Decision Matrix for common scenarios.
- Do NOT simply go with whatever service the guest selected on the form. Clients often pick based on price, not what's actually right for their hair. Use their hair history, goals, photos, and the service guide criteria to determine the best match independently.
- If the guest's answers or photos suggest they need an in-person consultation first (e.g., very dark/box-colored hair, severely damaged hair, heavy box color, significant gray to address, wants solid all-over color), still recommend the closest service but note that a consultation is recommended.
- Speak directly to the guest in a warm, professional, and encouraging tone.

Respond in JSON format ONLY (no markdown, no code fences):
{
  "serviceKey": "<one of: new-luxe, natural-luxe, mini-luxe>",
  "serviceName": "<full service name as listed in the guide>",
  "explanation": "<2-3 sentences explaining why this session is perfect for her, referencing her specific answers. Be warm and personal.>",
  "details": "<duration and price range for this service>",
  "consultationSummary": "<Detailed consultation summary written for the salon stylist. Include ALL of the following that apply:\n- Current hair: color level, condition, texture, length (mention what you see in photos if provided)\n- Hair history: chemical treatments, previous color, box color, perms, relaxers, keratin, etc.\n- What she wants: desired outcome, inspiration photo description if provided\n- Maintenance preference: how often she's willing to come back\n- Priority: speed vs hair health\n- Preferred stylist\n- Flags: anything the stylist should be aware of (damage, unrealistic expectations, needs in-person consultation, etc.)\n- Recommended service and why\nWrite 4-6 sentences. Be specific and detailed — this is the stylist's prep notes.>"
}`;

// Detect whether the guest selected "Extensions" on the JotForm services question (q name: whichOf)
function wantsExtensions(submission) {
  const answers = submission.answers || {};
  for (const [, field] of Object.entries(answers)) {
    if ((field.name || '').toLowerCase() !== 'whichof') continue;
    const ans = field.answer;
    if (!ans) continue;
    const values = Array.isArray(ans) ? ans : [ans];
    if (values.some((v) => String(v).toLowerCase().includes('extension'))) {
      return true;
    }
  }
  return false;
}

// Detect whether the guest answered YES to "Are you ONLY looking to book a haircut?" (q name: areYou)
function wantsHaircutOnly(submission) {
  const answers = submission.answers || {};
  for (const [, field] of Object.entries(answers)) {
    if ((field.name || '').toLowerCase() !== 'areyou') continue;
    if (String(field.answer || '').trim().toLowerCase() === 'yes') {
      return true;
    }
  }
  return false;
}

// Build a hardcoded haircut recommendation (no AI call needed)
function buildHaircutRecommendation(submission) {
  const widgetId = WIDGET_IDS.haircut;
  return {
    serviceKey: 'haircut',
    serviceName: 'Haircut',
    explanation:
      "Since you're just looking for a haircut, you can book that directly below. Pick a time that works for you and we can't wait to see you!",
    details: 'Haircut & style with one of our talented stylists.',
    consultationSummary: `Guest indicated they are ONLY looking to book a haircut. Contact info: ${
      extractClientInfo(submission).email || 'no email'
    }.`,
    widgetId,
    locationId: LOCATION_ID,
    bookingUrl: `https://squareup.com/appointments/book/${widgetId}/${LOCATION_ID}/services`,
    widgetScriptUrl: `https://app.squareup.com/appointments/buyer/widget/${widgetId}/${LOCATION_ID}.js`,
    clientInfo: extractClientInfo(submission),
  };
}

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

// Convert JotForm submission answers into readable text for the AI (excludes file uploads)
function formatSubmissionForAI(submission) {
  const answers = submission.answers || {};
  const lines = [];

  for (const [, field] of Object.entries(answers)) {
    // Skip non-answer fields (headings, buttons, images, file uploads)
    if (!field.answer || field.type === 'control_head' || field.type === 'control_button' || field.type === 'control_image' || field.type === 'control_fileupload') {
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

// Extract image URLs from file upload fields
function extractImageUrls(submission) {
  const answers = submission.answers || {};
  const images = [];

  for (const [, field] of Object.entries(answers)) {
    if (field.type !== 'control_fileupload' || !field.answer) continue;

    const urls = Array.isArray(field.answer) ? field.answer : [field.answer];
    const label = field.text || field.name;

    for (const url of urls) {
      // Only include image files
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(url)) {
        images.push({ url, label });
      }
    }
  }

  return images;
}

// Download an image and convert to base64 for the Claude API
async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) return null;

  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');

  // Map content type to Claude's supported media types
  let mediaType = 'image/jpeg';
  if (contentType.includes('png')) mediaType = 'image/png';
  else if (contentType.includes('gif')) mediaType = 'image/gif';
  else if (contentType.includes('webp')) mediaType = 'image/webp';

  return { base64, mediaType };
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

    const formattedAnswers = formatSubmissionForAI(submission);
    const imageRefs = extractImageUrls(submission);

    // Download images in parallel (limit to 8 to stay within API limits)
    const imageResults = await Promise.all(
      imageRefs.slice(0, 8).map(async (img) => {
        const data = await fetchImageAsBase64(img.url);
        return data ? { ...data, label: img.label } : null;
      })
    );
    const validImages = imageResults.filter(Boolean);

    // Build message content: text + images
    const userContent = [];

    userContent.push({
      type: 'text',
      text: `Here are my consultation form answers:\n\n${formattedAnswers}`,
    });

    if (validImages.length > 0) {
      // Group images by their label (current hair vs inspiration)
      const currentHairImages = validImages.filter((img) =>
        img.label.toLowerCase().includes('current') || img.label.toLowerCase().includes('confirm')
      );
      const inspoImages = validImages.filter((img) =>
        img.label.toLowerCase().includes('inspirat') || img.label.toLowerCase().includes('look you are wanting')
      );
      const otherImages = validImages.filter(
        (img) => !currentHairImages.includes(img) && !inspoImages.includes(img)
      );

      if (currentHairImages.length > 0) {
        userContent.push({ type: 'text', text: '\nPhotos of my current hair:' });
        for (const img of currentHairImages) {
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          });
        }
      }

      if (inspoImages.length > 0) {
        userContent.push({ type: 'text', text: '\nMy inspiration photos (the look I want to achieve):' });
        for (const img of inspoImages) {
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          });
        }
      }

      if (otherImages.length > 0) {
        userContent.push({ type: 'text', text: '\nAdditional photos:' });
        for (const img of otherImages) {
          userContent.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
          });
        }
      }
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: userContent,
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
