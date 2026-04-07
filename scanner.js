#!/usr/bin/env node
/**
 * Etsy Scanner - Parallel multi-tab scanner using real Chrome with copied cookies
 * Usage: node scanner.js <searchId> <keyword>
 *
 * Scans 20 pages × ~64 listings = ~1280 listings in under 30 minutes
 * by using multiple browser tabs in parallel.
 */

const { execSync, spawn: spawnChild } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;
const SERVER_BASE = process.env.SERVER_BASE || 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
const MAX_PAGES = 20;
const PARALLEL_TABS = IS_RAILWAY ? 2 : 4; // Fewer tabs on Railway to conserve memory
const TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes hard timeout
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCANNER_PROFILE = path.join(os.homedir(), '.etsy-scraper-profile');
const CHROME_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const DEBUG_PORT = 9333;

function randomDelay(min = 500, max = 1500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

/**
 * Fetch Etsy search results via HTTP (no browser needed).
 * Uses Etsy's internal search API endpoint which returns JSON with listing data.
 * Falls back to scraping the HTML search page if the API doesn't work.
 * Returns array of listing URLs found on the page.
 */
async function fetchSearchPageHTTP(keyword, pageNum) {
  const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
  };

  // Strategy 1: Try Etsy's internal search API (returns JSON listing data)
  try {
    const apiUrl = `https://www.etsy.com/api/v3/ajax/bespoke/member/neu/specs/async_search_results?q=${encodeURIComponent(keyword)}&page=${pageNum}&ref=search_bar`;
    log(`[HTTP] Trying Etsy internal API for page ${pageNum}`);
    const resp = await fetch(apiUrl, {
      headers: {
        ...COMMON_HEADERS,
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${pageNum}`,
      },
      redirect: 'follow',
    });
    if (resp.ok) {
      const text = await resp.text();
      // Extract listing IDs from the JSON/HTML response
      const seenIds = new Set();
      const urls = [];
      const regex = /listing\/(\d+)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const id = match[1];
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        urls.push(`https://www.etsy.com/listing/${id}/`);
      }
      if (urls.length > 0) {
        log(`[HTTP] Internal API page ${pageNum}: found ${urls.length} listings`);
        return urls;
      }
    } else {
      log(`[HTTP] Internal API returned ${resp.status}`);
    }
  } catch (err) {
    log(`[HTTP] Internal API error: ${err.message}`);
  }

  // Strategy 2: Try the regular search page HTML
  try {
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${pageNum}`;
    log(`[HTTP] Trying regular search page ${pageNum}`);
    const resp = await fetch(url, {
      headers: {
        ...COMMON_HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    if (resp.ok) {
      const html = await resp.text();
      if (!html.includes('captcha-delivery') && !html.includes('Verification Required')) {
        const seenIds = new Set();
        const urls = [];
        const regex = /https:\/\/www\.etsy\.com\/(?:[\w-]+\/)?listing\/(\d+)\/[^"'\s?#]*/g;
        let match2;
        while ((match2 = regex.exec(html)) !== null) {
          if (seenIds.has(match2[1])) continue;
          seenIds.add(match2[1]);
          urls.push(match2[0]);
        }
        log(`[HTTP] HTML page ${pageNum}: found ${urls.length} listings`);
        if (urls.length > 0) return urls;
      } else {
        log(`[HTTP] Search page ${pageNum} blocked by CAPTCHA`);
      }
    } else {
      log(`[HTTP] Search page ${pageNum} returned status ${resp.status}`);
    }
  } catch (err) {
    log(`[HTTP] HTML page error: ${err.message}`);
  }

  // Strategy 3: Use DuckDuckGo HTML search as a proxy to find Etsy listings
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=site%3Aetsy.com+${encodeURIComponent(keyword)}&s=${(pageNum - 1) * 30}`;
    log(`[HTTP] Trying DuckDuckGo for page ${pageNum}`);
    const resp = await fetch(ddgUrl, {
      headers: {
        ...COMMON_HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (resp.ok) {
      const html = await resp.text();
      const seenIds = new Set();
      const urls = [];
      const regex = /https?:\/\/(?:www\.)?etsy\.com\/(?:[\w-]+\/)?listing\/(\d+)/g;
      let match3;
      while ((match3 = regex.exec(html)) !== null) {
        if (seenIds.has(match3[1])) continue;
        seenIds.add(match3[1]);
        urls.push(`https://www.etsy.com/listing/${match3[1]}/`);
      }
      if (urls.length > 0) {
        log(`[HTTP] DuckDuckGo page ${pageNum}: found ${urls.length} listings`);
        return urls;
      }
    } else {
      log(`[HTTP] DuckDuckGo returned ${resp.status}`);
    }
  } catch (err) {
    log(`[HTTP] DuckDuckGo error: ${err.message}`);
  }

  log(`[HTTP] All HTTP strategies failed for page ${pageNum}`);
  return null;
}

function log(...args) {
  console.log(`[scanner ${new Date().toISOString()}]`, ...args);
}

async function reportListing(searchId, listing) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/searches/${searchId}/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(listing),
    });
    if (!res.ok) log('Warning: failed to report listing:', res.status);
    return await res.json();
  } catch (err) {
    log('Error reporting listing:', err.message);
    return null;
  }
}

async function updateProgress(searchId, fields) {
  try {
    const res = await fetch(`${SERVER_BASE}/api/searches/${searchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      log('Warning: updateProgress got status', res.status);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    log('Error updating progress:', err.message);
    return null;
  }
}

function prepareProfile() {
  // Clone the entire Default profile from real Chrome to get ALL data:
  // cookies, local storage, IndexedDB, DataDome tokens, etc.
  // A cookie-only copy gets flagged by DataDome because it's missing
  // the bot protection tokens stored in local storage/IndexedDB.
  try {
    const srcDefault = path.join(CHROME_PROFILE, 'Default');
    const dstDefault = path.join(SCANNER_PROFILE, 'Default');

    // Only re-clone if the profile is older than 5 minutes or doesn't exist
    const needsClone = !fs.existsSync(dstDefault) ||
      (Date.now() - fs.statSync(dstDefault).mtimeMs > 5 * 60 * 1000);

    if (needsClone) {
      log('Cloning full Chrome profile (cookies + local storage + DataDome tokens)...');
      fs.mkdirSync(SCANNER_PROFILE, { recursive: true });
      // Remove old clone
      try { execSync(`rm -rf "${dstDefault}"`, { stdio: 'ignore' }); } catch {}
      // Copy the entire Default profile directory
      execSync(`cp -R "${srcDefault}" "${dstDefault}"`);
      // Also copy Local State (needed for cookie decryption)
      const lsSrc = path.join(CHROME_PROFILE, 'Local State');
      const lsDst = path.join(SCANNER_PROFILE, 'Local State');
      if (fs.existsSync(lsSrc)) execSync(`cp "${lsSrc}" "${lsDst}"`);
      log('Profile clone complete');
    } else {
      log('Using existing profile clone (less than 5 min old)');
    }

    // Remove singleton locks
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(SCANNER_PROFILE, f)); } catch {}
    }
  } catch (err) {
    log('Warning: could not clone profile:', err.message);
  }
}

async function launchChromeWithDebugPort() {
  try {
    execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1000));

  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${SCANNER_PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-popup-blocking', '--window-size=1920,1080',
    '--window-position=50,50', '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync', '--disable-translate', '--metrics-recording-only',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];

  log('Launching Chrome with debug port', DEBUG_PORT);
  const chrome = spawnChild(CHROME_PATH, chromeArgs, { stdio: 'ignore', detached: true });
  chrome.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const resp = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
      if (resp.ok) {
        const data = await resp.json();
        log('Chrome started, wsUrl:', data.webSocketDebuggerUrl);
        return { chrome, wsUrl: data.webSocketDebuggerUrl };
      }
    } catch {}
  }
  throw new Error('Chrome failed to start with debug port');
}

/**
 * Check a single listing page for sales signals.
 * Returns { soldCount, title, price, imageUrl } or null.
 */
async function checkListing(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Short wait for urgency signals to render via JS API call
    await new Promise(r => setTimeout(r, 1500));

    // Check for block
    const blocked = await page.evaluate(() => {
      const html = document.documentElement.innerHTML || '';
      if (html.includes('captcha-delivery')) return true;
      if (document.body && document.body.innerText.includes('Verification Required')) return true;
      return false;
    });
    if (blocked) return { blocked: true };

    // Check for sales signals ONLY in the urgency signal element.
    // The urgency signal lives inside #listing-page-cart in a component called
    // "Etsy-Modules-ListingPage-UrgencySignal-RecsRankingApiSpec"
    // It renders as a <p> inside a .recs-appears-logger div.
    //
    // CRITICAL: We match ONLY against the urgency signal element's own text.
    // We do NOT fall back to scanning buy box text, because #listing-page-cart
    // also contains "recommends this bundle" sections with OTHER products'
    // urgency signals, which cause false positives.
    //
    // Etsy urgency signal types (only first two are actual sales):
    //   "In demand. X people bought this in the last 24 hours."
    //   "X sold in last 24 hours"
    //   "In X baskets" (NOT sales)
    //   "X+ views in the last 24 hours" (NOT sales)
    return await page.evaluate(() => {
      // Find the urgency signal element — it's always the FIRST <p> in the
      // recs-appears-logger inside the buy box
      const urgencyEl = document.querySelector('#listing-page-cart .recs-appears-logger p') ||
                        document.querySelector('#listing-page-cart [data-appears-component-name*="UrgencySignal"] p') ||
                        document.querySelector('#listing-page-cart p.wt-sem-text-critical');

      if (!urgencyEl) return null;

      const urgencyText = urgencyEl.innerText.trim();

      // Match ONLY actual sales patterns — NOT baskets, NOT views
      const salesPatterns = [
        /(\d+)\s+sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
        /(\d+)\s+people\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours/i,
        /(\d+)\s+sold\s+recently/i,
      ];

      let soldCount = 0;
      let matchText = '';
      for (const p of salesPatterns) {
        const m = urgencyText.match(p);
        if (m) { soldCount = parseInt(m[1]); matchText = m[0]; break; }
      }

      if (!soldCount) return null;

      const titleEl = document.querySelector('h1');
      const priceEl = document.querySelector('[data-buy-box-listing-price] p') ||
                      document.querySelector('.wt-text-title-larger');
      const imgEl = document.querySelector('[data-component="listing-page-image-carousel"] img') ||
                    document.querySelector('.image-carousel-container img') ||
                    document.querySelector('img.wt-max-width-full');
      return {
        soldCount,
        matchText,
        urgencyText,
        title: titleEl ? titleEl.innerText.trim() : document.title,
        price: priceEl ? priceEl.innerText.trim() : '',
        imageUrl: imgEl ? imgEl.src : null,
      };
    });
  } catch (err) {
    return null; // Navigation error, skip listing
  }
}

async function launchBrowser() {
  if (IS_RAILWAY) {
    log('Railway environment detected — launching headless Chromium with stealth');
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    if (execPath) log('Using Chromium at:', execPath);
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: execPath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--disable-extensions', '--disable-sync',
        '--no-first-run', '--window-size=1920,1080',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-US,en',
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });
    return { browser, isLocal: false };
  } else {
    log('Local environment — launching real Chrome with full profile');
    prepareProfile();
    const { chrome, wsUrl } = await launchChromeWithDebugPort();
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: { width: 1920, height: 1080 },
    });
    return { browser, isLocal: true };
  }
}

async function run(searchId, keyword) {
  log(`Starting scan for search=${searchId}, keyword="${keyword}"`);
  log(`Environment: ${IS_RAILWAY ? 'Railway' : 'Local'}`);
  log(`Settings: MAX_PAGES=${MAX_PAGES}, PARALLEL_TABS=${PARALLEL_TABS}, TIMEOUT=${TIMEOUT_MS/1000/60}min`);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  let browser, isLocal;
  try {
    const result = await launchBrowser();
    browser = result.browser;
    isLocal = result.isLocal;
  } catch (err) {
    log('Failed to launch browser:', err.message);
    await updateProgress(searchId, { status: 'error' });
    return;
  }

  let totalListingsScanned = 0;
  let totalShortlisted = 0;
  let consecutiveBlocks = 0;
  let pagesCompleted = 0;
  const reportedListingIds = new Set(); // Track reported listing IDs to prevent duplicates
  const startTime = Date.now();

  const REALISTIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  async function setupPage(page) {
    await page.setViewport({ width: 1920, height: 1080 });
    if (IS_RAILWAY) {
      await page.setUserAgent(REALISTIC_UA);
      await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      });
    }
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // Override plugins to look real
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      // Fake Chrome runtime
      window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){} };
    });
  }

  try {
    // Create the search results page (used to navigate search pages)
    const searchPage = await browser.newPage();
    await setupPage(searchPage);

    // Create parallel listing checker tabs
    const listingPages = [];
    for (let i = 0; i < PARALLEL_TABS; i++) {
      const p = await browser.newPage();
      await setupPage(p);
      listingPages.push(p);
    }

    await updateProgress(searchId, { status: 'running', total_pages: MAX_PAGES });

    if (!IS_RAILWAY) {
      // Pre-flight: navigate to Etsy homepage first to warm up cookies/session (local only)
      log('Pre-flight: loading Etsy homepage to establish session...');
      try {
        await searchPage.goto('https://www.etsy.com/', { waitUntil: 'networkidle2', timeout: 20000 });
        await randomDelay(2000, 4000);
        const homeBlocked = await searchPage.evaluate(() => {
          const html = document.documentElement.innerHTML || '';
          return html.includes('captcha-delivery') || html.includes('geo.captcha-delivery');
        });
        if (homeBlocked) {
          log('WARNING: Etsy homepage blocked by CAPTCHA. Waiting 60s for manual solve...');
          await new Promise(r => setTimeout(r, 60000));
        } else {
          log('Pre-flight OK - Etsy homepage loaded successfully');
        }
      } catch (err) {
        log('Pre-flight warning:', err.message);
      }
    } else {
      // Railway mode: quick connectivity test before starting
      log('Railway mode: testing Etsy accessibility...');
      try {
        const testResp = await fetch('https://www.etsy.com/', {
          headers: { 'User-Agent': REALISTIC_UA },
          redirect: 'follow',
        });
        if (testResp.status === 403) {
          const body = await testResp.text();
          if (body.includes('captcha-delivery') || body.includes("var dd=")) {
            log('Etsy is BLOCKED from this server IP (DataDome protection)');
            log('Server-side scanning not possible. Search remains in "running" state for Chrome extension to pick up.');
            log('Install the Chrome extension and open the dashboard to start scanning from your browser.');
            try { await browser.close(); } catch {}
            return;
          }
        } else if (testResp.ok) {
          log('Etsy is accessible from this server! Proceeding with server-side scan.');
        }
      } catch (err) {
        log('Etsy connectivity test failed:', err.message);
        log('Server-side scanning not possible. Search remains in "running" state for Chrome extension.');
        try { await browser.close(); } catch {}
        return;
      }
    }

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        log('Timeout reached');
        break;
      }

      let listingUrls;

      if (IS_RAILWAY) {
        // On Railway: try HTTP fetch first, then browser as fallback
        listingUrls = await fetchSearchPageHTTP(keyword, pageNum);
        if (!listingUrls) {
          // Fallback: try browser with stealth
          log(`HTTP fetch failed for page ${pageNum}, trying browser fallback...`);
          try {
            const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${pageNum}`;
            await searchPage.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await randomDelay(1000, 2000);
            const blocked = await searchPage.evaluate(() => {
              const html = document.documentElement.innerHTML || '';
              if (html.includes('captcha-delivery') || html.includes('geo.captcha-delivery')) return true;
              return false;
            });
            if (!blocked) {
              listingUrls = await searchPage.evaluate(() => {
                const seenIds = new Set();
                const urls = [];
                for (const a of document.querySelectorAll('a[href*="/listing/"]')) {
                  const idMatch = a.href.match(/listing\/(\d+)/);
                  if (!idMatch) continue;
                  if (seenIds.has(idMatch[1])) continue;
                  seenIds.add(idMatch[1]);
                  const urlMatch = a.href.match(/(https:\/\/www\.etsy\.com\/(?:[\w-]+\/)?listing\/\d+\/[^?#]*)/);
                  if (urlMatch) urls.push(urlMatch[1]);
                }
                return urls;
              });
              log(`Browser fallback page ${pageNum}: found ${listingUrls.length} listings`);
            } else {
              log(`Browser fallback also blocked on page ${pageNum}`);
            }
          } catch (err) {
            log(`Browser fallback error: ${err.message}`);
          }
        }
        if (!listingUrls || listingUrls.length === 0) {
          consecutiveBlocks++;
          log(`Search page ${pageNum} failed all strategies, consecutive: ${consecutiveBlocks}`);
          if (consecutiveBlocks >= 4) {
            log('Too many consecutive failures, giving up');
            await updateProgress(searchId, { status: 'blocked' });
            break;
          }
          await randomDelay(5000, 10000);
          pageNum--;
          continue;
        }
        consecutiveBlocks = 0;
      } else {
        // Local mode: use browser for search pages
        const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${pageNum}`;
        log(`Scanning page ${pageNum}/${MAX_PAGES}: ${searchUrl}`);

        try {
          await searchPage.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await randomDelay(1000, 2000);

          const blocked = await searchPage.evaluate(() => {
            const html = document.documentElement.innerHTML || '';
            const body = document.body ? document.body.innerText : '';
            if (html.includes('captcha-delivery') || html.includes('geo.captcha-delivery')) return 'captcha';
            if (body.includes('Verification Required')) return 'verification';
            if (body.includes('Slide right to secure')) return 'slider';
            return null;
          });

          if (blocked) {
            consecutiveBlocks++;
            log(`Blocked on search page ${pageNum} (${blocked}), consecutive: ${consecutiveBlocks}`);
            if (consecutiveBlocks >= 3) {
              log('CAPTCHA persisting — IP may be temporarily flagged. Try again in 15-30 min.');
              await updateProgress(searchId, { status: 'blocked' });
              break;
            }
            const waitMs = Math.min(60000 + consecutiveBlocks * 30000, 120000);
            log(`Waiting ${waitMs/1000}s before retry...`);
            await new Promise(r => setTimeout(r, waitMs));
            pageNum--;
            continue;
          }
          consecutiveBlocks = 0;

          listingUrls = await searchPage.evaluate(() => {
            const seenIds = new Set();
            const urls = [];
            for (const a of document.querySelectorAll('a[href*="/listing/"]')) {
              const idMatch = a.href.match(/listing\/(\d+)/);
              if (!idMatch) continue;
              const listingId = idMatch[1];
              if (seenIds.has(listingId)) continue;
              seenIds.add(listingId);
              const urlMatch = a.href.match(/(https:\/\/www\.etsy\.com\/(?:[\w-]+\/)?listing\/\d+\/[^?#]*)/);
              if (urlMatch) urls.push(urlMatch[1]);
            }
            return urls;
          });
        } catch (pageErr) {
          log(`Error loading search page ${pageNum}: ${pageErr.message}`);
          continue;
        }
      }

      log(`Page ${pageNum}: ${listingUrls.length} listings`);

      if (listingUrls.length === 0) {
        if (!IS_RAILWAY) {
          const debugPath = path.join(SCREENSHOT_DIR, `debug_page${pageNum}.png`);
          await searchPage.screenshot({ path: debugPath });
        }
        if (pageNum === 1) {
          await updateProgress(searchId, { status: 'blocked' });
          break;
        }
        break;
      }

      // Process listings in parallel batches
      try {
        for (let batchStart = 0; batchStart < listingUrls.length; batchStart += PARALLEL_TABS) {
          if (Date.now() - startTime > TIMEOUT_MS) break;

          const batch = listingUrls.slice(batchStart, batchStart + PARALLEL_TABS);

          // Small stagger between parallel requests to avoid triggering rate limits
          const results = await Promise.all(
            batch.map((url, idx) =>
              new Promise(resolve => {
                // Stagger each tab by 300ms
                setTimeout(async () => {
                  const result = await checkListing(listingPages[idx], url);
                  resolve({ url, result });
                }, idx * 300);
              })
            )
          );

          // Process results
          for (const { url, result } of results) {
            totalListingsScanned++;

            if (result && result.blocked) {
              consecutiveBlocks++;
              if (consecutiveBlocks >= 5) {
                log('Too many blocks on listings, stopping');
                await updateProgress(searchId, { status: 'blocked' });
                pageNum = MAX_PAGES + 1;
                break;
              }
              continue;
            }
            if (result && result.blocked) continue;
            consecutiveBlocks = 0;

            if (result && result.soldCount > 0) {
              // Deduplicate — Etsy shows the same listing on multiple search pages
              const listingId = (url.match(/listing\/(\d+)/) || [])[1];
              if (listingId && reportedListingIds.has(listingId)) {
                continue; // Already reported this listing
              }
              if (listingId) reportedListingIds.add(listingId);

              totalShortlisted++;
              log(`SHORTLISTED [${totalShortlisted}]: "${result.title.substring(0, 60)}" - ${result.soldCount} sold`);

              // Take screenshot using the tab that found it
              const tabIdx = results.findIndex(r => r.url === url);
              const tabPage = listingPages[tabIdx >= 0 && tabIdx < PARALLEL_TABS ? tabIdx : 0];

              const etsyId = (url.match(/listing\/(\d+)/) || [])[1] || Date.now().toString();
              const ssFilename = `listing_${etsyId}.png`;
              const ssPath = path.join(SCREENSHOT_DIR, ssFilename);

              try {
                await tabPage.evaluate(() => window.scrollTo(0, 0));
                await new Promise(r => setTimeout(r, 300));
                await tabPage.screenshot({ path: ssPath });
              } catch {}

              let ssDataUrl = null;
              try {
                const buf = fs.readFileSync(ssPath);
                ssDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
              } catch {}

              await reportListing(searchId, {
                title: result.title,
                price: result.price,
                url,
                soldCount: result.soldCount,
                matchText: result.matchText,
                screenshotDataUrl: ssDataUrl,
                imageUrl: result.imageUrl,
              });
            }
          }

          if (pageNum > MAX_PAGES) break;

          // Brief delay between batches
          await randomDelay(300, 800);
        }

        pagesCompleted = pageNum;
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const rate = totalListingsScanned > 0 ? (totalListingsScanned / ((Date.now() - startTime) / 1000)).toFixed(2) : '0';
        log(`Page ${pageNum} done. Total: ${totalListingsScanned} scanned, ${totalShortlisted} shortlisted. ${elapsed}min elapsed, ${rate} listings/sec`);

        await updateProgress(searchId, {
          pages_scanned: pageNum,
          listings_scanned: totalListingsScanned,
          listings_shortlisted: totalShortlisted,
        });

        // Short delay between search pages
        await randomDelay(1500, 3000);
      } catch (pageErr) {
        log(`Error on page ${pageNum}: ${pageErr.message}`);
        await updateProgress(searchId, { pages_scanned: pageNum });
      }
    }

    const finalStatus = consecutiveBlocks >= 5 ? 'blocked' : 'success';
    await updateProgress(searchId, {
      status: finalStatus,
      pages_scanned: pagesCompleted,
      listings_scanned: totalListingsScanned,
      listings_shortlisted: totalShortlisted,
    });

    const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    log(`COMPLETE. Status: ${finalStatus}. Pages: ${pagesCompleted}/${MAX_PAGES}. Scanned: ${totalListingsScanned}. Shortlisted: ${totalShortlisted}. Time: ${totalTime}min`);

  } catch (err) {
    log('Fatal error:', err.message, err.stack);
    await updateProgress(searchId, { status: 'error' });
  } finally {
    try {
      if (isLocal) {
        await browser.disconnect();
        execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
      } else {
        await browser.close();
      }
    } catch {}
  }
}

const [,, searchId, ...keywordParts] = process.argv;
const keyword = keywordParts.join(' ');

if (!searchId || !keyword) {
  console.error('Usage: node scanner.js <searchId> <keyword>');
  process.exit(1);
}

run(searchId, keyword).catch(err => {
  console.error('Scanner failed:', err);
  process.exit(1);
});
