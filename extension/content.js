// ---------------------------------------------------------------------------
// Content script for localhost:3000 — bridges dashboard ↔ extension
// Runs on the dashboard page and keeps the service worker alive.
// ---------------------------------------------------------------------------

(function () {
  console.log('[etsy-scraper] Content script loaded on dashboard');

  // 1. Intercept fetch to /api/search to detect new search creation
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const method = (args[1]?.method || 'GET').toUpperCase();

      // When a new search is created, wake the extension
      if (method === 'POST' && url.includes('/api/search')) {
        // Clone the response so the dashboard can still read it
        const clone = resp.clone();
        clone.json().then((data) => {
          console.log('[etsy-scraper] New search created:', data.keyword, data.id);
          // Send message to background — this WAKES the service worker
          chrome.runtime.sendMessage(
            { type: 'newSearch', searchId: data.id, keyword: data.keyword },
            (response) => {
              if (chrome.runtime.lastError) {
                console.log('[etsy-scraper] Extension message error:', chrome.runtime.lastError.message);
              } else {
                console.log('[etsy-scraper] Extension responded:', response);
              }
            }
          );
        }).catch(() => {});
      }
    } catch (e) {
      // Don't break the original fetch
    }

    return resp;
  };

  // 2. Periodic keepalive — ping the background worker every 20s
  //    This keeps the service worker alive while the dashboard tab is open
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'keepAlive' }, (response) => {
      if (chrome.runtime.lastError) {
        // Extension might have reloaded, ignore
      }
    });
  }, 20000);

  // 3. Initial ping on load
  chrome.runtime.sendMessage({ type: 'keepAlive' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[etsy-scraper] Initial ping failed — extension may need reload');
    } else {
      console.log('[etsy-scraper] Extension is alive:', response);
    }
  });
})();
