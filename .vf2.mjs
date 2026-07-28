import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1]);
const r = await page.evaluate(() => {
  const mds = [...document.querySelectorAll('.markdown-body')];
  return { mdCount: mds.length, lastMd: mds[mds.length-1]?.textContent?.slice(0,80) };
});
console.log(JSON.stringify(r, null, 1));
b.disconnect();
