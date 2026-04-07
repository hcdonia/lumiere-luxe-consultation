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
  card: null,
  payments: null,
  clientInfo: null,
  submissionID: null,
  busy: false,
};

async function initExtensionsFlow(clientInfo, submissionID) {
  extState.clientInfo = clientInfo;
  extState.submissionID = submissionID;

  // Wire pay button
  document.getElementById('ext-pay-btn').addEventListener('click', handleExtensionsPay);

  // Kick off availability fetch + Square SDK init in parallel.
  await Promise.all([loadAvailability(), initSquarePayments()]);
}

async function loadAvailability() {
  const statusEl = document.getElementById('ext-slots-status');
  const slotsEl = document.getElementById('ext-slots');
  statusEl.textContent = 'Loading available times…';
  slotsEl.innerHTML = '';

  try {
    const res = await fetch('/api/extensions-availability');
    if (!res.ok) throw new Error('availability fetch failed');
    const { slots } = await res.json();

    if (!slots || slots.length === 0) {
      statusEl.textContent = 'No availability in the next 14 days. Please contact the salon directly.';
      return;
    }

    statusEl.textContent = '';
    renderSlots(slots);
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not load available times. Please refresh and try again.';
  }
}

function renderSlots(slots) {
  const container = document.getElementById('ext-slots');
  container.innerHTML = '';

  // Group slots by local date
  const groups = {};
  for (const slot of slots) {
    const d = new Date(slot.startAt);
    const key = d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/Los_Angeles',
    });
    if (!groups[key]) groups[key] = [];
    groups[key].push(slot);
  }

  for (const [day, daySlots] of Object.entries(groups)) {
    const dayWrap = document.createElement('div');
    dayWrap.className = 'ext-day';

    const heading = document.createElement('h4');
    heading.textContent = day;
    dayWrap.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'ext-slot-grid';

    for (const slot of daySlots) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ext-slot';
      btn.dataset.startAt = slot.startAt;
      btn.textContent = new Date(slot.startAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Los_Angeles',
      });
      btn.addEventListener('click', () => selectSlot(slot, btn));
      grid.appendChild(btn);
    }

    dayWrap.appendChild(grid);
    container.appendChild(dayWrap);
  }
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
      document.getElementById('ext-selected-summary').classList.add('hidden');
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
