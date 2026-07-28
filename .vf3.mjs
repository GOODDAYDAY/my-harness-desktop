import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
// 再发一条(应用还在)
const ta = await page.$('textarea');
if (ta) { await ta.type('说收到'); await page.keyboard.press('Enter'); }
await new Promise(r=>setTimeout(r,8000));
const r = await page.evaluate(() => {
  const mds = [...document.querySelectorAll('.markdown-body')];
  return { mdCount: mds.length, lastMd: mds[mds.length-1]?.textContent?.slice(0,80) };
});
console.log(JSON.stringify(r, null, 1));
b.disconnect();
