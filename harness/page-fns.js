// Injected into the live page via page.evaluate() — NO chrome.* APIs.
// Functions mirror content.js logic but are namespaced under window.__td_*
// so they survive across ticker changes without re-injection.

window.__td_findHubs = function findHubs() {
  const hubs = [];
  for (const container of document.querySelectorAll('[id$="-container"]')) {
    const isHub = [...container.querySelectorAll('div')].some(el =>
      [...el.childNodes].some(
        n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub'
      )
    );
    if (!isHub) continue;

    const tickerInput = container.querySelector('input[placeholder="Enter Symbol"]');
    const ticker = tickerInput ? tickerInput.value.trim() : 'UNKNOWN';

    const listItems = [...container.querySelectorAll('div.cursor-pointer.flex')].filter(
      el => el.querySelector('span.truncate.text-sm') !== null
    );

    const seen = new Set();
    const transcripts = [];
    listItems.forEach((item, rawIndex) => {
      const quarter = item.querySelector('span.truncate.text-sm')?.textContent.trim() || '';
      const date    = item.querySelector('.text-right')?.textContent.trim() || '';
      const key     = `${quarter}__${date}`;
      if (!seen.has(key)) {
        seen.add(key);
        transcripts.push({ index: rawIndex, quarter, date, label: `${quarter} — ${date}` });
      }
    });

    hubs.push({ containerId: container.id, ticker, transcripts });
  }
  return hubs;
};

window.__td_extractText = function extractText(container) {
  const contentDiv = container.querySelector('.injectable-html-n');
  if (!contentDiv) return null;

  const lines = [];
  const h2 = contentDiv.querySelector('.transcript-header h2');
  if (h2) { lines.push(h2.textContent.trim(), '='.repeat(60), ''); }

  const walker = document.createTreeWalker(contentDiv, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      return (node.classList.contains('speaker-details') || node.classList.contains('content-para'))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    if (node.classList.contains('speaker-details')) {
      const name = node.querySelector('h6')?.textContent.trim() || '';
      const role = node.querySelector('p')?.textContent.trim()  || '';
      if (name) { lines.push('', role ? `${name} — ${role}` : name, '-'.repeat(40)); }
    } else {
      const text = node.textContent.trim();
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
};

window.__td_waitSettle = function waitSettle(contentDiv, quietMs = 150, timeoutMs = 5000) {
  return new Promise(resolve => {
    let changed = false, mutations = 0, quietTimer = null, done = false;
    const t0 = Date.now();

    const finish = reason => {
      if (done) return;
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(hard);
      observer.disconnect();
      console.log(`[TranscriptDL] settle: ${reason} | ${mutations} mutations | ${Date.now() - t0}ms`);
      resolve();
    };

    const observer = new MutationObserver(() => {
      mutations++;
      changed = true;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), quietMs);
    });

    observer.observe(contentDiv, { childList: true, subtree: true, characterData: true });
    const hard = setTimeout(() => finish('timeout'), timeoutMs);
    setTimeout(() => { if (!changed) finish('already-loaded'); }, 50);
  });
};

console.log('[TranscriptDL] page-fns injected');
