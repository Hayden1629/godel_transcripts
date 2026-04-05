// Transcript Downloader - Popup Script

const contentEl = document.getElementById('content');
const statusEl = document.getElementById('status');
const footerEl = document.getElementById('footer');
const downloadBtn = document.getElementById('download-btn');
const downloadStatusEl = document.getElementById('download-status');

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getChecked() {
  const results = [];
  document.querySelectorAll('.transcript-item input[type="checkbox"]:checked').forEach((cb) => {
    results.push(JSON.parse(cb.dataset.meta));
  });
  return results;
}

function updateDownloadBtn() {
  const count = getChecked().length;
  downloadBtn.disabled = count === 0;
  downloadBtn.textContent = count > 0
    ? `Download ${count} Transcript${count === 1 ? '' : 's'}`
    : 'Download Selected';
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderHubs(hubs) {
  if (!hubs.length) {
    contentEl.innerHTML = '<div class="empty">No Transcript Hubs found on this page.<br>Open a Transcript Hub panel first.</div>';
    setStatus('None found');
    return;
  }

  contentEl.innerHTML = '';
  footerEl.style.display = 'flex';

  for (const hub of hubs) {
    const hubEl = document.createElement('div');
    hubEl.className = 'hub';

    hubEl.innerHTML = `
      <div class="hub-header">
        <span class="hub-ticker">${escapeHtml(hub.ticker)}</span>
        <span class="hub-count">${hub.transcripts.length} transcript${hub.transcripts.length === 1 ? '' : 's'}</span>
        <div class="hub-actions">
          <button class="btn-small" data-action="select-all" data-hub="${escapeHtml(hub.containerId)}">All</button>
          <button class="btn-small" data-action="deselect-all" data-hub="${escapeHtml(hub.containerId)}">None</button>
        </div>
      </div>
      <div class="transcript-list" data-hub-id="${escapeHtml(hub.containerId)}"></div>
    `;

    const list = hubEl.querySelector('.transcript-list');

    for (const t of hub.transcripts) {
      const meta = JSON.stringify({
        containerId: hub.containerId,
        ticker: hub.ticker,
        transcriptIndex: t.index,
        quarter: t.quarter,
        date: t.date,
      });

      const item = document.createElement('div');
      item.className = 'transcript-item';
      item.innerHTML = `
        <input type="checkbox" data-meta='${meta.replace(/'/g, '&apos;')}' />
        <span class="transcript-label">${escapeHtml(t.label)}</span>
      `;
      list.appendChild(item);
    }

    contentEl.appendChild(hubEl);
  }

  // All / None buttons
  contentEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const checked = btn.dataset.action === 'select-all';
    document.querySelectorAll(`.transcript-list[data-hub-id="${btn.dataset.hub}"] input[type="checkbox"]`)
      .forEach((cb) => { cb.checked = checked; });
    updateDownloadBtn();
  });

  contentEl.addEventListener('change', (e) => {
    if (e.target.type === 'checkbox') updateDownloadBtn();
  });

  const total = hubs.reduce((n, h) => n + h.transcripts.length, 0);
  setStatus(`${hubs.length} hub${hubs.length === 1 ? '' : 's'}, ${total} transcripts`);
  updateDownloadBtn();
}

// ── Download ──────────────────────────────────────────────────────────────────

downloadBtn.addEventListener('click', async () => {
  const selections = getChecked();
  if (!selections.length) return;

  downloadBtn.disabled = true;
  downloadBtn.textContent = `Downloading ${selections.length} transcript${selections.length === 1 ? '' : 's'}…`;
  downloadStatusEl.textContent = 'Files will save even if you close this popup.';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { type: 'DOWNLOAD', selections }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      const err = chrome.runtime.lastError?.message || response?.error || 'unknown error';
      downloadStatusEl.textContent = `Error: ${err}`;
    } else {
      downloadStatusEl.textContent = `Done — ${response.saved} file${response.saved === 1 ? '' : 's'} saved.`;
    }
    updateDownloadBtn();
  });
});

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) {
    // Already injected or restricted page — proceed anyway
  }

  chrome.tabs.sendMessage(tab.id, { type: 'SCAN' }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error');
      contentEl.innerHTML = `<div class="empty">Could not connect to page.<br><small>${escapeHtml(chrome.runtime.lastError.message)}</small></div>`;
      return;
    }
    if (!response?.ok) {
      setStatus('Error');
      contentEl.innerHTML = `<div class="empty">Scan failed: ${escapeHtml(response?.error || 'unknown')}</div>`;
      return;
    }
    renderHubs(response.hubs);
  });
}

init();
