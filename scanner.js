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

const SERVER_BASE = 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
const MAX_PAGES = 20;
const PARALLEL_TABS = 4; // Number of tabs scanning listings concurrently
const TIMEOUT_MS = 35 * 60 * 1000; // 35 minutes hard timeout
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCANNER_PROFILE = path.join(os.homedir(), '.etsy-scraper-profile');
const CHROME_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const DEBUG_PORT = 9333;

function randomDelay(min = 500, max = 1500) {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
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
    await fetch(`${SERVER_BASE}/api/searches/${searchId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
  } catch (err) {
    log('Error updating progress:', err.message);
  }
}

function copyCookies() {
  try {
    fs.mkdirSync(path.join(SCANNER_PROFILE, 'Default'), { recursive: true });
    const src = path.join(CHROME_PROFILE, 'Default', 'Cookies');
    const dst = path.join(SCANNER_PROFILE, 'Default', 'Cookies');
    if (fs.existsSync(src)) {
      // Use shell cp instead of fs.copyFileSync because Chrome uses SQLite WAL mode
      // and copyFileSync may miss pending WAL writes, producing a truncated/corrupt copy
      try { fs.unlinkSync(dst); } catch {}
      execSync(`cp "${src}" "${dst}"`);
      const srcSize = fs.statSync(src).size;
      const dstSize = fs.statSync(dst).size;
      log(`Copied Chrome cookies to scanner profile (${srcSize} -> ${dstSize} bytes)`);
      if (dstSize < srcSize * 0.5) {
        log('WARNING: Cookie copy may be truncated!');
      }
    }
    const lsSrc = path.join(CHROME_PROFILE, 'Local State');
    const lsDst = path.join(SCANNER_PROFILE, 'Local State');
    if (fs.existsSync(lsSrc)) execSync(`cp "${lsSrc}" "${lsDst}"`);
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(SCANNER_PROFILE, f)); } catch {}
    }
  } catch (err) {
    log('Warning: could not copy cookies:', err.message);
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

async function run(searchId, keyword) {
  log(`Starting scan for search=${searchId}, keyword="${keyword}"`);
  log(`Settings: MAX_PAGES=${MAX_PAGES}, PARALLEL_TABS=${PARALLEL_TABS}, TIMEOUT=${TIMEOUT_MS/1000/60}min`);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  copyCookies();

  const { chrome, wsUrl } = await launchChromeWithDebugPort();

  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: { width: 1920, height: 1080 },
    });
  } catch (err) {
    log('Failed to connect to Chrome:', err.message);
    await updateProgress(searchId, { status: 'error' });
    return;
  }

  let totalListingsScanned = 0;
  let totalShortlisted = 0;
  let consecutiveBlocks = 0;
  let pagesCompleted = 0;
  const startTime = Date.now();

  try {
    // Create the search results page (used to navigate search pages)
    const searchPage = await browser.newPage();
    await searchPage.setViewport({ width: 1920, height: 1080 });
    await searchPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Create parallel listing checker tabs
    const listingPages = [];
    for (let i = 0; i < PARALLEL_TABS; i++) {
      const p = await browser.newPage();
      await p.setViewport({ width: 1920, height: 1080 });
      await p.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      listingPages.push(p);
    }

    await updateProgress(searchId, { status: 'running', total_pages: MAX_PAGES });

    // Pre-flight: navigate to Etsy homepage first to warm up cookies/session
    log('Pre-flight: loading Etsy homepage to establish session...');
    try {
      await searchPage.goto('https://www.etsy.com/', { waitUntil: 'networkidle2', timeout: 20000 });
      await randomDelay(2000, 4000);
      // Check if homepage is blocked
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

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (Date.now() - startTime > TIMEOUT_MS) {
        log('Timeout reached');
        break;
      }

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${pageNum}`;
      log(`Scanning page ${pageNum}/${MAX_PAGES}: ${searchUrl}`);

      try {
        await searchPage.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await randomDelay(1000, 2000);

        // Check for blocking
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
          if (consecutiveBlocks >= 6) {
            log('Too many consecutive blocks, giving up');
            await updateProgress(searchId, { status: 'blocked' });
            break;
          }
          // Wait longer each time — give user a chance to solve CAPTCHA manually
          // in the visible Chrome window
          const waitMs = Math.min(30000 + consecutiveBlocks * 15000, 90000);
          log(`Waiting ${waitMs/1000}s before retry (solve CAPTCHA in the Chrome window if visible)...`);
          await new Promise(r => setTimeout(r, waitMs));
          pageNum--;
          continue;
        }
        consecutiveBlocks = 0;

        // Extract ALL listing URLs from the search page, deduplicated by listing ID
        const listingUrls = await searchPage.evaluate(() => {
          const seenIds = new Set();
          const urls = [];
          for (const a of document.querySelectorAll('a[href*="/listing/"]')) {
            const idMatch = a.href.match(/listing\/(\d+)/);
            if (!idMatch) continue;
            const listingId = idMatch[1];
            if (seenIds.has(listingId)) continue;
            seenIds.add(listingId);
            // Use the full URL for navigation
            const urlMatch = a.href.match(/(https:\/\/www\.etsy\.com\/(?:[\w-]+\/)?listing\/\d+\/[^?#]*)/);
            if (urlMatch) urls.push(urlMatch[1]);
          }
          return urls;
        });

        log(`Page ${pageNum}: ${listingUrls.length} listings`);

        if (listingUrls.length === 0) {
          const debugPath = path.join(SCREENSHOT_DIR, `debug_page${pageNum}.png`);
          await searchPage.screenshot({ path: debugPath });
          if (pageNum === 1) {
            await updateProgress(searchId, { status: 'blocked' });
            break;
          }
          break;
        }

        // Process listings in parallel batches
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
    try { await browser.disconnect(); } catch {}
    try {
      execSync(`lsof -ti:${DEBUG_PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' });
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
