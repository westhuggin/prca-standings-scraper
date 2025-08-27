// scrape/prca.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EVENTS = ['BB','SB','BR','TD','SW','TRH','TRL','LBR'];

async function scrapeOne(eventType, year) {
  const url = `https://www.prorodeo.com/standings?eventType=${eventType}&standingType=world&year=${year}`;
  console.log(`➡️  [${eventType}] ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  const page = await ctx.newPage();

  const debugDir = path.join(process.cwd(), 'data', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    const consent = await page.$('button:has-text("Accept")');
    if (consent) await consent.click().catch(()=>{});

    // Try several row selectors (table or grid)
    const candidates = [
      'table tbody tr',
      'table tr',
      '[role="rowgroup"] [role="row"]',
      '.MuiDataGrid-row',
      '[data-testid*="table"] tr'
    ];

    let foundSel = null, count = 0;
    for (const sel of candidates) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        count = await page.locator(sel).count();
        if (count > 5) { foundSel = sel; break; }
      } catch (_) {}
    }
    if (!foundSel) {
      console.error(`❌ [${eventType}] Rows not found; dumping HTML`);
      fs.writeFileSync(path.join(debugDir, `debug-${eventType}.html`), await page.content());
      await page.screenshot({ path: path.join(debugDir, `debug-${eventType}.png`), fullPage: true }).catch(()=>{});
      await browser.close();
      return [];
    }
    console.log(`✅ [${eventType}] Using selector "${foundSel}" (rows=${count})`);

    // Prefer real table; else parse grid rows
    let data = [];
    const hasTable = await page.$('table');
    if (hasTable) {
      data = await page.$$eval('table', (tables, ctx) => {
        const out = [];
        const best = [...tables]
          .map(t => ({ t, n: t.querySelectorAll('tbody tr').length || t.querySelectorAll('tr').length }))
          .sort((a,b)=>b.n-a.n)[0];
        if (!best || best.n === 0) return out;
        const trs = best.t.querySelectorAll('tbody tr, tr');
        for (const tr of trs) {
          const tds = [...tr.querySelectorAll('td, th')].map(td => td.textContent.trim());
          if (tds.length < 2) continue;
          const placing = Number((tds[0]||'').replace(/[^\d]/g,'')) || null;
          const contestant_name = tds[1] || '';
          const moneyStr = (tds.find(x=>x.includes('$')) || tds[2] || tds[tds.length-1] || '').replace(/[$,]/g,'');
          const earnings = Number(moneyStr) || 0;
          if (contestant_name) out.push({ season: Number(ctx.year), event_code: ctx.eventType, placing, contestant_name, earnings, source_url: ctx.url });
        }
        return out;
      }, { eventType, year, url });
    }
    if (!data || data.length < 5) {
      const gridRows = await page.$$eval('.MuiDataGrid-row, [role="rowgroup"] [role="row"]', (rows, ctx) => {
        const out = [];
        for (const r of rows) {
          const cells = [...r.querySelectorAll('[role="gridcell"], div, span, td')].map(x => x.textContent.trim()).filter(Boolean);
          if (cells.length < 2) continue;
          const placing = Number((cells[0]||'').replace(/[^\d]/g,'')) || null;
          const contestant_name = cells[1] || '';
          const moneyStr = (cells.find(x=>x.includes('$')) || '').replace(/[$,]/g,'');
          const earnings = Number(moneyStr) || 0;
          if (contestant_name) out.push({ season: Number(ctx.year), event_code: ctx.eventType, placing, contestant_name, earnings, source_url: ctx.url });
        }
        return out;
      }, { eventType, year, url });
      if (gridRows && gridRows.length > (data?.length||0)) data = gridRows;
    }

    console.log(`ℹ️  [${eventType}] Extracted ${data.length} rows`);
    await browser.close();
    return data;
  } catch (err) {
    console.error(`❌ [${eventType}] ERROR: ${err && err.message || err}`);
    try { fs.writeFileSync(path.join(debugDir, `debug-${eventType}.html`), await page.content()); } catch (_) {}
    await browser.close();
    return [];
  }
}

(async () => {
  const eventArg = (process.argv[2] || 'BB').toUpperCase();
  const year = process.argv[3] || '2025';

  if (eventArg === 'ALL') {
    let all = [];
    for (const ev of EVENTS) {
      const part = await scrapeOne(ev, year);
      all = all.concat(part);
    }
    console.log(`✅ [ALL] Total rows: ${all.length}`);
    process.stdout.write(JSON.stringify(all, null, 2));
  } else {
    const data = await scrapeOne(eventArg, year);
    console.log(`✅ [${eventArg}] Rows: ${data.length}`);
    process.stdout.write(JSON.stringify(data, null, 2));
  }
})();

// Safety: never crash the job
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED_REJECTION', err && err.message || err);
  try { process.stdout.write('[]'); } catch (_) {}
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err && err.message || err);
  try { process.stdout.write('[]'); } catch (_) {}
  process.exit(0);
});
