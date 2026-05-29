'use strict';

// monitor.js — Connect to your Chrome, observe everything you do.
// Run: npm run monitor
// Then click through the page manually. All events, DOM state, and screenshots
// are saved to harness/monitor-logs/ so Claude can see the full structure.

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const CDP_URL  = 'http://localhost:9222';
const LOG_DIR  = path.join(__dirname, 'monitor-logs');

// ── Logging ────────────────────────────────────────────────────────────────────

let logStream;
function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 23)}] ${msg}`;
  console.log(line);
  logStream?.write(line + '\n');
}

// ── Screenshot ─────────────────────────────────────────────────────────────────

let screenshotSeq = 0;
async function screenshot(page, label) {
  const n    = String(++screenshotSeq).padStart(3, '0');
  const file = path.join(LOG_DIR, `${n}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(e => log(`screenshot failed: ${e.message}`));
  log(`[screenshot] → ${path.basename(file)}`);
  return file;
}

// ── DOM dump ───────────────────────────────────────────────────────────────────

// Saves the outer HTML of every hub container to a file — this is the raw
// structure needed to figure out selectors for click targets, close buttons, etc.
async function dumpHubHtml(page, label) {
  const htmls = await page.evaluate(() => {
    const results = [];
    for (const c of document.querySelectorAll('[id$="-container"]')) {
      const isHub = [...c.querySelectorAll('div')].some(el =>
        [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub')
      );
      if (isHub) results.push({ id: c.id, html: c.outerHTML });
    }
    return results;
  });

  for (const { id, html } of htmls) {
    const n    = String(screenshotSeq).padStart(3, '0');
    const file = path.join(LOG_DIR, `${n}-${label}-hub-${id}.html`);
    fs.writeFileSync(file, html, 'utf8');
    log(`[dom-dump] hub#${id} → ${path.basename(file)} (${html.length} chars)`);
  }
}

// ── State summary ──────────────────────────────────────────────────────────────

async function dumpState(page) {
  const state = await page.evaluate(() => {
    const hubs = [];
    for (const c of document.querySelectorAll('[id$="-container"]')) {
      const isHub = [...c.querySelectorAll('div')].some(el =>
        [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub')
      );
      if (!isHub) continue;

      const ticker = c.querySelector('input[placeholder="Enter Symbol"]')?.value?.trim() || '?';
      const rows   = [...c.querySelectorAll('div.cursor-pointer.flex')]
        .filter(el => el.querySelector('span.truncate.text-sm'));

      // Find anything that looks like a close/dismiss button
      const closeCandidates = [...c.querySelectorAll('button, [role="button"], svg, [class*="close"], [class*="dismiss"], [aria-label]')]
        .filter(el => {
          const txt  = el.textContent.trim();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const cls  = [...el.classList].join(' ').toLowerCase();
          return txt === '×' || txt === 'X' || txt === '✕' || txt === '✗' ||
                 aria.includes('close') || cls.includes('close') || cls.includes('dismiss');
        })
        .slice(0, 5)
        .map(el => ({
          tag:   el.tagName,
          text:  el.textContent.trim().slice(0, 15),
          cls:   [...el.classList].slice(0, 4).join('.'),
          aria:  el.getAttribute('aria-label') || '',
        }));

      const contentDiv  = c.querySelector('.injectable-html-n');
      const contentText = contentDiv?.textContent?.trim().slice(0, 120) || '(empty)';

      hubs.push({ id: c.id, ticker, rowCount: rows.length,
                  firstRow: rows[0]?.textContent?.trim().slice(0, 50) || '',
                  closeCandidates, contentPreview: contentText });
    }
    return hubs;
  });

  if (!state.length) { log('[state] no hubs found'); return; }

  log(`[state] ${state.length} hub(s) open:`);
  for (const h of state) {
    log(`  #${h.id}  ticker=${h.ticker}  rows=${h.rowCount}`);
    log(`    firstRow: "${h.firstRow}"`);
    log(`    content:  "${h.contentPreview}"`);
    if (h.closeCandidates.length) {
      log(`    close candidates: ${JSON.stringify(h.closeCandidates)}`);
    } else {
      log(`    close candidates: none found — check dumped HTML`);
    }
  }
}

// ── Injected observers ─────────────────────────────────────────────────────────

async function injectObservers(page) {
  await page.evaluate(() => {
    if (window.__monitorInstalled) return;
    window.__monitorInstalled = true;

    // Click: log target + first 5 ancestors with IDs or data attributes
    document.addEventListener('click', e => {
      const el   = e.target;
      const tag  = el.tagName;
      const id   = el.id   ? `#${el.id}` : '';
      const cls  = [...el.classList].slice(0, 4).map(c => `.${c}`).join('');
      const text = el.textContent.trim().slice(0, 60).replace(/\s+/g, ' ');
      console.log(`[CLICK] ${tag}${id}${cls} | "${text}"`);

      let p = el.parentElement;
      for (let i = 1; i <= 4 && p; i++, p = p.parentElement) {
        const pid  = p.id ? `#${p.id}` : '';
        const pcls = [...p.classList].slice(0, 3).map(c => `.${c}`).join('');
        if (pid || pcls) console.log(`[CLICK:^${i}] ${p.tagName}${pid}${pcls}`);
      }
    }, true);

    // DOM mutations: batch and summarise
    let batch = [], batchTimer = null;
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes)   if (n.nodeType === 1) batch.push(`+${n.tagName}${n.id ? '#'+n.id : ''}.${[...n.classList].join('.')}`);
        for (const n of m.removedNodes) if (n.nodeType === 1) batch.push(`-${n.tagName}${n.id ? '#'+n.id : ''}.${[...n.classList].join('.')}`);
      }
      clearTimeout(batchTimer);
      batchTimer = setTimeout(() => {
        if (!batch.length) return;
        const preview = batch.slice(0, 8).join(' | ');
        const extra   = batch.length > 8 ? ` (+${batch.length - 8} more)` : '';
        console.log(`[DOM] ${preview}${extra}`);
        batch = [];
      }, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: false });
    console.log('[monitor] observers installed');
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `session-${Date.now()}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  log(`Log file: ${logFile}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error(`Cannot connect to Chrome at ${CDP_URL}`);
    console.error('Run ./open-chrome.sh first, then npm run monitor');
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page    = context.pages().find(p => p.url().includes('godelterminal')) ?? context.pages()[0];
  log(`Connected: ${page.url()}`);

  // Forward ALL browser console messages
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') log(`[browser:ERROR] ${text}`);
    else if (text.startsWith('[CLICK]') || text.startsWith('[DOM]') || text.startsWith('[monitor]')) log(`[browser] ${text}`);
  });
  page.on('pageerror', err => log(`[page error] ${err.message}`));

  await injectObservers(page);

  // Initial snapshot
  await dumpState(page);
  await screenshot(page, 'initial');
  await dumpHubHtml(page, 'initial');

  // After every click: wait briefly, take screenshot + dump DOM + state
  let clickCooldown = false;
  page.on('console', async msg => {
    const text = msg.text();
    if (!text.startsWith('[CLICK]') || clickCooldown) return;
    clickCooldown = true;
    try {
      await page.waitForTimeout(800); // let page react to click
      await screenshot(page, 'click');
      await dumpState(page);
      await dumpHubHtml(page, 'click');
    } finally {
      setTimeout(() => { clickCooldown = false; }, 500);
    }
  });

  // Periodic state dump every 5s even without clicks
  const periodic = setInterval(() => dumpState(page).catch(() => {}), 5000);

  log('');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Monitor running. Click through the page normally.  ');
  log('  Every click → screenshot + DOM dump + state log.   ');
  log(`  All output → ${LOG_DIR}/`);
  log('  Ctrl+C to stop.');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.on('SIGINT', async () => {
    clearInterval(periodic);
    await screenshot(page, 'final').catch(() => {});
    log('Monitor stopped.');
    logStream.end();
    process.exit(0);
  });

  await new Promise(() => {}); // keep alive
}

main().catch(err => { console.error('[fatal]', err); process.exit(1); });
