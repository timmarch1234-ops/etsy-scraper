const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDb, createSearch, updateSearch, getSearches, getSearch, addListing, getListings, getAllListings } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SCREENSHOT_DIR = path.join(__dirname, 'public', 'screenshots');

// Ensure screenshot dir exists
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' })); // large payloads for screenshot data URLs

// CORS - allow requests from Etsy pages and extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
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
    const { title, price, url, soldCount, screenshotDataUrl } = req.body;
    let screenshotPath = null;

    // Save screenshot from data URL to file
    if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image/')) {
      const base64Data = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
      const filename = `${uuidv4()}.png`;
      screenshotPath = path.join(SCREENSHOT_DIR, filename);
      fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
    }

    const listing = addListing(req.params.id, {
      title,
      price,
      url,
      soldCount: soldCount || 0,
      screenshotPath,
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
    for (const { title, price, url, soldCount } of items) {
      addListing(req.params.id, { title, price, url, soldCount: soldCount || 0, screenshotPath: null });
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
    const { title, price, url, soldCount } = req.query;
    addListing(req.params.id, { title: title || 'Untitled', price: price || '', url: url || '', soldCount: parseInt(soldCount) || 0, screenshotPath: null });
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

// Initialize DB then start the server
initDb();
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
