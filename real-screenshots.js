const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const listings = [
  { etsyId: '4300093422', dbId: 396, url: 'https://www.etsy.com/au/listing/4300093422' },
  { etsyId: '4472728432', dbId: 397, url: 'https://www.etsy.com/au/listing/4472728432' },
];

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Set extra headers to look like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-AU,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  });

  for (const listing of listings) {
    try {
      console.log(`Navigating to ${listing.url}...`);
      await page.goto(listing.url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Wait for the main listing image to load
      await page.waitForSelector('img[data-listing-card-image], .listing-page-image-carousel img, [data-appears-component-name="listing_page"] img', { timeout: 10000 }).catch(() => {
        console.log('  Warning: main image selector not found, continuing...');
      });

      // Extra wait for images to fully render
      await new Promise(r => setTimeout(r, 2000));

      // Check if we hit a CAPTCHA
      const pageContent = await page.content();
      if (pageContent.includes('captcha') || pageContent.includes('DataDome') || pageContent.includes('blocked')) {
        console.log(`  WARNING: Possible CAPTCHA/block on ${listing.etsyId}`);
      }

      const screenshotPath = path.join(SCREENSHOT_DIR, `listing_${listing.etsyId}.png`);
      await page.screenshot({ path: screenshotPath, type: 'png', fullPage: false });

      const stats = fs.statSync(screenshotPath);
      console.log(`  Saved: ${screenshotPath} (${(stats.size / 1024).toFixed(0)} KB)`);
    } catch (e) {
      console.error(`  Error on ${listing.etsyId}:`, e.message);
    }

    // Delay between listings
    await new Promise(r => setTimeout(r, 3000));
  }

  await browser.close();
  console.log('Done!');
}

run().catch(console.error);
