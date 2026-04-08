#!/usr/bin/env node
/**
 * Local Worker — polls the Railway server for new searches and runs them locally.
 * Processes one search at a time in queue order (oldest first).
 *
 * Usage:
 *   node local-worker.js
 *
 * Set REMOTE_URL env var to override the Railway URL:
 *   REMOTE_URL=https://your-app.up.railway.app node local-worker.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');

const REMOTE_URL = process.env.REMOTE_URL || 'https://etsy-scraper-production.up.railway.app';
const POLL_INTERVAL = 10000; // 10 seconds
const SCANNER_PATH = path.join(__dirname, 'scanner.js');

const CAPTCHA_EXIT_CODE = 42;
const MAX_CAPTCHA_RETRIES = 3;

// Queue state
let currentScan = null;  // { searchId, keyword } or null if idle
const processedScans = new Set(); // Track completed/failed scans to avoid re-processing

function log(...args) {
  console.log(`[worker ${new Date().toISOString()}]`, ...args);
}

function killChromeDebugPort() {
  try { execSync('lsof -ti:9333 | xargs kill -9 2>/dev/null', { stdio: 'ignore' }); } catch {}
}

async function pollForSearches() {
  try {
    const res = await fetch(`${REMOTE_URL}/api/searches`);
    if (!res.ok) {
      log(`API returned ${res.status}`);
      return;
    }
    const searches = await res.json();

    // Find pending searches (not yet started), oldest first
    const pending = searches
      .filter(s => {
        const age = Date.now() - new Date(s.createdAt).getTime();
        return (s.status === 'pending' || (s.status === 'running' && (s.pagesScraped || 0) === 0))
          && age < 60 * 60 * 1000  // Ignore searches older than 1 hour
          && !processedScans.has(s.id);
      })
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest first

    if (pending.length > 0 && !currentScan) {
      // Pick up the oldest pending search
      const next = pending[0];
      log(`Queue: ${pending.length} pending search(es). Starting: "${next.keyword}" (${next.id})`);
      if (pending.length > 1) {
        log(`  Queued: ${pending.slice(1).map(s => `"${s.keyword}"`).join(', ')}`);
      }
      startScanner(next.id, next.keyword);
    } else if (pending.length > 0 && currentScan) {
      // Log queue status periodically
      log(`Scanner busy with "${currentScan.keyword}". ${pending.length} search(es) queued.`);
    }
  } catch (err) {
    log('Poll error:', err.message);
  }
}

function startScanner(searchId, keyword, captchaRetry = 0) {
  currentScan = { searchId, keyword };
  log(`Starting scanner for "${keyword}"${captchaRetry > 0 ? ` (CAPTCHA retry ${captchaRetry}/${MAX_CAPTCHA_RETRIES})` : ''}...`);

  // Mark search as running on the server
  fetch(`${REMOTE_URL}/api/searches/${searchId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'running' }),
  }).catch(() => {});

  const child = spawn(process.execPath, [SCANNER_PATH, searchId, keyword], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      SERVER_BASE: REMOTE_URL,
      PATH: `/opt/homebrew/bin:${process.env.PATH}`,
    },
  });

  child.on('close', async (code) => {
    killChromeDebugPort();

    if (code === CAPTCHA_EXIT_CODE && captchaRetry < MAX_CAPTCHA_RETRIES) {
      const waitSec = 60 + (captchaRetry * 60);
      log(`Scanner for "${keyword}" hit CAPTCHA (exit ${code}). Retrying in ${waitSec}s... (attempt ${captchaRetry + 1}/${MAX_CAPTCHA_RETRIES})`);
      setTimeout(() => {
        startScanner(searchId, keyword, captchaRetry + 1);
      }, waitSec * 1000);
    } else if (code === 0 || code === null) {
      // Check if all pages are done
      try {
        const res = await fetch(`${REMOTE_URL}/api/searches/${searchId}`);
        if (res.ok) {
          const search = await res.json();
          if (search.pagesScraped < 20 && search.status !== 'blocked') {
            log(`Scanner for "${keyword}" completed ${search.pagesScraped}/20 pages. Resuming in 10s...`);
            setTimeout(() => {
              startScanner(searchId, keyword, 0);
            }, 10000);
            return;
          }
        }
      } catch (err) {
        log('Error checking completion:', err.message);
      }
      log(`Scanner for "${keyword}" completed successfully.`);
      finishCurrentScan(searchId);
    } else {
      if (code === CAPTCHA_EXIT_CODE) {
        log(`Scanner for "${keyword}" hit CAPTCHA ${MAX_CAPTCHA_RETRIES} times. Giving up.`);
      } else {
        log(`Scanner for "${keyword}" exited with code ${code}`);
      }
      finishCurrentScan(searchId);
    }
  });

  child.on('error', (err) => {
    log(`Scanner spawn error for "${keyword}": ${err.message}`);
    finishCurrentScan(searchId);
  });
}

function finishCurrentScan(searchId) {
  processedScans.add(searchId);
  currentScan = null;
  log('Scanner idle — checking queue for next search...');
  // Immediately poll for the next queued search
  pollForSearches();
}

// Main loop
log(`Local worker started. Polling ${REMOTE_URL} every ${POLL_INTERVAL / 1000}s`);
log('Searches are processed one at a time in queue order.');
log('Press Ctrl+C to stop.\n');

pollForSearches();
setInterval(pollForSearches, POLL_INTERVAL);
