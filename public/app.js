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
