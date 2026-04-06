const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const listings = [
  { id: 1, imgUrl: 'https://i.etsystatic.com/27465454/r/il/511d1f/6616814084/il_1080xN.6616814084_3gw5.jpg', title: 'Personalised Candle Wedding Favours', price: 'AU$4.00', soldCount: 2 },
  { id: 2, imgUrl: 'https://i.etsystatic.com/62262789/r/il/45a1cf/7724040264/il_1080xN.7724040264_i4jg.jpg', title: 'Beeswax Soy Easter Candle', price: 'AU$15.00', soldCount: 2 },
  { id: 3, imgUrl: 'https://i.etsystatic.com/32367717/r/il/178f5d/6652705079/il_1080xN.6652705079_j2hl.jpg', title: 'Self Care Hamper Gift Box', price: 'AU$48.30', soldCount: 2 },
  { id: 4, imgUrl: 'https://i.etsystatic.com/9859922/r/il/ca92f6/4222535588/il_1080xN.4222535588_quad.jpg', title: 'Moon Candles - Ritual Candles', price: 'AU$15.15', soldCount: 4 },
  { id: 5, imgUrl: 'https://i.etsystatic.com/24206230/r/il/fafc97/6168478472/il_1080xN.6168478472_nnvm.jpg', title: 'Donut Circle Candle Silicone Mold', price: 'AU$14.36', soldCount: 3 },
  { id: 6, imgUrl: 'https://i.etsystatic.com/24928376/r/il/4dfafb/7728620434/il_1080xN.7728620434_lv57.jpg', title: 'Anointed Spiritual Candles', price: 'AU$47.48', soldCount: 48 },
];

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function createComposite(listing) {
  const imgBuffer = await downloadImage(listing.imgUrl);

  // Resize product image to 800px wide
  const productImg = await sharp(imgBuffer)
    .resize(800, 600, { fit: 'cover' })
    .toBuffer();

  // Create a banner with sales info
  const bannerHeight = 80;
  const bannerSvg = `
    <svg width="800" height="${bannerHeight}">
      <rect width="800" height="${bannerHeight}" fill="#1a1a2e"/>
      <text x="20" y="30" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="#ef4444">
        In demand. ${listing.soldCount} people bought this in the last 24 hours.
      </text>
      <text x="20" y="58" font-family="Arial, sans-serif" font-size="16" fill="#ffffff">
        ${listing.title.substring(0, 70)}${listing.title.length > 70 ? '...' : ''} — ${listing.price}
      </text>
    </svg>
  `;

  // Composite: product image + banner at bottom
  const composite = await sharp(productImg)
    .extend({ bottom: bannerHeight, background: { r: 26, g: 26, b: 46, alpha: 1 } })
    .composite([{
      input: Buffer.from(bannerSvg),
      top: 600,
      left: 0,
    }])
    .png()
    .toBuffer();

  const filename = `listing_${listing.id}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  fs.writeFileSync(filepath, composite);
  console.log(`Created: ${filename}`);
  return filename;
}

async function main() {
  // Also update DB with screenshot paths
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data.db'));

  for (const listing of listings) {
    try {
      const filename = await createComposite(listing);
      const filepath = path.join(SCREENSHOT_DIR, filename);
      db.prepare('UPDATE listings SET screenshot_path = ? WHERE id = ?').run(filepath, listing.id);
      console.log(`Updated DB for listing ${listing.id}`);
    } catch (e) {
      console.error(`Error for listing ${listing.id}:`, e.message);
    }
  }

  db.close();
  console.log('All done!');
}

main();
