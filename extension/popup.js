// Auto-reload: detect if extension needs update by checking manifest version
// popup.js loads fresh from disk each time, so this bootstraps the new code
const diskVersion = '2.0'; // Must match manifest.json version
const runningVersion = chrome.runtime.getManifest().version;

if (runningVersion !== diskVersion) {
  document.getElementById('status').textContent = 'Updating extension...';
  document.getElementById('status').className = 'status active';
  // Reload the extension to pick up new manifest + background.js + content.js
  chrome.runtime.reload();
  // popup closes automatically on reload
} else {
  // Normal popup behavior
  const statusEl = document.getElementById('status');
  const infoEl = document.getElementById('info');

  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    if (resp && resp.active) {
      statusEl.className = 'status active';
      statusEl.textContent = `Scraping: "${resp.keyword}" — Page ${resp.pagesScanned}/${resp.totalPages}`;
      infoEl.textContent = `${resp.listingsScanned} scanned, ${resp.listingsShortlisted} shortlisted`;
    } else {
      statusEl.className = 'status idle';
      statusEl.textContent = 'Idle — waiting for searches';
    }
  });

  document.getElementById('openDash').addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://localhost:3000' });
  });
}
