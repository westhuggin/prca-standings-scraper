// scrape/prca.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const EVENTS = ['BB','SB','BR','TD','SW','TRH','TRL','LBR'];

function normalizeRows(rows, eventType, year, source_url) {
  const out = [];
  for (const r of rows || []) {
    // Try common field names seen in standings JSONs
    const placing = Number(
      (r.placing ?? r.rank ?? r.position ?? r.place ?? '').toString().replace(/[^\d]/g,'')
    ) || null;

    const name =
      r.contestant_name ??
      r.contestantName ??
      r.athleteName ??
      r.name ??
      r.headerName ??
      r.heelerName ??
      r.ladyName ??
      r.lastFirst ??
      r.competitor ??
      '';

    // earnings field hunt
    const moneyRaw = (
      r.earnings ?? r.money ?? r.total ?? r.totalEarnings ?? r.world_earnings ?? r.amount ?? ''
    ).toString();

    const earnings =
      typeof r.earnings === 'number' ? r.earnings :
      Number(moneyRaw.replace(/[$,]/g,'')) || 0;

    const contestant_name = (name || '').toString().trim();
    if (!contestant_name) continue;

    out.push({
      season: Number(year),
      event_code: eventType,
      placing,
      contestant_name,
      earnings,
      source_url
    });
  }
  return out;
}

// Deep search utility to find arrays of row-ish objects in big JSON blobs
function* deepArrays(obj, path=[]) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) yield { arr: obj, path };
  for (const [k,v] of Object.entries(obj)) {
    yield* deepArrays(v, path.concat(k));
  }
}

async function scrapeOne(eventType, year) {
  const url = `https://www.prorodeo.com/standings?eventType=${eventType}&standingType=world&year=${year}`;
  console.log(`➡️  [${eventType}] ${url}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    javaScriptEnabled: true
  });
  const page = await ctx.newPage();

  const debugDir = path.join(process.cwd(), 'data', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });

  // Capture JSON/XHR responses for fallback
  const jsonResponses = [];
  page.on('response', async (resp) => {
    try {
      const ct = resp.headers()['content-type'] || '';
      const isJson = ct.includes('application/json');
      const url = resp.url();
      if (isJson && /standings|ranking|grid|data|table|api|graphql/i.test(url)) {
        const body = await resp.json().catch(()=>null);
        if (body) jsonResponses.push({ url, body });
      }
    } catch (_) {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

    // cookie/consent if present
    const consent = await page.$('button:has-text("Accept"), button:has-text("I Accept")');
    if (consent) await consent.click().catch(()=>{});

    // Let the app fetch data
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
    // Nudge lazy loaders
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);

    // 1) Try Next.js data blob first
    let dataRows = [];
    const nextData = await page.$('script#__NEXT_DATA__');
    if (nextData) {
      try {
        const txt = await nextData.textContent();
        const obj = JSON.parse(txt);
        let best = [];
        for (const hit of deepArrays(obj)) {
          // Heuristic: array of objects with a name and money-like field
          const sample = hit.arr.find(x => x && typeof x === 'object');
          if (!sample) continue;
          const keys = Object.keys(sample);
          const looksLikeRow =
            keys.some(k => /name|contestant|athlete|header|heeler|lady/i.test(k)) &&
            keys.some(k => /earn|money|total|amount|world/i.test(k));
          if (looksLikeRow && hit.arr.length > best.length) best = hit.arr;
        }
        if (best.length) {
          dataRows = normalizeRows(best, eventType, year, url);
          console.log(`✅ [${eventType}] Pulled ${dataRows.length} rows from __NEXT_DATA__`);
        }
      } catch (e) {
        console.log(`ℹ️  [${eventType}] __NEXT_DATA__ parse failed: ${e.message}`);
      }
    }

    // 2) Fallback: use captured XHR/JSON responses
    if (!dataRows.length && jsonResponses.length) {
      // Prefer endpoints with "standings" in URL
      const prioritized = [
        ...jsonResponses.filter(r => /standings/i.test(r.url)),
        ...jsonResponses
      ];
      let best = [];
      for (const { url: u, body } of prioritized) {
        for (const hit of deepArrays(body)) {
          const sample = hit.arr.find(x => x && typeof x === 'object');
          if (!sample) continue;
          const keys = Object.keys(sample);
          const looksLikeRow =
            keys.some(k => /name|contestant|athlete|header|heeler|lady/i.test(k)) &&
            keys.some(k => /earn|money|total|amount|world/i.test(k));
          if (looksLikeRow && hit.arr.length > best.length) best = hit.arr;
        }
        if (best.length) break;
      }
      if (best.length) {
        dataRows = normalizeRows(best, eventType, year, url);
        console.log(`✅ [${eventType}] Pulled ${dataRows.length} rows from XHR JSON`);
      }
    }

    // 3) Last resort: try DOM-based selectors (may be empty in CI)
    if (!dataRows.length) {
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
          await page.waitForSelector(sel, { timeout: 8000 });
          count = await page.locator(sel).count();
          if (count > 5) { foundSel = sel; break; }
        } catch (_) {}
      }
      if (foundSel) {
        console.log(`✅ [${eventType}] DOM rows via "${foundSel}" (${count})`);
        // minimal DOM parse
        const domRows = await page.$$eval(foundSel, (nodes) => {
          const rows = [];
          for (const n of nodes) {
            const cells = [...n.querySelectorAll('td,th,[role="gridcell"],div,span')].map(x => x.textContent.trim()).filter(Boolean);
            if (cells.length < 2) continue;
            rows.push({ place: cells[0], name: cells[1], money: cells.find(x => x.includes('$')) || cells.at(-1) || '' });
          }
          return rows;
        });
        dataRows = normalizeRows(domRows, eventType, year, url);
      }
    }

    // Debug drops if still empty
    if (!dataRows.length) {
      console.error(`❌ [${eventType}] No rows from JSON or DOM; dumping HTML + XHR`);
      fs.writeFileSync(path.join(debugDir, `debug-${eventType}.html`), await page.content());
      try {
        fs.writeFileSync(path.join(debugDir, `debug-${eventType}-xhr.json`), JSON.stringify(jsonResponses.map(r => r.url), null, 2));
      } catch (_) {}
    }

    console.log(`ℹ️  [${eventType}] Extracted ${dataRows.length} rows`);
    await browser.close();
    return dataRows;
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
