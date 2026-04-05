// Transcript Downloader - Content Script

function findTranscriptHubs() {
  const hubs = [];

  const containers = document.querySelectorAll('[id$="-container"]');

  for (const container of containers) {
    // Confirm it's a Transcript Hub by checking for the title text node
    const isHub = [...container.querySelectorAll('div')].some(
      (el) => [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub'
      )
    );
    if (!isHub) continue;

    // Get ticker symbol
    const tickerInput = container.querySelector('input[placeholder="Enter Symbol"]');
    const ticker = tickerInput ? tickerInput.value.trim() : 'UNKNOWN';

    // Collect list items (divs with cursor-pointer containing a quarter span)
    const listItems = [...container.querySelectorAll('div.cursor-pointer.flex')].filter(
      (el) => el.querySelector('span.truncate.text-sm') !== null
    );

    // Deduplicate by quarter+date — keep only the first occurrence of each pair
    const seen = new Set();
    const transcripts = [];
    listItems.forEach((item, rawIndex) => {
      const quarter = item.querySelector('span.truncate.text-sm')?.textContent.trim() || '';
      const date = item.querySelector('.text-right')?.textContent.trim() || '';
      const key = `${quarter}__${date}`;
      if (!seen.has(key)) {
        seen.add(key);
        transcripts.push({ index: rawIndex, quarter, date, label: `${quarter} — ${date}` });
      }
    });

    hubs.push({ containerId: container.id, ticker, transcripts });
  }

  return hubs;
}

function extractTranscriptText(container) {
  const contentDiv = container.querySelector('.injectable-html-n');
  if (!contentDiv) return null;

  const lines = [];

  const headerH2 = contentDiv.querySelector('.transcript-header h2');
  if (headerH2) {
    lines.push(headerH2.textContent.trim());
    lines.push('='.repeat(60));
    lines.push('');
  }

  // Walk all speaker blocks and paragraphs in document order
  const walker = document.createTreeWalker(contentDiv, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.classList.contains('speaker-details') || node.classList.contains('content-para')) {
        return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    if (node.classList.contains('speaker-details')) {
      const name = node.querySelector('h6')?.textContent.trim() || '';
      const role = node.querySelector('p')?.textContent.trim() || '';
      if (name) {
        lines.push('');
        lines.push(role ? `${name} — ${role}` : name);
        lines.push('-'.repeat(40));
      }
    } else if (node.classList.contains('content-para')) {
      const text = node.textContent.trim();
      if (text) lines.push(text);
    }
  }

  return lines.join('\n');
}

// Waits until the content div stops mutating for `quietMs` in a row,
// or until `timeoutMs` elapses — whichever comes first.
// If content never changes at all we resolve immediately (already loaded).
async function waitForContentSettle(contentDiv, quietMs = 150, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let changed = false;
    let mutationCount = 0;
    let quietTimer = null;
    let resolved = false;
    const start = Date.now();

    const done = (reason) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(quietTimer);
        clearTimeout(hardTimeout);
        observer.disconnect();
        console.log(`[TranscriptDL] settle done — reason: ${reason}, mutations: ${mutationCount}, elapsed: ${Date.now() - start}ms`);
        resolve();
      }
    };

    const observer = new MutationObserver(() => {
      mutationCount++;
      if (mutationCount === 1) console.log(`[TranscriptDL] first mutation at ${Date.now() - start}ms`);
      changed = true;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => done('quiet'), quietMs);
    });

    observer.observe(contentDiv, { childList: true, subtree: true, characterData: true });

    const hardTimeout = setTimeout(() => done('timeout'), timeoutMs);

    // If nothing changes within 50ms, content is already loaded
    setTimeout(() => { if (!changed) done('already-loaded'); }, 50);
  });
}

async function downloadSelected(selections) {
  let saved = 0;

  // Group by container
  const byContainer = {};
  for (const sel of selections) {
    if (!byContainer[sel.containerId]) byContainer[sel.containerId] = [];
    byContainer[sel.containerId].push(sel);
  }

  for (const [containerId, items] of Object.entries(byContainer)) {
    const container = document.getElementById(containerId);
    if (!container) continue;

    const contentDiv = container.querySelector('.injectable-html-n');
    if (!contentDiv) continue;

    const listItems = [...container.querySelectorAll('div.cursor-pointer.flex')].filter(
      (el) => el.querySelector('span.truncate.text-sm') !== null
    );

    for (const item of items) {
      const listItem = listItems[item.transcriptIndex];
      if (!listItem) continue;

      console.log(`[TranscriptDL] clicking transcript ${item.quarter} ${item.date}`);
      listItem.click();
      await waitForContentSettle(contentDiv);

      const text = extractTranscriptText(container);
      console.log(`[TranscriptDL] extracted ${text?.length ?? 0} chars for ${item.quarter} ${item.date}`);
      if (!text) continue;

      const safeTicker = item.ticker.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      const safeQuarter = item.quarter.replace(/\s+/g, '_');
      const safeDate = item.date.replace(/\//g, '-');
      const filename = `${safeTicker}_${safeQuarter}_${safeDate}.txt`;

      // Send to background service worker so the download survives popup close
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'SAVE_FILE', filename, text }, resolve);
      });

      saved++;
    }
  }

  return { saved };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCAN') {
    try {
      sendResponse({ ok: true, hubs: findTranscriptHubs() });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return false;
  }

  if (msg.type === 'DOWNLOAD') {
    downloadSelected(msg.selections)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
});
