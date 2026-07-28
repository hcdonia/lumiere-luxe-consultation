// --- Google Ads conversion tracking ---
// The gclid rides in this page's URL (captured on lumiereluxesalon.com and passed
// through the JotForm), so the Google tag attributes the Lead to the ad click
// automatically. This call is guarded so tracking can never break the booking flow.
// Bookings — including the $35 extensions deposit — are tracked server-side via the
// Square webhook → Google Ads offline import, so there is deliberately no booking pixel here.
const GA_LEAD = 'AW-18175148301/fgW0CLu-18wcEI2Cy9pD';

function fireConversion(sendTo) {
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', { send_to: sendTo });
    }
  } catch (e) {
    // Never let a tracking error interrupt the user's experience.
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const submissionID = params.get('submissionID');

  // Guest already had an appointment when they filled out the form (hidden
  // alreadybooked prefill) — no recommender, no booking push, just confirmation.
  if (params.get('allset')) {
    showState('all-set');
    return;
  }

  // Guest booked the extensions consultation DIRECTLY on Square, so the $35
  // deposit was never collected. They only owe the deposit — no recommender,
  // no availability calendar, no new booking.
  if (params.get('extdeposit') && submissionID) {
    initDepositFlow(submissionID);
    return;
  }

  if (!submissionID) {
    showState('no-data');
    return;
  }

  showState('loading');

  try {
    // Step 1: Get AI recommendation (server fetches submission from JotForm)
    const recommendResponse = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionID }),
    });

    if (!recommendResponse.ok) {
      throw new Error('Recommendation request failed');
    }

    const recommendation = await recommendResponse.json();

    // Consultation completed → count a Lead (covers both the standard and extensions paths).
    // Guard on a real recommendation shape so a soft/empty 200 can never inflate leads.
    if (recommendation && (recommendation.flow === 'extensions' || recommendation.serviceName)) {
      fireConversion(GA_LEAD);
    }

    // Extensions flow: skip the AI recommendation UI entirely.
    if (recommendation.flow === 'extensions') {
      showState('extensions');
      initExtensionsFlow(recommendation.clientInfo, submissionID);
      return;
    }

    // Step 2: Show the recommendation immediately
    renderRecommendation(recommendation);
    showState('results');

    // Step 3: Create/update Square customer in background (using data from recommendation)
    fetch('/api/create-customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientInfo: recommendation.clientInfo,
        consultationSummary: recommendation.consultationSummary,
        recommendedService: recommendation.serviceName,
        submissionID,
      }),
    })
      .then((res) => {
        const statusEl = document.getElementById('profile-status');
        if (res.ok) {
          statusEl.textContent = 'Your profile has been saved. We look forward to seeing you!';
        }
      })
      .catch(() => {
        // Square failure is silent — doesn't affect the user experience
      });
  } catch (err) {
    console.error('Error:', err);
    showState('error');
  }
});

function showState(stateId) {
  document.querySelectorAll('.state').forEach((el) => el.classList.add('hidden'));
  document.getElementById(stateId).classList.remove('hidden');
  // Scroll to top so the user always sees the new state from the beginning
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderRecommendation(data) {
  document.getElementById('service-name').textContent = data.serviceName;
  document.getElementById('service-explanation').textContent = data.explanation;

  if (data.details) {
    document.getElementById('service-details').textContent = data.details;
  }

  // Embed the Square Appointments widget
  if (data.widgetScriptUrl) {
    const container = document.getElementById('square-widget-container');
    const script = document.createElement('script');
    script.src = data.widgetScriptUrl;
    container.appendChild(script);
  }

  // Set fallback booking link
  const bookBtn = document.getElementById('book-now-btn');
  if (data.bookingUrl) {
    bookBtn.href = data.bookingUrl;
  } else {
    bookBtn.href = 'https://lumiereluxesalon.com';
    bookBtn.textContent = 'Visit our website to book';
  }
}

// ============================================================
// Extensions Consultation Flow
// ============================================================

let extState = {
  selectedSlot: null,
  selectedDate: null, // YYYY-MM-DD in LA tz
  card: null,
  payments: null,
  clientInfo: null,
  submissionID: null,
  busy: false,
  slotsByDate: {},
  windowStart: null, // YYYY-MM-DD
  windowEnd: null, // YYYY-MM-DD
  viewYear: 0,
  viewMonth: 0, // 0-indexed
};

async function initExtensionsFlow(clientInfo, submissionID) {
  extState.clientInfo = clientInfo;
  extState.submissionID = submissionID;

  // Wire static buttons
  document.getElementById('ext-pay-btn').addEventListener('click', handleExtensionsPay);
  document.getElementById('ext-prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('ext-next-month').addEventListener('click', () => changeMonth(1));

  // Kick off availability fetch + Square SDK init in parallel.
  await Promise.all([loadAvailability(), initSquarePayments()]);
}

async function loadAvailability() {
  const statusEl = document.getElementById('ext-slots-status');
  const wrap = document.getElementById('ext-calendar-wrap');
  statusEl.textContent = 'Loading availability…';
  wrap.classList.add('hidden');

  try {
    const res = await fetch('/api/extensions-availability');
    if (!res.ok) throw new Error('availability fetch failed');
    const { slotsByDate, windowStart, windowEnd } = await res.json();

    if (!slotsByDate || Object.keys(slotsByDate).length === 0) {
      statusEl.textContent = 'No availability in the next 2 months. Please contact the salon directly.';
      return;
    }

    extState.slotsByDate = slotsByDate;
    extState.windowStart = windowStart;
    extState.windowEnd = windowEnd;

    // Initial view: month of the earliest available date
    const firstAvailable = Object.keys(slotsByDate).sort()[0];
    const [y, m] = firstAvailable.split('-').map(Number);
    extState.viewYear = y;
    extState.viewMonth = m - 1;

    statusEl.textContent = '';
    wrap.classList.remove('hidden');
    renderCalendar();
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not load availability. Please refresh and try again.';
  }
}

function changeMonth(delta) {
  const newDate = new Date(extState.viewYear, extState.viewMonth + delta, 1);
  extState.viewYear = newDate.getFullYear();
  extState.viewMonth = newDate.getMonth();
  renderCalendar();
}

function renderCalendar() {
  const calEl = document.getElementById('ext-calendar');
  const labelEl = document.getElementById('ext-month-label');
  const prevBtn = document.getElementById('ext-prev-month');
  const nextBtn = document.getElementById('ext-next-month');

  const year = extState.viewYear;
  const month = extState.viewMonth;
  const monthName = new Date(year, month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  labelEl.textContent = monthName;

  // Disable nav buttons outside the availability window
  const [winStartY, winStartM] = extState.windowStart.split('-').map(Number);
  const [winEndY, winEndM] = extState.windowEnd.split('-').map(Number);
  prevBtn.disabled = (year < winStartY) || (year === winStartY && month <= winStartM - 1);
  nextBtn.disabled = (year > winEndY) || (year === winEndY && month >= winEndM - 1);

  calEl.innerHTML = '';

  // Day-of-week headers (Sun-Sat)
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const d of dows) {
    const h = document.createElement('div');
    h.className = 'ext-cal-dow';
    h.textContent = d;
    calEl.appendChild(h);
  }

  const firstOfMonth = new Date(year, month, 1);
  const startOffset = firstOfMonth.getDay(); // 0 = Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading blank cells
  for (let i = 0; i < startOffset; i++) {
    const blank = document.createElement('div');
    blank.className = 'ext-cal-cell empty';
    calEl.appendChild(blank);
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const slots = extState.slotsByDate[dateKey];
    const hasSlots = slots && slots.length > 0;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'ext-cal-cell';
    cell.textContent = day;
    cell.dataset.date = dateKey;

    if (!hasSlots) {
      cell.disabled = true;
      cell.classList.add('disabled');
    } else {
      cell.classList.add('available');
      cell.addEventListener('click', () => selectDate(dateKey, cell));
    }

    if (extState.selectedDate === dateKey) {
      cell.classList.add('selected');
    }

    calEl.appendChild(cell);
  }

  // Re-render time slots for the selected date if it's in this month
  if (extState.selectedDate) {
    const [sy, sm] = extState.selectedDate.split('-').map(Number);
    if (sy === year && sm - 1 === month) {
      renderTimeSlots(extState.selectedDate);
    } else {
      document.getElementById('ext-times-wrap').classList.add('hidden');
    }
  }
}

function selectDate(dateKey, cellEl) {
  extState.selectedDate = dateKey;
  // Reset selected slot since it's tied to a previously selected date
  extState.selectedSlot = null;
  document.getElementById('ext-selected-summary').classList.add('hidden');

  document.querySelectorAll('.ext-cal-cell.selected').forEach((el) => el.classList.remove('selected'));
  if (cellEl) cellEl.classList.add('selected');

  renderTimeSlots(dateKey);
  updatePayButtonState();
}

function renderTimeSlots(dateKey) {
  const wrap = document.getElementById('ext-times-wrap');
  const heading = document.getElementById('ext-times-heading');
  const grid = document.getElementById('ext-times');

  const slots = extState.slotsByDate[dateKey] || [];
  if (slots.length === 0) {
    wrap.classList.add('hidden');
    return;
  }

  const friendly = new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  heading.textContent = `Times for ${friendly}`;

  grid.innerHTML = '';
  for (const slot of slots) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ext-slot';
    btn.dataset.startAt = slot.startAt;
    btn.textContent = new Date(slot.startAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    });
    if (extState.selectedSlot && extState.selectedSlot.startAt === slot.startAt) {
      btn.classList.add('selected');
    }
    btn.addEventListener('click', () => selectSlot(slot, btn));
    grid.appendChild(btn);
  }

  wrap.classList.remove('hidden');
}

function selectSlot(slot, btnEl) {
  extState.selectedSlot = slot;
  document.querySelectorAll('.ext-slot.selected').forEach((el) => el.classList.remove('selected'));
  btnEl.classList.add('selected');

  const summary = document.getElementById('ext-selected-summary');
  const human = new Date(slot.startAt).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  });
  summary.textContent = `Selected: ${human}`;
  summary.classList.remove('hidden');

  updatePayButtonState();
}

function updatePayButtonState() {
  const btn = document.getElementById('ext-pay-btn');
  if (extState.selectedSlot && extState.card && !extState.busy) {
    btn.disabled = false;
    btn.textContent = 'Pay $35 & Confirm Booking';
  } else if (!extState.selectedSlot) {
    btn.disabled = true;
    btn.textContent = 'Select a time first';
  } else if (!extState.card) {
    btn.disabled = true;
    btn.textContent = 'Loading payment form…';
  }
}

// Loads the Square Web Payments SDK and attaches a card input to the given
// container. Shared by the extensions booking flow and the deposit-only flow.
// Throws on any failure so each caller can show its own error copy.
async function attachSquareCard(containerSelector) {
  const cfgRes = await fetch('/api/extensions-config');
  if (!cfgRes.ok) throw new Error('config fetch failed');
  const { applicationId, locationId, environment } = await cfgRes.json();

  // Load Web Payments SDK
  const sdkUrl = environment === 'production'
    ? 'https://web.squarecdn.com/v1/square.js'
    : 'https://sandbox.web.squarecdn.com/v1/square.js';

  await loadScript(sdkUrl);

  if (!window.Square) throw new Error('Square SDK failed to load');

  const payments = window.Square.payments(applicationId, locationId);
  const card = await payments.card();
  await card.attach(containerSelector);

  return { payments, card };
}

async function initSquarePayments() {
  try {
    const { payments, card } = await attachSquareCard('#card-container');

    extState.payments = payments;
    extState.card = card;

    updatePayButtonState();
  } catch (err) {
    console.error('Square payments init failed:', err);
    document.getElementById('ext-pay-status').textContent =
      'Could not load the payment form. Please refresh and try again.';
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function handleExtensionsPay() {
  if (extState.busy || !extState.selectedSlot || !extState.card) return;

  const statusEl = document.getElementById('ext-pay-status');
  const btn = document.getElementById('ext-pay-btn');

  extState.busy = true;
  btn.disabled = true;
  btn.textContent = 'Processing…';
  statusEl.textContent = '';
  statusEl.className = 'ext-status';

  try {
    const tokenResult = await extState.card.tokenize();
    if (tokenResult.status !== 'OK') {
      const errMsg = tokenResult.errors?.[0]?.message || 'Card details look invalid.';
      throw new Error(errMsg);
    }

    const res = await fetch('/api/extensions-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionID: extState.submissionID,
        clientInfo: extState.clientInfo,
        slotStartAt: extState.selectedSlot.startAt,
        sourceId: tokenResult.token,
      }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Slot taken — refresh availability
      statusEl.textContent = 'That time was just taken. Please pick another.';
      statusEl.className = 'ext-status error';
      extState.selectedSlot = null;
      extState.selectedDate = null;
      document.getElementById('ext-selected-summary').classList.add('hidden');
      document.getElementById('ext-times-wrap').classList.add('hidden');
      await loadAvailability();
      return;
    }

    if (!res.ok) {
      throw new Error(data.detail || data.error || 'Booking failed');
    }

    // Success — show confirmation state
    const human = new Date(data.slotStartAt).toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    });
    document.getElementById('ext-confirmed-time').textContent = human;
    // Booking is tracked server-side (Square webhook → Google Ads offline import), not here.
    showState('extensions-confirmed');
  } catch (err) {
    console.error('Pay error:', err);
    statusEl.textContent = err.message || 'Something went wrong. Please try again.';
    statusEl.className = 'ext-status error';
  } finally {
    extState.busy = false;
    updatePayButtonState();
  }
}

// ============================================================
// Extensions Deposit-Only Flow (booked on Square, deposit still owed)
// ============================================================

let depState = {
  card: null,
  payments: null,
  submissionID: null,
  busy: false,
};

async function initDepositFlow(submissionID) {
  depState.submissionID = submissionID;

  const statusEl = document.getElementById('dep-pay-status');
  showState('ext-deposit');
  // The loading text sits where the appointment time will land, so the page
  // never shows "booked for:" followed by nothing.
  document.getElementById('dep-time').textContent = 'Looking up your appointment…';

  // Step 1: find their booking + whether the deposit is already paid.
  let info;
  try {
    const res = await fetch(`/api/extensions-deposit?submissionID=${encodeURIComponent(submissionID)}`);
    if (res.status === 404) {
      // Not an eligible deposit link — hand them to the salon.
      showState('ext-deposit-notfound');
      return;
    }
    if (!res.ok) throw new Error('deposit lookup failed');
    info = await res.json();
  } catch (err) {
    // Transient server trouble is NOT "no booking" — show the generic error
    // state (refresh may fix it) instead of a permanent-looking not-found.
    console.error('Deposit lookup error:', err);
    showState('error');
    return;
  }

  if (!info || !info.found) {
    showState('ext-deposit-notfound');
    return;
  }

  // Already paid (e.g. they refreshed or came back to the link) — treat as done.
  if (info.depositPaid) {
    document.getElementById('dep-confirmed-time').textContent = info.startLabel || '';
    showState('ext-deposit-confirmed');
    return;
  }

  document.getElementById('dep-time').textContent = info.startLabel || '';
  statusEl.textContent = '';

  // Step 2: stand up the card form.
  document.getElementById('dep-pay-btn').addEventListener('click', handleDepositPay);

  try {
    const { payments, card } = await attachSquareCard('#dep-card-container');
    depState.payments = payments;
    depState.card = card;
    updateDepositButtonState();
  } catch (err) {
    console.error('Square payments init failed:', err);
    statusEl.textContent = 'Could not load the payment form. Please refresh and try again.';
    statusEl.className = 'ext-status error';
  }
}

function updateDepositButtonState() {
  const btn = document.getElementById('dep-pay-btn');
  if (depState.card && !depState.busy) {
    btn.disabled = false;
    btn.textContent = 'Pay $35 Deposit';
  } else if (!depState.card) {
    btn.disabled = true;
    btn.textContent = 'Loading payment form…';
  }
}

async function handleDepositPay() {
  if (depState.busy || !depState.card) return;

  const statusEl = document.getElementById('dep-pay-status');
  const btn = document.getElementById('dep-pay-btn');

  depState.busy = true;
  btn.disabled = true;
  btn.textContent = 'Processing…';
  statusEl.textContent = '';
  statusEl.className = 'ext-status';

  try {
    const tokenResult = await depState.card.tokenize();
    if (tokenResult.status !== 'OK') {
      const errMsg = tokenResult.errors?.[0]?.message || 'Card details look invalid.';
      throw new Error(errMsg);
    }

    const res = await fetch('/api/extensions-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        submissionID: depState.submissionID,
        sourceId: tokenResult.token,
      }),
    });

    const data = await res.json();

    if (res.status === 404) {
      // Their booking disappeared (cancelled/rescheduled) — hand them to the salon.
      showState('ext-deposit-notfound');
      return;
    }

    if (!res.ok) {
      throw new Error(data.detail || data.error || 'Deposit payment failed');
    }

    // Success (or it was already paid) — same confirmation either way.
    document.getElementById('dep-confirmed-time').textContent = data.startLabel || '';
    // Deposit is tracked server-side (Square webhook → Google Ads offline import), not here.
    showState('ext-deposit-confirmed');
  } catch (err) {
    console.error('Deposit pay error:', err);
    statusEl.textContent = err.message || 'Something went wrong. Please try again.';
    statusEl.className = 'ext-status error';
  } finally {
    depState.busy = false;
    updateDepositButtonState();
  }
}
