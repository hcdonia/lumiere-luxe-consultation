document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const submissionID = params.get('submissionID');

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

async function initSquarePayments() {
  try {
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
    await card.attach('#card-container');

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
