const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');

async function run() {
  const db = new Database('data.db');
  const listings = db.prepare('SELECT id, url FROM listings WHERE search_id = ?')
    .all('ba6c4f97-1c22-491e-a60b-85a20f17173c');

  console.log(`Taking screenshots for ${listings.length} listings...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  let done = 0, errors = 0;

  for (const listing of listings) {
    try {
      const etsyId = listing.url.match(/listing\/(\d+)/)?.[1];
      if (!etsyId) { errors++; continue; }

      const previewUrl = `http://localhost:3000/preview/${listing.id}`;
      await page.goto(previewUrl, { waitUntil: 'networkidle0', timeout: 30000 });

      // Wait for the gallery image to fully load
      await page.waitForFunction(() => {
        const img = document.querySelector('.gallery img');
        return img && img.complete && img.naturalWidth > 0;
      }, { timeout: 10000 }).catch(() => {
        console.log(`  Warning: image may not have loaded for listing ${listing.id}`);
      });

      // Extra buffer for rendering
      await new Promise(r => setTimeout(r, 300));

      const screenshotPath = path.join(SCREENSHOT_DIR, `listing_${etsyId}.png`);
      await page.screenshot({ path: screenshotPath, type: 'png' });

      db.prepare('UPDATE listings SET screenshot_path = ? WHERE id = ?')
        .run(screenshotPath, listing.id);

      done++;
      if (done % 10 === 0) console.log(`Progress: ${done}/${listings.length}`);
    } catch(e) {
      console.error(`Error on listing ${listing.id}:`, e.message);
      errors++;
    }
  }

  await browser.close();
  db.close();
  console.log(`Done! Screenshots: ${done}, Errors: ${errors}`);
}

run().catch(console.error);
