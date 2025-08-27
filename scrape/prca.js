// scrape/prca.js
const { chromium } = require('playwright');

const EVENTS = ['BB','SB','BR','TD','SW','TRH','TRL','LBR'];

async function scrapeOne(eventType, year) {
  const url = `https://www.prorodeo.com/standings?eventType=${eventType}&standingType=world&year=${year}`;
  console.log(`➡️  [${eventType}] Opening ${url}`);

  // CI-safe launch for GitHub Actions
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    console.log(`✅ [${eventType}] Page loaded`);
  } catch (e) {
    console.error(`❌ [${eventType}] page.goto failed: ${e.message}`);
    await browser.close();
    return [];
  }

  // wait for a table, but don't hang forever
  try {
    await page.waitForSelector('table', { timeout: 20000 });
    console.log(`✅ [${eventType}] Table detected`);
  } catch (e) {
    console.error(`❌ [${eventType}] Table not found within 20s`);
    await browser.close();
    return [];
  }

  const rows = await page.$$eval('table', (tables, ctx) => {
    const out = [];
    // choose the table with the most rows
    const best = [...tables]
      .map(t => ({ t, n: t.querySelectorAll('tbody tr').length }))
      .sort((a,b) => b.n - a.n)[0];
    if (!best || best.n === 0) return out;

    const trs = best.t.querySelectorAll('tbody tr');
    for (const tr of trs) {
      const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
      if (!tds.length) continue;

      const placing = Number((tds[0] || '').replace(/[^\d]/g,'')) || null;
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

  console.log(`ℹ️  [${eventType}] Extracted ${rows.length} rows`);
  await browser.close();
  console.log(`✅ [${eventType}] Finished`);
  return rows;
}

(async () => {
  const eventArg = (process.argv[2] || 'BB').toUpperCase(); // "BB" or "ALL"
  const year = process.argv[3] || '2025';

  try {
    if (eventArg === 'ALL') {
      let all = [];
      for (const ev of EVENTS) {
        const part = await scrapeOne(ev, year);
        all = all.concat(part);
      }
      console.log(`✅ [ALL] Finished all events. Total rows: ${all.length}`);
      process.stdout.write(JSON.stringify(all, null, 2));
    } else {
      const data = await scrapeOne(eventArg, year);
      console.log(`✅ [${eventArg}] Done. Rows: ${data.length}`);
      process.stdout.write(JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error('SCRAPE_ERROR', err && err.message || err);
    process.stdout.write('[]');
  }
})();
