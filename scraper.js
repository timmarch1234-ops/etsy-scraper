const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
const MAX_PAGES = 20;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_ROTATION_INTERVAL = Math.floor(Math.random() * 3) + 3; // 3-5 pages
const MAX_CONSECUTIVE_BLOCKS = 3;

// ---------------------------------------------------------------------------
// User-agent pool (15+ real Chrome UA strings for macOS / Windows / Linux)
// ---------------------------------------------------------------------------

const USER_AGENTS = [
  // macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  // Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  // Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1280, height: 800 },
  { width: 2560, height: 1440 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomDelay(minSec, maxSec) {
  const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  console.log(`[scraper ${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Browser lifecycle
// ---------------------------------------------------------------------------

async function launchBrowser() {
  const ua = pick(USER_AGENTS);
  const vp = pick(VIEWPORTS);

  log(`Launching browser  UA=${ua.slice(0, 60)}...  viewport=${vp.width}x${vp.height}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--window-size=${vp.width},${vp.height}`,
    ],
  });

  const page = await browser.newPage();

  // viewport
  await page.setViewport(vp);

  // user-agent
  await page.setUserAgent(ua);

  // realistic headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });

  // override navigator.webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return { browser, page, userAgent: ua, viewport: vp };
}

// ---------------------------------------------------------------------------
// Mouse movement simulation
// ---------------------------------------------------------------------------

async function simulateMouseMovement(page) {
  try {
    const vp = page.viewport();
    const steps = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < steps; i++) {
      const x = Math.floor(Math.random() * (vp.width - 100)) + 50;
      const y = Math.floor(Math.random() * (vp.height - 100)) + 50;
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
      await randomDelay(0.1, 0.3);
    }
  } catch {
    // non-critical
  }
}

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

function isBlocked(pageContent, status) {
  if (status === 403 || status === 429) return true;
  const lower = (pageContent || '').toLowerCase();
  if (lower.includes('captcha')) return true;
  if (lower.includes('access denied')) return true;
  if (lower.includes('rate limit')) return true;
  if (lower.includes('please verify') && lower.includes('human')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Extract listing URLs from search results page
// ---------------------------------------------------------------------------

async function extractListingUrls(page) {
  try {
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/listing/"]'));
      const urls = new Set();
      for (const link of links) {
        const href = link.href;
        if (href && href.includes('etsy.com/listing/')) {
          // Normalise: strip query params to deduplicate
          try {
            const u = new URL(href);
            urls.add(`${u.origin}${u.pathname}`);
          } catch {
            urls.add(href);
          }
        }
      }
      return [...urls];
    });
  } catch (err) {
    log(`Error extracting listing URLs: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Inspect a single listing for recent-sales indicators
// ---------------------------------------------------------------------------

async function inspectListing(browser, url) {
  let listingPage;
  try {
    listingPage = await browser.newPage();

    // Inherit the same anti-detection overrides
    await listingPage.setUserAgent(pick(USER_AGENTS));
    await listingPage.setViewport(pick(VIEWPORTS));
    await listingPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    });
    await listingPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await simulateMouseMovement(listingPage);

    const response = await listingPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const status = response ? response.status() : 0;
    const bodyText = await listingPage.evaluate(() => document.body ? document.body.innerText : '');

    if (isBlocked(bodyText, status)) {
      await listingPage.close();
      return { blocked: true };
    }

    await randomDelay(1, 2);

    // Look for recent sales text patterns
    const salesData = await listingPage.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      // Patterns: "X sold in the last 24 hours", "X sold recently", "In X+ carts", etc.
      const patterns = [
        /(\d+)\s+sold\s+in\s+(?:the\s+)?last\s+24\s+hours/i,
        /(\d+)\s+sold\s+recently/i,
        /(\d+)\s+people\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours/i,
        /(\d+)\s+sales?\s+in\s+the\s+last\s+24\s+hours/i,
        /Bestseller/i,
      ];

      for (const pat of patterns) {
        const m = body.match(pat);
        if (m) {
          const count = m[1] ? parseInt(m[1], 10) : 0;
          return { found: true, text: m[0], soldCount: count };
        }
      }
      return { found: false };
    });

    if (!salesData.found) {
      await listingPage.close();
      return { found: false };
    }

    // Extract title and price
    const meta = await listingPage.evaluate(() => {
      const titleEl = document.querySelector('h1');
      const title = titleEl ? titleEl.innerText.trim() : document.title;

      // Price can live in various selectors
      let price = '';
      const priceEl = document.querySelector('[data-buy-box-listing-price] p') ||
        document.querySelector('.wt-text-title-larger') ||
        document.querySelector('[data-selector="price"]') ||
        document.querySelector('p[class*="price"]');
      if (priceEl) price = priceEl.innerText.trim();

      return { title, price };
    });

    // Scroll the sales indicator into view so the screenshot captures it
    await listingPage.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const patterns = [/sold in.*?24 hours/i, /sold recently/i, /bought this in/i, /Bestseller/i];
      while (walker.nextNode()) {
        const txt = walker.currentNode.textContent;
        for (const pat of patterns) {
          if (pat.test(txt)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              // Scroll so element is near the top — leave room for product image above
              const rect = el.getBoundingClientRect();
              window.scrollBy(0, rect.top - 200);
              return;
            }
          }
        }
      }
      // Fallback: scroll to top area where product image + info live
      window.scrollTo(0, 0);
    });

    await randomDelay(0.5, 1);

    // Take screenshot
    const screenshotId = uuidv4();
    const screenshotPath = path.join(SCREENSHOT_DIR, `${screenshotId}.png`);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await listingPage.screenshot({ path: screenshotPath, fullPage: false });

    await listingPage.close();

    return {
      found: true,
      title: meta.title,
      price: meta.price,
      url,
      soldCount: salesData.soldCount,
      screenshotPath,
    };
  } catch (err) {
    log(`Error inspecting listing ${url}: ${err.message}`);
    try { if (listingPage) await listingPage.close(); } catch { /* ignore */ }
    return { found: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function scrapeKeyword(keyword, callbacks = {}) {
  const { onProgress, onListing, onComplete, onError } = callbacks;
  const startTime = Date.now();

  let pagesScanned = 0;
  let listingsScanned = 0;
  let listingsShortlisted = 0;
  let consecutiveBlocks = 0;

  // Build randomized page order (1 .. MAX_PAGES)
  const pageNumbers = shuffle(Array.from({ length: MAX_PAGES }, (_, i) => i + 1));

  let browser = null;
  let mainPage = null;
  let pagesSinceRotation = 0;
  const sessionRotateEvery = Math.floor(Math.random() * 3) + 3; // 3-5

  // Helper: ensure browser is running
  async function ensureBrowser() {
    if (!browser) {
      const session = await launchBrowser();
      browser = session.browser;
      mainPage = session.page;
      pagesSinceRotation = 0;
    }
  }

  // Helper: close browser safely
  async function closeBrowser() {
    try {
      if (browser) await browser.close();
    } catch { /* ignore */ }
    browser = null;
    mainPage = null;
  }

  // Helper: handle block — wait, reopen
  async function handleBlock() {
    consecutiveBlocks++;
    log(`Block detected (${consecutiveBlocks}/${MAX_CONSECUTIVE_BLOCKS}). Cooling down...`);
    await closeBrowser();
    if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) return false;
    const cooldown = (Math.random() * 30 + 30) * 1000; // 30-60 s
    log(`Waiting ${(cooldown / 1000).toFixed(0)}s before retrying...`);
    await new Promise((r) => setTimeout(r, cooldown));
    return true;
  }

  try {
    for (const pageNum of pageNumbers) {
      // Timeout guard
      if (Date.now() - startTime > MAX_DURATION_MS) {
        log('30-minute timeout reached. Aborting.');
        break;
      }

      // Session rotation
      if (pagesSinceRotation >= sessionRotateEvery) {
        log('Rotating browser session...');
        await closeBrowser();
      }

      await ensureBrowser();

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${pageNum}`;
      log(`Scraping search page ${pageNum} — ${searchUrl}`);

      try {
        await simulateMouseMovement(mainPage);
        const response = await mainPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = response ? response.status() : 0;
        const bodyText = await mainPage.evaluate(() => document.body ? document.body.innerText : '');

        if (isBlocked(bodyText, status)) {
          const canContinue = await handleBlock();
          if (!canContinue) {
            if (onComplete) onComplete({ status: 'blocked', pagesScanned, listingsScanned, listingsShortlisted });
            return;
          }
          // Retry this page
          pageNumbers.push(pageNum);
          continue;
        }

        consecutiveBlocks = 0; // successful load resets counter
        await randomDelay(2, 4);

        // Extract listing links
        const listingUrls = await extractListingUrls(mainPage);
        log(`Page ${pageNum}: found ${listingUrls.length} listings`);

        // Visit each listing
        for (const listingUrl of listingUrls) {
          if (Date.now() - startTime > MAX_DURATION_MS) break;

          await randomDelay(1, 3);
          listingsScanned++;

          const result = await inspectListing(browser, listingUrl);

          if (result.blocked) {
            const canContinue = await handleBlock();
            if (!canContinue) {
              if (onComplete) onComplete({ status: 'blocked', pagesScanned, listingsScanned, listingsShortlisted });
              return;
            }
            await ensureBrowser();
            continue;
          }

          if (result.found && result.screenshotPath) {
            listingsShortlisted++;
            log(`SHORTLISTED: "${result.title}" — ${result.soldCount} sold — ${listingUrl}`);
            if (onListing) {
              try {
                onListing({
                  title: result.title,
                  price: result.price,
                  url: result.url,
                  soldCount: result.soldCount,
                  screenshotPath: result.screenshotPath,
                });
              } catch (cbErr) {
                log(`onListing callback error: ${cbErr.message}`);
              }
            }
          }
        }

        pagesScanned++;
        pagesSinceRotation++;

        if (onProgress) {
          try {
            onProgress({ pagesScanned, listingsScanned, listingsShortlisted });
          } catch (cbErr) {
            log(`onProgress callback error: ${cbErr.message}`);
          }
        }

        await randomDelay(2, 6);
      } catch (pageErr) {
        log(`Error on search page ${pageNum}: ${pageErr.message}`);
        // Treat navigation errors as possible blocks
        const canContinue = await handleBlock();
        if (!canContinue) {
          if (onComplete) onComplete({ status: 'blocked', pagesScanned, listingsScanned, listingsShortlisted });
          return;
        }
        continue;
      }
    }

    log(`Scrape complete. Pages: ${pagesScanned}, Listings: ${listingsScanned}, Shortlisted: ${listingsShortlisted}`);
    if (onComplete) {
      onComplete({ status: 'complete', pagesScanned, listingsScanned, listingsShortlisted });
    }
  } catch (fatalErr) {
    log(`Fatal error: ${fatalErr.message}`);
    if (onError) onError(fatalErr);
  } finally {
    await closeBrowser();
  }
}

module.exports = { scrapeKeyword };
