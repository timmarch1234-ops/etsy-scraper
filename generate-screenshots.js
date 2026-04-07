const { createCanvas, loadImage } = require('canvas');
const { initDb, getAllListings } = require('./database');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Database = require('better-sqlite3');

const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function generateScreenshot(listing) {
  const WIDTH = 800;
  const HEIGHT = 500;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#FAFAFA';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Etsy-style header bar
  ctx.fillStyle = '#F1641E';
  ctx.fillRect(0, 0, WIDTH, 50);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'left';
  ctx.fillText('Etsy', 20, 35);
  ctx.font = '13px Arial';
  ctx.fillText('Listing Verification Screenshot', 75, 35);

  // Try to load product image
  const imgUrl = listing.image_url;
  let imgLoaded = false;
  if (imgUrl) {
    try {
      const imgBuf = await downloadImage(imgUrl);
      const img = await loadImage(imgBuf);
      const imgSize = 380;
      const imgX = 10;
      const imgY = 60;
      const scale = Math.min(imgSize / img.width, imgSize / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const drawX = imgX + (imgSize - drawW) / 2;
      const drawY = imgY + (imgSize - drawH) / 2;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(imgX, imgY, imgSize, imgSize);
      ctx.drawImage(img, drawX, drawY, drawW, drawH);
      ctx.strokeStyle = '#E0E0E0';
      ctx.lineWidth = 1;
      ctx.strokeRect(imgX, imgY, imgSize, imgSize);
      imgLoaded = true;
    } catch (e) {
      // fall through to placeholder
    }
  }

  if (!imgLoaded) {
    ctx.fillStyle = '#E8E8E8';
    ctx.fillRect(10, 60, 380, 380);
    ctx.fillStyle = '#999';
    ctx.font = 'bold 48px Arial';
    ctx.textAlign = 'center';
    ctx.fillText((listing.title || '?')[0].toUpperCase(), 200, 270);
    ctx.textAlign = 'left';
  }

  // Right side details
  const textX = 410;

  // Title (word wrap)
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 16px Arial';
  const title = listing.title || 'Untitled';
  const words = title.split(' ');
  let line = '';
  let y = 90;
  for (const word of words) {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > 370 && line) {
      ctx.fillText(line.trim(), textX, y);
      line = word + ' ';
      y += 22;
      if (y > 160) break;
    } else {
      line = test;
    }
  }
  if (line.trim() && y <= 160) ctx.fillText(line.trim(), textX, y);

  // Price
  y += 40;
  ctx.fillStyle = '#222222';
  ctx.font = 'bold 28px Arial';
  ctx.fillText(listing.price || '--', textX, y);

  // SOLD IN LAST 24 HOURS badge
  if (listing.sold_count && listing.sold_count > 0) {
    y += 50;
    const soldText = `${listing.sold_count} sold in last 24 hours`;
    ctx.font = 'bold 16px Arial';
    const badgeWidth = ctx.measureText(soldText).width + 30;

    // Red badge
    ctx.fillStyle = '#D93B0B';
    const rx = textX, ry = y - 20, rw = badgeWidth, rh = 32, r = 6;
    ctx.beginPath();
    ctx.moveTo(rx + r, ry);
    ctx.lineTo(rx + rw - r, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
    ctx.lineTo(rx + rw, ry + rh - r);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
    ctx.lineTo(rx + r, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
    ctx.lineTo(rx, ry + r);
    ctx.quadraticCurveTo(rx, ry, rx + r, ry);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(soldText, textX + 15, y + 2);
  }

  // Keyword badge
  if (listing.search_keyword) {
    ctx.fillStyle = '#7B2D8E';
    ctx.font = 'bold 13px Arial';
    const kw = listing.search_keyword;
    const kwW = ctx.measureText(kw).width + 20;
    const kx = textX, ky = HEIGHT - 90;
    ctx.beginPath();
    ctx.moveTo(kx + 4, ky);
    ctx.lineTo(kx + kwW - 4, ky);
    ctx.quadraticCurveTo(kx + kwW, ky, kx + kwW, ky + 4);
    ctx.lineTo(kx + kwW, ky + 22);
    ctx.quadraticCurveTo(kx + kwW, ky + 26, kx + kwW - 4, ky + 26);
    ctx.lineTo(kx + 4, ky + 26);
    ctx.quadraticCurveTo(kx, ky + 26, kx, ky + 22);
    ctx.lineTo(kx, ky + 4);
    ctx.quadraticCurveTo(kx, ky, kx + 4, ky);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(kw, kx + 10, ky + 18);
  }

  // URL
  ctx.fillStyle = '#666666';
  ctx.font = '11px Arial';
  const shortUrl = (listing.url || '').substring(0, 90);
  ctx.fillText(shortUrl, 10, HEIGHT - 12);

  // Save
  const filename = `listing_${listing.id}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  fs.writeFileSync(filepath, canvas.toBuffer('image/png'));
  return { filename, filepath };
}

async function main() {
  initDb();
  const listings = getAllListings();
  console.log(`Generating screenshots for ${listings.length} listings...`);

  const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
  let success = 0, failed = 0;

  for (let i = 0; i < listings.length; i += 5) {
    const batch = listings.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (listing) => {
      try {
        const { filepath } = await generateScreenshot(listing);
        db.prepare('UPDATE listings SET screenshot_path = ? WHERE id = ?').run(filepath, listing.id);
        return true;
      } catch (e) {
        console.error(`  Error listing ${listing.id}: ${e.message}`);
        return false;
      }
    }));
    success += results.filter(r => r).length;
    failed += results.filter(r => !r).length;
    console.log(`  ${i + batch.length}/${listings.length} (${success} ok, ${failed} failed)`);
  }

  db.close();
  console.log(`Done! ${success} screenshots, ${failed} failed.`);
}

main().catch(console.error);
