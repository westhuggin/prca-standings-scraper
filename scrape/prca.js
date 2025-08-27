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
    // give client-side JS time to render
    await page.waitForTimeout(3000);

    // some sites gate content behind cookie/consent banners
    const consentBtn = await page.$('button:has-text("Accept")');
    if (consentBtn) { await consentBtn.click().catch(()=>{}); }

    // try a few selectors that often show standings
    const candidateSelectors = [
      'table tbody tr',
      'table tr',
      '[role="rowgroup"] [role="row"]',         // ARIA grids
      '.MuiDataGrid-row',                        // MUI DataGrid
      '[data-testid*="table"] tr'
    ];

    let rowsCount = 0;
    for (const sel of candidateSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 15000 });
        rowsCount = await page.locator(sel).count();
        if (rowsCount > 5) { // looks like a table
          console.log(`✅ [${eventType}] Found rows via selector: ${sel} (count=${rowsCount})`);
          break;
        }
      } catch (_) { /* try next */ }
    }

    if (rowsCount === 0) {
      console.error(`❌ [${eventType}] Could not find rows; dumping HTML for inspection`);
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, `debug-${eventType}.html`), html);
      await page.screenshot({ path: path.join(debugDir, `debug-${eventType}.png`), fullPage: true }).catch(()=>{});
      await browser.close();
      return [];
    }

    // Prefer real <table>; else try to synthesize from row-like elements
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
          if (contestant_name) {
            out.push({ season: Number(ctx.year), event_code: ctx.eventType, placing, contestant_name, earnings, source_url: ctx.url });
          }
        }
        return out;
      }, { eventType, year, url });
    }

    // If table parse failed or tiny, try ARIA/data-grid rows
    if (!data || data.length < 5) {
      const gridRows = await page.$$eval(
        '.MuiDataGrid-row, [role="rowgroup"] [role="row"]',
        (rows, ctx) => {
          const out = [];
          for (const r of rows) {
            const cells = [...r.querySelectorAll('[role="gridcell"], div, span, td')].map(x => x.textContent.trim()).filter(Boolean);
            if (cells.length < 2) continue;
            const placing = Number((cells[0]||'').replace(/[^\d]/g,'')) || null;
            const contestant_name = cells[1] || '';
            const moneyStr = (cells.find(x=>x.includes('$')) || '').replace(/[$,]/g,'');
            const earnings = Number(moneyStr) || 0;
            if (contestant_name) {
              out.push({ season: Number(ctx.year), event_code: ctx.eventType, placing, contestant_name, earnings, source_url: ctx.url });
            }
          }
          return out;
        },
        { eventType, year, url }
      );
      if (gridRows && gridRows.length > (data?.length||0)) data = gridRows;
    }

    console.log(`ℹ️  [${eventType}] Extracted ${data.length} rows`);
    await browser.close();
    return data;
  } catch (err) {
    console.error(`❌ [${eventType}] ERROR: ${err && err.message || err}`);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(debugDir, `debug-${eventTy
