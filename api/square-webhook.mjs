import { createHmac } from 'crypto';

const SQUARE_BASE_URL = 'https://connect.squareup.com';
const JOTFORM_TABLES_URL = 'https://www.jotform.com/tables/251448462902155';

// How close (in minutes) the customer creation must be to the booking to count as "new"
const NEW_CUSTOMER_THRESHOLD_MINUTES = 30;

async function squareGet(path) {
  const res = await fetch(`${SQUARE_BASE_URL}${path}`, {
    headers: {
      'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2025-03-19',
    },
  });
  return res.json();
}

async function getBooking(bookingId) {
  const data = await squareGet(`/v2/bookings/${bookingId}`);
  return data.booking;
}

async function getCustomer(customerId) {
  const data = await squareGet(`/v2/customers/${customerId}`);
  return data.customer;
}

async function getTeamMember(teamMemberId) {
  const data = await squareGet(`/v2/team-members/${teamMemberId}`);
  return data.team_member;
}

async function getCatalogItem(serviceVariationId) {
  const data = await squareGet(`/v2/catalog/object/${serviceVariationId}`);
  return data.object;
}

// Find Slack user by matching name against Square team member name
async function findSlackUser(stylistName) {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) return null;

  const nameLower = stylistName.toLowerCase();

  return data.members.find((u) => {
    if (u.is_bot || u.deleted || u.id === 'USLACKBOT') return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    return realName === nameLower || displayName === nameLower ||
      realName.includes(nameLower) || nameLower.includes(realName);
  });
}

// Send a DM to a Slack user
async function sendSlackDM(userId, message) {
  // Open a DM channel
  const openRes = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ users: userId }),
  });
  const openData = await openRes.json();
  if (!openData.ok) {
    console.error('Slack open DM error:', openData.error);
    return false;
  }

  const channelId = openData.channel.id;

  // Send the message
  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: channelId, text: message, mrkdwn: true }),
  });
  const msgData = await msgRes.json();
  if (!msgData.ok) {
    console.error('Slack send message error:', msgData.error);
    return false;
  }

  return true;
}

function isNewCustomer(customer, bookingCreatedAt) {
  const customerCreated = new Date(customer.created_at);
  const bookingCreated = new Date(bookingCreatedAt);
  const diffMinutes = Math.abs(bookingCreated - customerCreated) / (1000 * 60);
  return diffMinutes <= NEW_CUSTOMER_THRESHOLD_MINUTES;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Respond immediately — Square expects a quick response
  res.status(200).json({ received: true });

  try {
    const event = req.body;

    // Only handle booking.created events
    if (event.type !== 'booking.created') return;

    const bookingId = event.data?.id || event.data?.object?.booking?.id;
    if (!bookingId) return;

    // Get booking details
    const booking = await getBooking(bookingId);
    if (!booking) return;

    const customerId = booking.customer_id;
    if (!customerId) return;

    // Get customer and check if new
    const customer = await getCustomer(customerId);
    if (!customer) return;

    if (!isNewCustomer(customer, booking.created_at)) {
      // Not a new customer — skip notification
      return;
    }

    // Get stylist info from booking
    const segment = booking.appointment_segments?.[0];
    if (!segment) return;

    const teamMember = await getTeamMember(segment.team_member_id);
    const stylistName = teamMember
      ? `${teamMember.given_name || ''} ${teamMember.family_name || ''}`.trim()
      : 'Unknown stylist';

    // Get the customer's recommended service from their note
    const note = customer.note || '';
    const recommendedMatch = note.match(/Recommended:\s*(.+)/);
    const recommendedService = recommendedMatch ? recommendedMatch[1].trim() : 'N/A';

    // Build the Slack message
    const customerName = `${customer.given_name || ''} ${customer.family_name || ''}`.trim() || 'Unknown';
    const bookingDate = new Date(booking.start_at).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    const message = [
      `✨ *New Client Booking Alert*`,
      ``,
      `*${customerName}* just booked an appointment with you!`,
      `📅 ${bookingDate}`,
      `💇 Recommended service: *${recommendedService}*`,
      ``,
      `They submitted a consultation form — check their answers and photos:`,
      `👉 <${JOTFORM_TABLES_URL}|View Full Submission>`,
      ``,
      `Customer note:`,
      `> ${note.replace(/\n/g, '\n> ')}`,
    ].join('\n');

    // Find the stylist on Slack and DM them
    const slackUser = await findSlackUser(stylistName);
    if (slackUser) {
      await sendSlackDM(slackUser.id, message);
      console.log(`Slack notification sent to ${stylistName} (${slackUser.id})`);
    } else {
      console.log(`Could not find Slack user for stylist: ${stylistName}`);
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
}
