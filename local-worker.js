#!/usr/bin/env node
/**
 * Local Worker — polls the Railway server for new searches and runs them locally.
 *
 * Usage:
 *   node local-worker.js
 *
 * This script polls the live Railway API every 10 seconds for searches with
 * status "running" and 0 pages scanned (i.e. freshly created). When it finds one,
 * it spawns scanner.js locally (which uses your real Chrome + cookies) and points
 * it at the Railway API so results appear on the live site.
 *
 * Set REMOTE_URL env var to override the Railway URL:
 *   REMOTE_URL=https://your-app.up.railway.app node local-worker.js
 */

const { spawn } = require('child_process');
const path = require('path');

const REMOTE_URL = process.env.REMOTE_URL || 'https://etsy-scraper-production.up.railway.app';
const POLL_INTERVAL = 10000; // 10 seconds
const SCANNER_PATH = path.join(__dirname, 'scanner.js');

// Track which searches we've already started scanning
const activeScans = new Set();

function log(...args) {
  console.log(`[worker ${new Date().toISOString()}]`, ...args);
}

async function pollForSearches() {
  try {
    const res = await fetch(`${REMOTE_URL}/api/searches`);
    if (!res.ok) {
      log(`API returned ${res.status}`);
      return;
    }
    const searches = await res.json();

    for (const search of searches) {
      const isNew = (search.status === 'running' || search.status === 'pending')
                    && (search.pagesScraped || 0) === 0
                    && !activeScans.has(search.id);

      if (isNew) {
        log(`Found new search: "${search.keyword}" (${search.id})`);
        startScanner(search.id, search.keyword);
      }
    }
  } catch (err) {
    log('Poll error:', err.message);
  }
}

function startScanner(searchId, keyword) {
  activeScans.add(searchId);
  log(`Starting local scanner for "${keyword}"...`);

  const child = spawn(process.execPath, [SCANNER_PATH, searchId, keyword], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      SERVER_BASE: REMOTE_URL,
      PATH: `/opt/homebrew/bin:${process.env.PATH}`,
    },
  });

  child.on('close', (code) => {
    log(`Scanner for "${keyword}" exited with code ${code}`);
    activeScans.delete(searchId);
  });

  child.on('error', (err) => {
    log(`Scanner spawn error for "${keyword}": ${err.message}`);
    activeScans.delete(searchId);
  });
}

// Main loop
log(`Local worker started. Polling ${REMOTE_URL} every ${POLL_INTERVAL / 1000}s`);
log('Searches created on the live site will be picked up and scanned locally.');
log('Press Ctrl+C to stop.\n');

pollForSearches();
setInterval(pollForSearches, POLL_INTERVAL);
