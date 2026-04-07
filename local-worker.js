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
      // Only pick up searches created in the last 10 minutes (ignore stale ones)
      const age = Date.now() - new Date(search.createdAt).getTime();
      const isNew = (search.status === 'running' || search.status === 'pending')
                    && (search.pagesScraped || 0) === 0
                    && age < 10 * 60 * 1000
                    && !activeScans.has(search.id);

      if (isNew) {
        log(`Found new search: "${search.keyword}" (${search.id}) — created ${Math.round(age / 1000)}s ago`);
        startScanner(search.id, search.keyword);
      }
    }
  } catch (err) {
    log('Poll error:', err.message);
  }
}

const CAPTCHA_EXIT_CODE = 42;
const MAX_CAPTCHA_RETRIES = 3;
const PROFILE_DIR = require('path').join(require('os').homedir(), '.etsy-scraper-profile');

function startScanner(searchId, keyword, captchaRetry = 0) {
  activeScans.add(searchId);
  log(`Starting local scanner for "${keyword}"${captchaRetry > 0 ? ` (CAPTCHA retry ${captchaRetry}/${MAX_CAPTCHA_RETRIES})` : ''}...`);

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
    if (code === CAPTCHA_EXIT_CODE && captchaRetry < MAX_CAPTCHA_RETRIES) {
      // CAPTCHA detected — delete stale profile clone, wait, and retry
      log(`Scanner for "${keyword}" hit CAPTCHA (exit 42). Deleting profile and retrying in 30s...`);
      try {
        require('child_process').execSync(`rm -rf "${PROFILE_DIR}/Default"`, { stdio: 'ignore' });
        log('Deleted stale profile clone');
      } catch {}
      setTimeout(() => {
        startScanner(searchId, keyword, captchaRetry + 1);
      }, 30000);
    } else {
      if (code === CAPTCHA_EXIT_CODE) {
        log(`Scanner for "${keyword}" hit CAPTCHA ${MAX_CAPTCHA_RETRIES} times. Giving up.`);
      } else {
        log(`Scanner for "${keyword}" exited with code ${code}`);
      }
      activeScans.delete(searchId);
    }
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
