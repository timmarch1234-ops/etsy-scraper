// ---------------------------------------------------------------------------
// Etsy Scraper — Chrome Extension Background Service Worker
// ---------------------------------------------------------------------------

const API_BASE = 'http://localhost:3000/api';
const MAX_PAGES = 20;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

let currentJob = null; // { searchId, keyword, pagesScanned, listingsScanned, listingsShortlisted, totalPages }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomDelay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise((r) => setTimeout(r, ms));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(`${API_BASE}${path}`, opts);
    return await resp.json();
  } catch (e) {
    console.error('[scraper] API error:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function createTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      // Wait for the tab to finish loading
      function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout after 30s
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }, 30000);
    });
  });
}

async function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 30000);
    });
  });
}

async function closeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

async function executeScript(tabId, func, args) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func,
        args: args || [],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          console.error('[scraper] Script error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(results && results[0] ? results[0].result : null);
        }
      }
    );
  });
}

async function captureScreenshot(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('[scraper] Screenshot error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(dataUrl);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Extract listing URLs from search results page
// ---------------------------------------------------------------------------

function extractListingUrlsFromPage() {
  const links = document.querySelectorAll('a[href*="/listing/"]');
  const urls = new Set();
  for (const link of links) {
    try {
      const u = new URL(link.href);
      urls.add(`${u.origin}${u.pathname}`);
    } catch {}
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// Check a listing page for recent sales indicators
// ---------------------------------------------------------------------------

function checkListingForSales() {
  const body = document.body ? document.body.innerText : '';
  const patterns = [
    /(\d+)\s+sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
    /(\d+)\s+sold\s+recently/i,
    /(\d+)\s+people\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours/i,
    /(\d+)\s+sales?\s+in\s+the\s+last\s+24\s+hours/i,
  ];
  for (const pat of patterns) {
    const m = body.match(pat);
    if (m) {
      const count = m[1] ? parseInt(m[1], 10) : 0;
      return { found: true, soldCount: count, matchText: m[0] };
    }
  }
  return { found: false };
}

function extractListingMeta() {
  const titleEl = document.querySelector('h1');
  const title = titleEl ? titleEl.innerText.trim() : document.title;

  let price = '';
  const priceEl =
    document.querySelector('[data-buy-box-listing-price] p') ||
    document.querySelector('.wt-text-title-larger') ||
    document.querySelector('[data-selector="price"]') ||
    document.querySelector('p[class*="price"]');
  if (priceEl) price = priceEl.innerText.trim();

  return { title, price };
}

function scrollSalesIntoView() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const patterns = [/sold in.*?24 hours/i, /sold recently/i, /bought this in/i];
  while (walker.nextNode()) {
    const txt = walker.currentNode.textContent;
    for (const pat of patterns) {
      if (pat.test(txt)) {
        const el = walker.currentNode.parentElement;
        if (el) {
          const rect = el.getBoundingClientRect();
          window.scrollBy(0, rect.top - 200);
          return true;
        }
      }
    }
  }
  window.scrollTo(0, 0);
  return false;
}

// ---------------------------------------------------------------------------
// Check if page is blocked by DataDome
// ---------------------------------------------------------------------------

function checkIfBlocked() {
  const body = document.body ? document.body.innerText : '';
  const html = document.documentElement.innerHTML || '';
  if (html.includes('captcha-delivery')) return true;
  if (body.toLowerCase().includes('access denied')) return true;
  if (document.title === 'etsy.com' && body.trim().length === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main scraping loop
// ---------------------------------------------------------------------------

async function scrapeKeyword(searchId, keyword) {
  const startTime = Date.now();
  currentJob = {
    searchId,
    keyword,
    pagesScanned: 0,
    listingsScanned: 0,
    listingsShortlisted: 0,
    totalPages: MAX_PAGES,
  };

  console.log(`[scraper] Starting scrape for "${keyword}" (search: ${searchId})`);

  // Create a tab for scraping
  const tab = await createTab('about:blank');
  const tabId = tab.id;

  // Randomize page order
  const pageNumbers = shuffle(Array.from({ length: MAX_PAGES }, (_, i) => i + 1));
  let consecutiveBlocks = 0;

  try {
    for (const pageNum of pageNumbers) {
      // Timeout check
      if (Date.now() - startTime > MAX_DURATION_MS) {
        console.log('[scraper] 30-minute timeout reached');
        break;
      }

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${pageNum}`;
      console.log(`[scraper] Page ${pageNum}: ${searchUrl}`);

      // Navigate to search page
      await navigateTab(tabId, searchUrl);
      await randomDelay(2000, 4000);

      // Check for block
      const blocked = await executeScript(tabId, checkIfBlocked);
      if (blocked) {
        consecutiveBlocks++;
        console.log(`[scraper] Blocked (${consecutiveBlocks}/3)`);
        if (consecutiveBlocks >= 3) {
          await api('PATCH', `/searches/${searchId}`, { status: 'blocked' });
          currentJob = null;
          await closeTab(tabId);
          return;
        }
        // Wait and retry
        await randomDelay(30000, 60000);
        continue;
      }
      consecutiveBlocks = 0;

      // Extract listing URLs
      const listingUrls = await executeScript(tabId, extractListingUrlsFromPage);
      console.log(`[scraper] Page ${pageNum}: ${listingUrls ? listingUrls.length : 0} listings found`);

      if (listingUrls && listingUrls.length > 0) {
        // Visit each listing
        for (const listingUrl of listingUrls) {
          if (Date.now() - startTime > MAX_DURATION_MS) break;

          await randomDelay(1500, 3500);
          await navigateTab(tabId, listingUrl);
          await randomDelay(1500, 2500);

          currentJob.listingsScanned++;

          // Check for block
          const listingBlocked = await executeScript(tabId, checkIfBlocked);
          if (listingBlocked) {
            consecutiveBlocks++;
            if (consecutiveBlocks >= 3) {
              await api('PATCH', `/searches/${searchId}`, { status: 'blocked' });
              currentJob = null;
              await closeTab(tabId);
              return;
            }
            await randomDelay(15000, 30000);
            continue;
          }
          consecutiveBlocks = 0;

          // Check for sales data
          const salesData = await executeScript(tabId, checkListingForSales);
          if (salesData && salesData.found) {
            const meta = await executeScript(tabId, extractListingMeta);

            // Scroll to top so screenshot shows the product image, title, price
            await executeScript(tabId, function () {
              window.scrollTo(0, 0);
            });
            await randomDelay(300, 500);

            // Bring tab to front for screenshot and wait for full render
            await new Promise((r) => chrome.tabs.update(tabId, { active: true }, r));
            await randomDelay(1500, 2500);

            // Capture screenshot as data URL (real visible tab capture)
            const screenshotDataUrl = await captureScreenshot(tabId);

            currentJob.listingsShortlisted++;
            console.log(`[scraper] SHORTLISTED: "${meta?.title}" — ${salesData.soldCount} sold`);

            // Send to server
            await api('POST', `/searches/${searchId}/listings`, {
              title: meta?.title || 'Untitled',
              price: meta?.price || '',
              url: listingUrl,
              soldCount: salesData.soldCount,
              screenshotDataUrl: screenshotDataUrl,
            });
          }
        }
      }

      currentJob.pagesScanned++;

      // Report progress
      await api('PATCH', `/searches/${searchId}`, {
        pages_scanned: currentJob.pagesScanned,
        listings_scanned: currentJob.listingsScanned,
        listings_shortlisted: currentJob.listingsShortlisted,
      });

      // Random delay between pages
      await randomDelay(3000, 7000);
    }

    // Complete
    await api('PATCH', `/searches/${searchId}`, {
      status: 'success',
      pages_scanned: currentJob.pagesScanned,
      listings_scanned: currentJob.listingsScanned,
      listings_shortlisted: currentJob.listingsShortlisted,
    });
    console.log(`[scraper] Complete. Scanned ${currentJob.pagesScanned} pages, ${currentJob.listingsScanned} listings, ${currentJob.listingsShortlisted} shortlisted`);
  } catch (err) {
    console.error('[scraper] Fatal error:', err);
    await api('PATCH', `/searches/${searchId}`, { status: 'error' });
  } finally {
    try { await closeTab(tabId); } catch {}
    currentJob = null;
  }
}

// ---------------------------------------------------------------------------
// Polling for new searches
// ---------------------------------------------------------------------------

async function pollForSearches() {
  if (currentJob) return; // Already busy

  try {
    const searches = await api('GET', '/searches');
    if (!searches || !Array.isArray(searches)) return;

    const pending = searches.find((s) => s.status === 'running');
    if (pending) {
      console.log(`[scraper] Found pending search: "${pending.keyword}" (${pending.id})`);
      scrapeKeyword(pending.id, pending.keyword);
    }
  } catch (e) {
    // Server not running, ignore
  }
}

// ---------------------------------------------------------------------------
// Keepalive & polling via chrome.alarms (MV3 service worker safe)
// ---------------------------------------------------------------------------

// Use chrome.alarms to reliably wake the service worker
// Minimum alarm interval is 0.5 minutes in production, but we also use
// setInterval as a fallback when the worker is already awake.

chrome.alarms.create('pollSearches', { periodInMinutes: 0.5 });
chrome.alarms.create('keepAlive', { periodInMinutes: 0.25 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollSearches' || alarm.name === 'keepAlive') {
    pollForSearches();
  }
});

// Also use setInterval for faster polling while worker is awake (5s)
setInterval(pollForSearches, 5000);

// Poll immediately on install/start
chrome.runtime.onInstalled.addListener(() => {
  console.log('[scraper] Extension installed/updated');
  pollForSearches();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[scraper] Browser started');
  pollForSearches();
});

// Immediate poll
pollForSearches();

// ---------------------------------------------------------------------------
// Message handler for popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse(
      currentJob
        ? { active: true, ...currentJob }
        : { active: false }
    );
  }
  if (msg.type === 'forcePolls') {
    pollForSearches();
    sendResponse({ ok: true });
  }
  if (msg.type === 'newSearch') {
    console.log(`[scraper] Received newSearch from dashboard: "${msg.keyword}" (${msg.searchId})`);
    // Immediately start scraping if not busy
    if (!currentJob) {
      scrapeKeyword(msg.searchId, msg.keyword);
      sendResponse({ ok: true, started: true });
    } else {
      console.log(`[scraper] Already busy with "${currentJob.keyword}", will pick up "${msg.keyword}" after`);
      sendResponse({ ok: true, started: false, busy: true, currentKeyword: currentJob.keyword });
    }
  }
  if (msg.type === 'keepAlive') {
    sendResponse({
      alive: true,
      busy: !!currentJob,
      currentJob: currentJob ? { keyword: currentJob.keyword, scanned: currentJob.listingsScanned, shortlisted: currentJob.listingsShortlisted } : null,
    });
  }
  return true;
});
