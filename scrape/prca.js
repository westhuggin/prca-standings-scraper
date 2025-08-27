// scrape/prca.js
// Event codes: BB, SB, BR, TD, SW, TRH (Header), TRL (Heeler), LBR
const { chromium } = require('playwright');

const EVENTS = ['BB','SB','BR','TD','SW','TRH','TRL','LBR'];

async function scrapeOne(eventType, year) {
  const url = `https://www.prorodeo.com/standings?eventType=${eventType}&standingType=world&year=${year}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('table'); // waits for JS-rendered table

  const rows = await page.$$eval('table', (tables, ctx) => {
    const out = [];
    // choose the table with the most rows
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
})();
