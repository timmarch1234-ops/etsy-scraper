/**
 * Puppeteer-based scraper: searches Etsy for a keyword,
 * visits each listing page, checks for "sold in last 24 hours",
 * takes a real screenshot, and saves to DB.
 *
 * Usage: node scrape-keyword.js <keyword> [maxPages]
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const keyword = process.argv[2];
const maxPages = parseInt(process.argv[3]) || 107;

if (!keyword) {
  console.error('Usage: node scrape-keyword.js <keyword> [maxPages]');
  process.exit(1);
}

async function main() {
  const db = new Database(DB_PATH);

  // Create search entry
  const searchId = uuidv4();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO searches (id, keyword, status, created_at, total_pages) VALUES (?, ?, 'running', ?, ?)`).run(searchId, keyword, createdAt, maxPages);
  console.log(`Search created: ${searchId} for "${keyword}"`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1400, height: 900 },
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-AU,en;q=0.9',
  });

  let totalScanned = 0;
  let totalShortlisted = 0;
  let consecutiveBlocks = 0;

  for (let pg = 1; pg <= maxPages; pg++) {
    const searchUrl = `https://www.etsy.com/au/search?q=${encodeURIComponent(keyword)}&explicit=1&page=${pg}`;
    console.log(`\n--- Page ${pg}/${maxPages} ---`);

    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const pageTitle = await page.title();
      if (pageTitle.includes('Access denied') || pageTitle.includes('Just a moment')) {
        console.log('  BLOCKED on search page');
        consecutiveBlocks++;
        if (consecutiveBlocks >= 3) {
          console.log('  3 consecutive blocks, stopping.');
          break;
        }
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      consecutiveBlocks = 0;

      // Extract listing URLs from search results
      const listingUrls = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/listing/"]');
        const seen = new Set();
        const urls = [];
        links.forEach(a => {
          const href = a.href;
          const match = href.match(/\/listing\/(\d+)\//);
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            urls.push(href.split('?')[0]);
          }
        });
        return urls;
      });

      console.log(`  Found ${listingUrls.length} listings on page`);
      totalScanned += listingUrls.length;

      // Visit each listing to check for "sold in last 24 hours"
      for (const listingUrl of listingUrls) {
        try {
          await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 20000 });
          await new Promise(r => setTimeout(r, 2500));

          const listingTitle = await page.title();
          if (listingTitle.includes('Access denied') || listingTitle.includes('Just a moment')) {
            consecutiveBlocks++;
            if (consecutiveBlocks >= 3) break;
            continue;
          }
          consecutiveBlocks = 0;

          // Check for "sold in last 24 hours" and extract data
          const data = await page.evaluate(() => {
            const bodyText = document.body.textContent;
            const soldMatch = bodyText.match(/(\d+)\s*sold\s*in\s*(?:the\s*)?last\s*24\s*hours/i);
            if (!soldMatch) return null;

            // Get title
            const titleEl = document.querySelector('h1');
            const title = titleEl ? titleEl.textContent.trim() : document.title.split(' - ')[0].split(' |')[0].trim();

            // Get price
            const priceEl = document.querySelector('[data-buy-box-listing-price] p, .wt-text-title-03');
            const price = priceEl ? priceEl.textContent.trim() : '';

            // Get image
            const img = document.querySelector('img[data-listing-card-image], .listing-page-image-carousel img, img.wt-max-width-full');
            const imageUrl = img ? img.src : '';

            return {
              title: title.substring(0, 200),
              price,
              soldCount: parseInt(soldMatch[1]),
              imageUrl,
            };
          });

          if (data) {
            // This listing has "sold in last 24 hours" — take screenshot and save
            await page.evaluate(() => window.scrollTo(0, 0));
            await new Promise(r => setTimeout(r, 500));

            const listingId = Date.now();
            const filename = `listing_${listingId}.png`;
            const filepath = path.join(SCREENSHOT_DIR, filename);
            await page.screenshot({ path: filepath, type: 'png' });

            // Save to DB
            const info = db.prepare(`
              INSERT INTO listings (search_id, title, price, url, sold_count, screenshot_path, image_url, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(searchId, data.title, data.price, listingUrl, data.soldCount, filepath, data.imageUrl, new Date().toISOString());

            totalShortlisted++;
            console.log(`  ✓ SHORTLISTED: ${data.soldCount} sold - ${data.title.substring(0, 50)}`);
          }

          // Small delay between listings
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

        } catch (e) {
          // Skip individual listing errors
        }
      }

      if (consecutiveBlocks >= 3) break;

      // Update search progress
      db.prepare('UPDATE searches SET pages_scanned = ?, listings_scanned = ?, listings_shortlisted = ? WHERE id = ?')
        .run(pg, totalScanned, totalShortlisted, searchId);

      // Delay between pages
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

    } catch (e) {
      console.log(`  Error on page ${pg}: ${e.message.substring(0, 60)}`);
    }
  }

  // Final update
  const finalStatus = consecutiveBlocks >= 3 ? 'blocked' : 'success';
  db.prepare('UPDATE searches SET status = ?, pages_scanned = ?, listings_scanned = ?, listings_shortlisted = ? WHERE id = ?')
    .run(finalStatus, maxPages, totalScanned, totalShortlisted, searchId);

  await browser.close();
  db.close();
  console.log(`\nDone! Scanned ${totalScanned} listings, shortlisted ${totalShortlisted}. Status: ${finalStatus}`);
}

main().catch(console.error);
