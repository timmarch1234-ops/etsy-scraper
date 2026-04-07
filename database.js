const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

let db;

function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'blocked', 'error', 'complete')),
      created_at TEXT NOT NULL,
      pages_scanned INTEGER NOT NULL DEFAULT 0,
      total_pages INTEGER NOT NULL DEFAULT 20,
      listings_scanned INTEGER NOT NULL DEFAULT 0,
      listings_shortlisted INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id TEXT NOT NULL REFERENCES searches(id),
      title TEXT,
      price TEXT,
      url TEXT,
      sold_count INTEGER,
      screenshot_path TEXT,
      image_url TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: add completed_at if missing
  const cols = db.pragma('table_info(searches)').map(c => c.name);
  if (!cols.includes('completed_at')) {
    db.exec('ALTER TABLE searches ADD COLUMN completed_at TEXT');
  }

  // Migration: add unique index on (search_id, url) to prevent duplicates
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='listings'").all().map(r => r.name);
  if (!indexes.includes('idx_listings_search_url')) {
    // Remove existing duplicates first — keep the one with the lowest id
    db.exec(`
      DELETE FROM listings WHERE id NOT IN (
        SELECT MIN(id) FROM listings GROUP BY search_id, url
      )
    `);
    db.exec('CREATE UNIQUE INDEX idx_listings_search_url ON listings(search_id, url)');
  }

  return db;
}

function createSearch(keyword) {
  const id = uuidv4();
  const created_at = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO searches (id, keyword, status, created_at)
    VALUES (?, ?, 'running', ?)
  `);
  stmt.run(id, keyword, created_at);
  return db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
}

function updateSearch(id, fields) {
  const allowed = [
    'keyword', 'status', 'pages_scanned', 'total_pages',
    'listings_scanned', 'listings_shortlisted',
  ];
  const entries = Object.entries(fields).filter(([k]) => allowed.includes(k));
  if (entries.length === 0) return;

  // Auto-set completed_at when status changes to a terminal state
  const newStatus = fields.status;
  if (newStatus && ['success', 'complete', 'blocked', 'error'].includes(newStatus)) {
    entries.push(['completed_at', new Date().toISOString()]);
  }

  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v);
  db.prepare(`UPDATE searches SET ${sets} WHERE id = ?`).run(...values, id);
}

function getSearches() {
  return db.prepare('SELECT * FROM searches ORDER BY created_at DESC').all();
}

function getSearch(id) {
  return db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
}

function addListing(searchId, { title, price, url, soldCount, screenshotPath, imageUrl }) {
  const created_at = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO listings (search_id, title, price, url, sold_count, screenshot_path, image_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(searchId, title, price, url, soldCount, screenshotPath, imageUrl || null, created_at);
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
}

function getListings(searchId) {
  return db.prepare(
    'SELECT * FROM listings WHERE search_id = ? ORDER BY sold_count DESC'
  ).all(searchId);
}

function updateListingImageByUrl(listingUrl, imageUrl) {
  return db.prepare('UPDATE listings SET image_url = ? WHERE url LIKE ?').run(imageUrl, listingUrl + '%');
}

function deleteSearch(id) {
  db.prepare('DELETE FROM listings WHERE search_id = ?').run(id);
  db.prepare('DELETE FROM searches WHERE id = ?').run(id);
}

function clearAll() {
  db.exec('DELETE FROM listings');
  db.exec('DELETE FROM searches');
}

function getAllListings() {
  return db.prepare(`
    SELECT l.*, s.keyword AS search_keyword
    FROM listings l
    JOIN searches s ON l.search_id = s.id
    ORDER BY l.sold_count DESC
  `).all();
}

module.exports = {
  initDb,
  createSearch,
  updateSearch,
  getSearches,
  getSearch,
  addListing,
  getListings,
  getAllListings,
  updateListingImageByUrl,
  deleteSearch,
  clearAll,
};
