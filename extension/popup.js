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
