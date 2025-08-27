// scrape/prca.js
const { chromium } = require('playwright');

const EVENTS = ['BB','SB','BR','TD','SW','TRH','TRL','LBR'];

async function scrapeOne(eventType, year) {
  const url = `https://www.prorodeo.com/standings?eventType=${eventType}&standingType=world&year=${year}`;

  // CI-safe launch (no-sandbox flags help on GitHub runners)
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Be generous with timeouts (cloud can be slow)
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });

  // Try multiple selectors in case the page structure shifts
  let tableFound = false;
  const selectors = ['table', 'main table', 'section table'];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 60000 });
      tableFound = true;
      break;
    } catch (e) { /* try next selector */ }
  }
  if (!tableFound) {
    await browser.close();
    return []; // don’t crash the job—return empty and move on
  }

  const rows = await page.$$eval('table', (tables, ctx) => {
    const out = [];
    const best = [...tables]
      .map(t => ({ t, n: t.querySelectorAll('tbody tr').length }))
      .sort((a,b)=>b.n-a.n)[0];
    if (!best || best.n === 0) return out;

    const table = best.t;
    const trs = table.querySelectorAll('tbody tr');

    for (const tr of trs) {
      const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      if (!tds.length) continue;

      const placing = Number((tds[0]||'').replace(/[^\d]/g,'')) || null;
      const contestant_name = tds[1] || '';
      const earnings = Number((tds[2] || tds[tds.length-1] || '').replace(/[$,]/g,'')) || 0;

      if (contestant_name) {
        out.push({
          season: Number(ctx.year),
          event_code: ctx.eventType,
          placing,
          contestant_name,
          earnings,
          source_url: `https://www.prorodeo.com/standings?eventType=${ctx.eventType}&standingType=world&year=${ctx.year}`
        });
      }
    }
    return out;
  }, { eventType, year });

  await browser.close();
  return rows;
}

(async () => {
  const eventArg = (process.argv[2] || 'BB').toUpperCase(); // "BB" or "ALL"
  const year = process.argv[3] || '2025';

  try {
    if (eventArg === 'ALL') {
      const all = [];
      for (const ev of EVENTS) {
        const part = await scrapeOne(ev, year);
        all.push(...part);
      }
      process.stdout.write(JSON.stringify(all, null, 2));
    } else {
      const data = await scrapeOne(eventArg, year);
      process.stdout.write(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    // Don’t exit hard; print the error so logs show what's wrong
    console.error('SCRAPE_ERROR', String(err && err.message || err));
    process.stdout.write('[]');
  }
})();
