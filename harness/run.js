'use strict';

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const { parse }    = require('csv-parse/sync');

const ROOT          = path.resolve(__dirname, '..');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const TICKERS_CSV   = path.join(__dirname, 'tickers.csv');
const PAGE_FNS      = fs.readFileSync(path.join(__dirname, 'page-fns.js'), 'utf8');
const CDP_URL       = 'http://localhost:9222';

// ── Ticker loading ─────────────────────────────────────────────────────────────

function loadTickers() {
  const raw     = fs.readFileSync(TICKERS_CSV, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  if (!records.length) throw new Error('tickers.csv is empty');
  const key = Object.keys(records[0]).find(k => /ticker/i.test(k)) ?? Object.keys(records[0])[0];
  return records.map(r => String(r[key]).toUpperCase().trim()).filter(Boolean);
}

// ── Hub cleanup ────────────────────────────────────────────────────────────────

async function closeAllHubs(page) {
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('[id$="-container"]')) {
      const isHub = [...c.querySelectorAll('div')].some(el =>
        [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub')
      );
      if (isHub) c.querySelector('span[aria-label="close"]')?.closest('button')?.click();
    }
  });
  await page.waitForTimeout(400);
}

// ── Per-ticker processing ──────────────────────────────────────────────────────

async function processTicker(page, ticker) {
  // Close any open hub panels from the previous ticker
  await closeAllHubs(page);

  // Snapshot existing container IDs after closing
  const existingIds = await page.evaluate(() =>
    [...document.querySelectorAll('[id$="-container"]')].map(el => el.id)
  );

  // Open Godel Terminal command bar with backtick, type command, press Enter
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(400);
  await page.keyboard.type(`${ticker} EQ TRAN`);
  await page.keyboard.press('Enter');

  // Wait for a Transcript Hub panel with transcripts to appear
  try {
    await page.waitForFunction(
      ({ existingIds, ticker }) => {
        for (const c of document.querySelectorAll('[id$="-container"]')) {
          const isHub = [...c.querySelectorAll('div')].some(el =>
            [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim() === 'Transcript Hub')
          );
          if (!isHub) continue;
          const hasItems = [...c.querySelectorAll('div.cursor-pointer.flex')]
            .some(el => el.querySelector('span.truncate.text-sm'));
          if (!hasItems) continue;
          const isNew = !existingIds.includes(c.id);
          // Input shows "AMZN US" (with exchange suffix) — compare first word only
          const inp        = c.querySelector('input[placeholder="Enter Symbol"]');
          const inputFirst = (inp?.value?.trim() || '').split(/\s+/)[0].toUpperCase();
          const match      = inputFirst === ticker;
          if (isNew || match) return true;
        }
        return false;
      },
      { existingIds, ticker: ticker.toUpperCase() },
      { timeout: 20_000 }
    );
  } catch {
    throw new Error(`${ticker} Transcript Hub did not appear within 20s`);
  }
  await page.waitForTimeout(300);

  const hubs  = await page.evaluate(() => window.__td_findHubs());
  const total = hubs.reduce((n, h) => n + h.transcripts.length, 0);
  console.log(`  hubs: ${hubs.length}  transcripts: ${total}`);

  let saved = 0;
  for (const hub of hubs) {
    for (const t of hub.transcripts) {
      process.stdout.write(`  → ${t.label} … `);

      // Attribute selector avoids the CSS rule that IDs starting with a digit are invalid
      const rows = page
        .locator(`[id="${hub.containerId}"] div.cursor-pointer.flex`)
        .filter({ has: page.locator('span.truncate.text-sm') });
      await rows.nth(t.index).click();

      const text = await page.evaluate(
        async ({ containerId }) => {
          const c   = document.getElementById(containerId);
          const div = c?.querySelector('.injectable-html-n');
          if (!div) return null;
          await window.__td_waitSettle(div);
          return window.__td_extractText(c);
        },
        { containerId: hub.containerId }
      );

      if (!text) { console.log('no text — skipped'); continue; }

      const filename = [
        ticker.replace(/[^a-zA-Z0-9]/g, ''),
        t.quarter.replace(/\s+/g, '_'),
        t.date.replace(/\//g, '-'),
      ].join('_') + '.txt';

      fs.writeFileSync(path.join(DOWNLOADS_DIR, filename), text, 'utf8');
      console.log(`saved (${text.length} chars)`);
      saved++;
    }
  }

  return saved;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const tickers = loadTickers();
  console.log(`Tickers (${tickers.length}): ${tickers.join(', ')}\n`);
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  // Connect to the Chrome you launched via open-chrome.sh
  console.log(`Connecting to Chrome at ${CDP_URL}...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (err) {
    console.error(`\nCould not connect to Chrome. Is it running?\n`);
    console.error(`Run this first:\n  cd harness && ./open-chrome.sh\n`);
    console.error(`Then log in and re-run: npm start\n`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context found');

  // Find the Godel Terminal tab, or use whatever is active
  let page = context.pages().find(p => p.url().includes('godelterminal.com'));
  if (!page) {
    console.warn('No godelterminal.com tab found — using first available tab');
    page = context.pages()[0];
  }
  if (!page) throw new Error('No open tabs found in the connected Chrome');

  console.log(`Connected. Active tab: ${page.url()}\n`);

  // Forward browser logs — only TranscriptDL tags and errors
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error' || text.startsWith('[TranscriptDL]')) {
      console.log(`[browser:${type}] ${text}`);
    }
  });
  page.on('pageerror',     err => console.error(`[page error] ${err.message}`));

  // Inject pure DOM helpers once — persist for the whole session
  await page.evaluate(PAGE_FNS);
  console.log('Page functions injected. Starting ticker loop...\n');

  let totalSaved = 0;
  for (const ticker of tickers) {
    console.log(`━━━ ${ticker} ━━━`);
    try {
      const saved  = await processTicker(page, ticker);
      totalSaved  += saved;
      console.log(`  ✓ ${saved} file${saved === 1 ? '' : 's'} saved`);
    } catch (err) {
      console.error(`  ✗ ${err.message}`);
      const shot = path.join(DOWNLOADS_DIR, `error_${ticker}_${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      console.error(`  screenshot → ${shot}`);
    }
    console.log('');
  }

  console.log(`━━━ Done — ${totalSaved} total files in harness/downloads/ ━━━`);
  // Don't close the browser — user launched it, user can close it
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
