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
      listings_shortlisted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id TEXT NOT NULL REFERENCES searches(id),
      title TEXT,
      price TEXT,
      url TEXT,
      sold_count INTEGER,
      screenshot_path TEXT,
      created_at TEXT NOT NULL
    );
  `);

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

function addListing(searchId, { title, price, url, soldCount, screenshotPath }) {
  const created_at = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO listings (search_id, title, price, url, sold_count, screenshot_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(searchId, title, price, url, soldCount, screenshotPath, created_at);
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
}

function getListings(searchId) {
  return db.prepare(
    'SELECT * FROM listings WHERE search_id = ? ORDER BY sold_count DESC'
  ).all(searchId);
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
};
