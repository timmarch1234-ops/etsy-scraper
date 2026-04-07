const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { initDb, createSearch, updateSearch, getSearches, getSearch, addListing, getListings, getAllListings, updateListingImageByUrl, deleteSearch, clearAll } = require('./database');

const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');

// Ensure screenshot dir exists
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' })); // large payloads for screenshot data URLs

// CORS - allow requests from Etsy pages and extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Debug endpoint: test if we can reach Etsy from this server
app.get('/api/test-etsy', async (req, res) => {
  const testUrl = req.query.url || 'https://www.etsy.com/listing/1234567890/test';
  try {
    const resp = await fetch(testUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    const text = await resp.text();
    const hasCaptcha = text.includes('captcha-delivery') || text.includes('geo.captcha-delivery');
    res.json({
      status: resp.status,
      hasCaptcha,
      bodyLength: text.length,
      bodyPreview: text.substring(0, 500),
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// Transform DB row field names (snake_case) to frontend field names (camelCase)
function transformSearch(row) {
  if (!row) return null;
  return {
    id: row.id,
    keyword: row.keyword,
    status: row.status,
    createdAt: row.created_at,
    pagesScraped: row.pages_scanned,
    totalPages: row.total_pages,
    listingsScanned: row.listings_scanned,
    shortlisted: row.listings_shortlisted,
    completedAt: row.completed_at || null,
  };
}

function transformListing(row) {
  if (!row) return null;
  return {
    id: row.id,
    searchId: row.search_id,
    title: row.title,
    price: row.price,
    url: row.url,
    soldLast24h: row.sold_count,
    screenshot: row.screenshot_path ? path.basename(row.screenshot_path) : null,
    imageUrl: row.image_url || null,
    createdAt: row.created_at,
  };
}

// Get all listings across all searches (for shortlist page)
app.get('/api/listings/all', (req, res) => {
  try {
    const listings = getAllListings();
    res.json(listings.map(row => ({
      ...transformListing(row),
      keyword: row.search_keyword,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new search (extension will pick it up via polling)
app.post('/api/search', (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword) {
      return res.status(400).json({ error: 'keyword is required' });
    }
    const search = createSearch(keyword);
    res.json(transformSearch(search));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server-side Puppeteer scanner for a search
// On Railway: skips scanner spawn — the local-worker.js picks up "running" searches instead
// Locally: spawns scanner.js as a child process
const IS_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);

app.post('/api/searches/:id/start-scan', (req, res) => {
  try {
    const search = getSearch(req.params.id);
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }

    if (IS_RAILWAY) {
      // On Railway, Etsy blocks server-side scanning (DataDome).
      // Leave the search as "running" so the local worker picks it up.
      console.log(`Search ${search.id} ("${search.keyword}") created — waiting for local worker to pick it up`);
      res.json({ ok: true, message: 'Search queued — waiting for local scanner', mode: 'remote' });
      return;
    }

    const scannerPath = path.join(__dirname, 'scanner.js');
    const logPath = path.join(__dirname, 'scanner.log');
    const child = spawn('node', [scannerPath, search.id, search.keyword], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${process.env.PATH}`,
        SERVER_BASE: `http://localhost:${PORT}`,
      },
    });
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      logStream.write(data);
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      logStream.write(data);
    });
    child.on('close', () => logStream.close());
    child.unref();

    console.log(`Scanner started for search ${search.id} (keyword: "${search.keyword}"), PID: ${child.pid}`);
    res.json({ ok: true, message: 'Scanner started', pid: child.pid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all searches, most recent first
app.get('/api/searches', (req, res) => {
  try {
    const searches = getSearches();
    res.json(searches.map(transformSearch));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single search with its listings
app.get('/api/searches/:id', (req, res) => {
  try {
    const search = getSearch(req.params.id);
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }
    const listings = getListings(req.params.id);
    res.json({ ...transformSearch(search), listings: listings.map(transformListing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get listings for a search
app.get('/api/searches/:id/listings', (req, res) => {
  try {
    const listings = getListings(req.params.id);
    res.json(listings.map(transformListing));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH search — used by the Chrome extension to update progress/status
app.patch('/api/searches/:id', (req, res) => {
  try {
    const fields = req.body;
    updateSearch(req.params.id, fields);
    const search = getSearch(req.params.id);
    res.json(transformSearch(search));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST listing — used by the Chrome extension to add shortlisted listings
// Accepts screenshotDataUrl (base64 PNG data URL) and saves it as a file
app.post('/api/searches/:id/listings', (req, res) => {
  try {
    const { title, price, url, soldCount, screenshotDataUrl, imageUrl } = req.body;
    let screenshotPath = null;

    // Save screenshot from data URL to file
    if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image/')) {
      const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
      // Extract Etsy listing ID from URL for consistent filename
      const etsyIdMatch = url ? url.match(/listing\/(\d+)/) : null;
      const filename = etsyIdMatch ? `listing_${etsyIdMatch[1]}.png` : `${uuidv4()}.png`;
      screenshotPath = path.join(SCREENSHOT_DIR, filename);
      fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
    }

    const listing = addListing(req.params.id, {
      title,
      price,
      url,
      soldCount: soldCount || 0,
      screenshotPath,
      imageUrl: imageUrl || null,
    });

    res.json(transformListing(listing));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk POST listings — accepts array of { title, price, url, soldCount }
app.post('/api/searches/:id/listings/bulk', (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
    let saved = 0;
    for (const { title, price, url, soldCount, imageUrl } of items) {
      addListing(req.params.id, { title, price, url, soldCount: soldCount || 0, screenshotPath: null, imageUrl: imageUrl || null });
      saved++;
    }
    res.json({ saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET-based listing add (works around mixed content blocking from HTTPS pages)
app.get('/api/searches/:id/add', (req, res) => {
  try {
    const { title, price, url, soldCount, imageUrl } = req.query;
    addListing(req.params.id, { title: title || 'Untitled', price: price || '', url: url || '', soldCount: parseInt(soldCount) || 0, screenshotPath: null, imageUrl: imageUrl || null });
    // Return a 1x1 transparent pixel
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set('Content-Type', 'image/gif');
    res.send(pixel);
  } catch (err) {
    res.status(500).send('');
  }
});

// GET-based search update
app.get('/api/searches/:id/progress', (req, res) => {
  try {
    updateSearch(req.params.id, req.query);
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set('Content-Type', 'image/gif');
    res.send(pixel);
  } catch (err) {
    res.status(500).send('');
  }
});

// Bulk update image URLs - accepts array of { listingUrl, imageUrl }
app.post('/api/listings/images', (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
    let updated = 0;
    for (const { listingUrl, imageUrl } of items) {
      const info = updateListingImageByUrl(listingUrl, imageUrl);
      updated += info.changes;
    }
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshot upload endpoint
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload-screenshot/:listingId', upload.single('screenshot'), (req, res) => {
  try {
    const listingId = req.params.listingId;
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const filename = `listing_${listingId}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(filepath, req.file.buffer);
    // Update DB
    const { initDb: _, ...dbFns } = require('./database');
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
    db.prepare('UPDATE listings SET screenshot_path = ? WHERE id = ?').run(filepath, parseInt(listingId));
    db.close();
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load urgency data from TSV
let urgencyMap = {};
try {
  const urgLines = fs.readFileSync('/tmp/led-urgency.tsv','utf8').trim().split('\n');
  for (const line of urgLines) {
    const [id, text] = line.split('|');
    if (id && text) urgencyMap[id.trim()] = text.trim();
  }
} catch(e) {}

// Load image URLs from TSV
let imageMap = {};
try {
  const imgLines = fs.readFileSync('/tmp/led-images.tsv','utf8').trim().split('\n');
  for (const line of imgLines) {
    const [id, url] = line.split('|');
    if (id && url) imageMap[id.trim()] = url.trim();
  }
} catch(e) {}

// Listing preview page - renders a listing like an Etsy page for screenshots
app.get('/preview/:listingId', (req, res) => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(parseInt(req.params.listingId));
    db.close();
    if (!listing) return res.status(404).send('Not found');

    const etsyId = listing.url ? listing.url.match(/listing\/(\d+)/)?.[1] : '';
    const productImg = imageMap[etsyId] || `/screenshots/listing_${etsyId}.png`;
    const urgencyText = urgencyMap[etsyId] || 'In demand';

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${(listing.title||'').replace(/</g,'&lt;')}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Graphik Webfont',-apple-system,Helvetica,Arial,sans-serif; background:#fafafa; }
  .price-bar { display:flex; gap:24px; padding:8px 48px; background:#fff; border-bottom:1px solid #e0e0e0; overflow-x:auto; }
  .price-bar-item { text-align:center; white-space:nowrap; }
  .price-bar-item .current { font-size:13px; font-weight:600; }
  .price-bar-item .original { font-size:11px; color:#999; text-decoration:line-through; }
  .listing-page { display:flex; max-width:1400px; margin:0 auto; padding:20px 48px 40px; background:#fff; min-height:700px; }
  .thumb-strip { display:flex; flex-direction:column; gap:6px; margin-right:12px; flex-shrink:0; }
  .thumb-strip img { width:68px; height:68px; object-fit:cover; border-radius:10px; border:2px solid #e0e0e0; cursor:pointer; }
  .thumb-strip img:first-child { border-color:#222; }
  .thumb-strip .video-thumb { position:relative; }
  .thumb-strip .video-thumb::after { content:''; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:24px; height:24px; background:rgba(0,0,0,0.6); border-radius:50%; }
  .main-image { flex:0 0 540px; position:relative; margin-right:32px; }
  .main-image img { width:100%; border-radius:12px; display:block; }
  .bestseller { position:absolute; top:14px; left:14px; background:#fff; padding:5px 12px; border-radius:20px; font-size:13px; font-weight:600; border:1.5px dashed #258635; color:#258635; display:flex; align-items:center; gap:5px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
  .bestseller::before { content:'\\1F3C6'; }
  .heart-btn { position:absolute; top:14px; right:14px; width:40px; height:40px; background:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.15); cursor:pointer; }
  .heart-btn svg { width:20px; height:20px; }
  .nav-arrow { position:absolute; top:50%; transform:translateY(-50%); width:40px; height:40px; background:#fff; border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,0.15); cursor:pointer; font-size:18px; color:#222; }
  .nav-arrow.left { left:12px; }
  .nav-arrow.right { right:12px; }
  .details { flex:1; padding-top:4px; }
  .urgency { color:#a61a2e; font-size:14px; font-weight:600; margin-bottom:8px; }
  .price-section { margin:4px 0 8px; }
  .price-now-label { font-size:14px; color:#222; margin-right:4px; }
  .price-current { font-size:30px; font-weight:400; color:#222; }
  .price-original { font-size:16px; color:#595959; text-decoration:line-through; margin-left:8px; }
  .sale-info { margin-top:2px; }
  .pct-off { color:#a61a2e; font-size:14px; font-weight:600; }
  .sale-timer { color:#a61a2e; font-size:14px; margin-left:8px; }
  .sale-timer::before { content:'\\00B7'; margin-right:8px; }
  .gst-note { font-size:12px; color:#757575; margin-top:6px; line-height:1.4; }
  .title { font-size:18px; line-height:1.5; margin:14px 0; color:#222; font-weight:400; }
  .seller-row { display:flex; align-items:center; gap:8px; margin:16px 0; font-size:14px; color:#222; }
  .seller-name { font-weight:500; }
  .star-seller { display:inline-flex; align-items:center; gap:2px; }
  .star-seller svg { width:16px; height:16px; }
  .stars { color:#f1641e; letter-spacing:1px; }
  .returns { color:#258635; font-size:14px; margin:14px 0; display:flex; align-items:center; gap:6px; font-weight:500; }
  .returns svg { width:16px; height:16px; color:#258635; }
  .option-section { margin-top:20px; }
  .option-label { font-size:14px; font-weight:500; margin-bottom:6px; }
  .option-select { width:100%; padding:12px 16px; border:1px solid #222; border-radius:8px; font-size:15px; background:#fff; appearance:none; cursor:pointer; }
  .add-personal { margin-top:16px; font-size:14px; color:#222; display:flex; align-items:center; gap:6px; cursor:pointer; }
  .add-personal::before { content:'+'; font-size:18px; font-weight:300; }
  .qty-label { margin-top:20px; font-size:14px; font-weight:500; }
</style></head><body>
<div class="price-bar">
  <div class="price-bar-item"><div class="current">${currency}${(priceNum*1.1).toFixed(2)}</div><div class="original">${currency}${(priceNum*3.1).toFixed(2)}</div></div>
  <div class="price-bar-item"><div class="current">${currency}${(priceNum*0.9).toFixed(2)}</div><div class="original">${currency}${(priceNum*2.8).toFixed(2)}</div></div>
  <div class="price-bar-item"><div class="current">${listing.price || '—'}</div><div class="original">${currency}${originalPrice}</div></div>
  <div class="price-bar-item"><div class="current">${currency}${(priceNum*1.5).toFixed(2)}</div><div class="original">${currency}${(priceNum*4.2).toFixed(2)}</div></div>
  <div class="price-bar-item"><div class="current">${currency}14.99</div><div class="original">${currency}59.96</div></div>
  <div class="price-bar-item"><div class="current">${currency}${(priceNum*0.95).toFixed(2)}</div><div class="original">${currency}${(priceNum*2.7).toFixed(2)}</div></div>
  <div class="price-bar-item"><div class="current">${currency}21.12</div><div class="original">${currency}60.34</div></div>
  <div class="price-bar-item"><div class="current">${currency}${(priceNum*1.2).toFixed(2)}</div><div class="original">${currency}${(priceNum*3.4).toFixed(2)}</div></div>
</div>
<div class="listing-page">
  <div class="thumb-strip">
    <img src="${productImg}" alt="">
    <div class="video-thumb"><img src="${productImg}" alt="" style="filter:brightness(0.85)"></div>
    <img src="${productImg}" alt="" style="filter:hue-rotate(20deg)">
    <img src="${productImg}" alt="" style="filter:saturate(0.6)">
    <img src="${productImg}" alt="" style="filter:hue-rotate(-15deg) brightness(1.1)">
    <img src="${productImg}" alt="" style="filter:contrast(1.1) saturate(0.8)">
    <img src="${productImg}" alt="" style="filter:hue-rotate(40deg) brightness(0.95)">
  </div>
  <div class="main-image">
    <div class="bestseller">Bestseller</div>
    <img src="${productImg}" alt="">
    <div class="heart-btn"><svg viewBox="0 0 24 24" fill="none" stroke="#222" stroke-width="1.5"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div>
    <div class="nav-arrow left">&#8249;</div>
    <div class="nav-arrow right">&#8250;</div>
  </div>
  <div class="details">
    <div class="urgency">${urgencyText}</div>
    <div class="price-section">
      <span class="price-now-label">Now</span>
      <span class="price-current">${listing.price || '—'}</span>
      <span class="price-original">${currency}${originalPrice}</span>
      <div class="sale-info">
        <span class="pct-off">${pctOff}% off</span>
        <span class="sale-timer">Sale ends in 10:56:38</span>
      </div>
    </div>
    <div class="gst-note">* Seller GST included (where applicable). Additional GST may be applied by Etsy at checkout</div>
    <div class="title">${(listing.title||'Untitled').replace(/</g,'&lt;')}</div>
    <div class="seller-row">
      <span class="seller-name">istanbluevintage</span>
      <span class="star-seller"><svg viewBox="0 0 24 24" fill="#258635"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4" stroke="#fff" stroke-width="2" fill="none"/></svg></span>
      <span class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
    </div>
    <div class="returns"><svg viewBox="0 0 24 24" fill="none" stroke="#258635" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Returns & exchanges accepted</div>
    <div class="option-section">
      <div class="option-label">Shapes</div>
      <select class="option-select"><option>Select an option</option></select>
    </div>
    <div class="add-personal">Add personalisation</div>
    <div class="qty-label">Quantity</div>
  </div>
</div>
</body></html>`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// URL queue for scraping - stores URLs to check and results
const urlQueue = { urls: [], checked: 0, found: 0, errors: 0, status: 'idle', results: [] };
app.post('/api/queue/urls', (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls)) return res.status(400).json({ error: 'Expected { urls: [...] }' });
  const before = urlQueue.urls.length;
  const existing = new Set(urlQueue.urls);
  urls.forEach(u => { if (!existing.has(u)) { urlQueue.urls.push(u); existing.add(u); } });
  res.json({ added: urlQueue.urls.length - before, total: urlQueue.urls.length });
});
app.get('/api/queue/status', (req, res) => {
  res.json({ total: urlQueue.urls.length, checked: urlQueue.checked, found: urlQueue.found, errors: urlQueue.errors, status: urlQueue.status });
});
app.post('/api/queue/reset', (req, res) => {
  urlQueue.urls = []; urlQueue.checked = 0; urlQueue.found = 0; urlQueue.errors = 0; urlQueue.status = 'idle'; urlQueue.results = [];
  res.json({ ok: true });
});
app.get('/api/queue/next-batch', (req, res) => {
  const size = parseInt(req.query.size) || 1;
  const start = urlQueue.checked;
  const batch = urlQueue.urls.slice(start, start + size);
  res.json({ batch, start, remaining: urlQueue.urls.length - start });
});
app.post('/api/queue/report', (req, res) => {
  const { checked, found, errors, results } = req.body;
  if (checked) urlQueue.checked += checked;
  if (found) urlQueue.found += found;
  if (errors) urlQueue.errors += errors;
  if (results && Array.isArray(results)) urlQueue.results.push(...results);
  res.json({ ok: true, total: urlQueue.urls.length, checked: urlQueue.checked, found: urlQueue.found });
});

// Chunked screenshot receiver
const screenshotChunks = {};
app.get('/api/ss-chunk', (req, res) => {
  const { id, i, d, total } = req.query;
  if (!screenshotChunks[id]) screenshotChunks[id] = { chunks: {}, total: parseInt(total) || 0 };
  screenshotChunks[id].chunks[parseInt(i)] = d;
  const received = Object.keys(screenshotChunks[id].chunks).length;
  if (total && received >= parseInt(total)) {
    // Assemble the image
    const sorted = Object.keys(screenshotChunks[id].chunks).sort((a,b) => a-b);
    const fullData = sorted.map(k => screenshotChunks[id].chunks[k]).join('');
    const base64 = fullData.replace(/^data:image\/\w+;base64,/, '');
    const filename = `listing_${id}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
    // Update DB
    const Database = require('better-sqlite3');
    const db2 = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
    db2.prepare('UPDATE listings SET screenshot_path = ? WHERE id = ?').run(filepath, parseInt(id));
    db2.close();
    delete screenshotChunks[id];
    console.log(`Screenshot saved: ${filename} (${received} chunks)`);
  }
  const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.send(pixel);
});

// Receiver page for postMessage screenshot transfer
app.get('/receive-screenshot', (req, res) => {
  res.send(`<!DOCTYPE html><html><body>
    <h2 id="status">Waiting for screenshot data...</h2>
    <script>
      window.addEventListener('message', function(e) {
        var data = e.data;
        if (!data || !data.action || data.action !== 'screenshot') return;
        document.getElementById('status').textContent = 'Received! Saving listing ' + data.listingId + '...';
        fetch('/api/searches/' + data.searchId + '/listings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: data.title || 'Untitled',
            price: data.price || '',
            url: data.url || '',
            soldCount: data.soldCount || 0,
            screenshotDataUrl: data.dataUrl,
            imageUrl: data.imageUrl || null,
          })
        }).then(r => r.json()).then(function(res) {
          document.getElementById('status').textContent = 'Saved listing ' + data.listingId + '! (DB ID: ' + res.id + ')';
          window._lastSaved = res;
        }).catch(function(err) {
          document.getElementById('status').textContent = 'Error: ' + err.message;
        });
      });
      // Signal ready
      window._ready = true;
    </script>
  </body></html>`);
});

// Receiver that just saves a screenshot for an existing listing ID
app.get('/receive-ss', (req, res) => {
  res.send(`<!DOCTYPE html><html><body>
    <h2 id="status">Waiting for screenshot data...</h2>
    <script>
      window.addEventListener('message', function(e) {
        var data = e.data;
        if (!data || !data.dataUrl) return;
        var id = data.listingId;
        document.getElementById('status').textContent = 'Received screenshot for listing ' + id + ', uploading...';
        // Convert data URL to blob and upload
        fetch(data.dataUrl).then(r => r.blob()).then(function(blob) {
          var fd = new FormData();
          fd.append('screenshot', blob, 'listing_' + id + '.png');
          return fetch('/api/upload-screenshot/' + id, { method: 'POST', body: fd });
        }).then(r => r.json()).then(function(res) {
          document.getElementById('status').textContent = 'Saved screenshot for listing ' + id + '!';
          window._saved = true;
          window._lastId = id;
        }).catch(function(err) {
          document.getElementById('status').textContent = 'Error: ' + err.message;
          window._error = err.message;
        });
      });
      window._ready = true;
    </script>
  </body></html>`);
});

// Save screenshot from URL hash (data passed via fragment)
app.get('/save-from-hash', (req, res) => {
  const listingId = req.query.id || '0';
  res.send(`<!DOCTYPE html><html><body>
    <h2 id="status">Reading screenshot data...</h2>
    <script>
      // Try window.name first (no hash needed), then fall back to hash
      var dataUrl = '';
      if (window.name && window.name.startsWith('data:image')) {
        dataUrl = window.name;
        window.name = ''; // clear it
      } else {
        var hash = location.hash.substring(1);
        if (hash) dataUrl = decodeURIComponent(hash);
      }
      if (!dataUrl) {
        document.getElementById('status').textContent = 'No data!';
      } else {
        document.getElementById('status').textContent = 'Got ' + dataUrl.length + ' chars, uploading listing ${listingId}...';
        fetch(dataUrl).then(function(r) { return r.blob(); }).then(function(blob) {
          var fd = new FormData();
          fd.append('screenshot', blob, 'listing_${listingId}.png');
          return fetch('/api/upload-screenshot/${listingId}', { method: 'POST', body: fd });
        }).then(function(r) { return r.json(); }).then(function(res) {
          document.getElementById('status').textContent = 'Saved! ' + JSON.stringify(res);
          window._done = true;
          history.replaceState(null, '', location.pathname + location.search);
        }).catch(function(err) {
          document.getElementById('status').textContent = 'Error: ' + err.message;
        });
      }
    </script>
  </body></html>`);
});

// API endpoint to get listings needing screenshots
app.get('/api/listings-for-screenshots', (req, res) => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
    const listings = db.prepare('SELECT id, url FROM listings ORDER BY id ASC').all();
    db.close();
    res.json(listings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Screenshot upload page
app.get('/upload', (req, res) => {
  const listingId = req.query.id || '0';
  res.send(`<!DOCTYPE html><html><body>
    <h2>Upload Screenshot for Listing ${listingId}</h2>
    <form id="form" action="/api/upload-screenshot/${listingId}" method="POST" enctype="multipart/form-data">
      <input type="file" name="screenshot" id="fileInput" accept="image/*">
      <button type="submit">Upload</button>
    </form>
    <div id="status"></div>
    <script>
      document.getElementById('fileInput').addEventListener('change', () => {
        document.getElementById('form').submit();
      });
    </script>
  </body></html>`);
});

// Bulk update listing titles/prices by URL
app.post('/api/listings/update-bulk', (req, res) => {
  try {
    const items = req.body; // [{url, title, price}]
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || path.join(__dirname, 'data.db'));
    const stmt = db.prepare('UPDATE listings SET title = ?, price = ? WHERE url = ?');
    let updated = 0;
    for (const { url, title, price } of items) {
      const info = stmt.run(title, price, url);
      updated += info.changes;
    }
    db.close();
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a single search and its listings
app.delete('/api/searches/:id', (req, res) => {
  try {
    const search = getSearch(req.params.id);
    if (!search) {
      return res.status(404).json({ error: 'Search not found' });
    }
    // Delete screenshot files for this search's listings
    const listings = getListings(req.params.id);
    for (const listing of listings) {
      if (listing.screenshot_path) {
        try { fs.unlinkSync(listing.screenshot_path); } catch (e) {}
      }
    }
    deleteSearch(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset all data
app.post('/api/reset', (req, res) => {
  try {
    clearAll();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Initialize DB then start the server
initDb();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// Also start HTTPS server for mixed-content workaround
const https = require('https');
const HTTPS_PORT = 3443;
try {
  const httpsOptions = {
    key: fs.readFileSync(path.join(__dirname, 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
  };
  https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`HTTPS server running on https://localhost:${HTTPS_PORT}`);
  });
} catch (e) {
  console.log('HTTPS server not started (no cert files):', e.message);
}
