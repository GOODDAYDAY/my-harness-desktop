import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1000));
// 当前页面状态
const state = await page.evaluate(() => ({
  hasTextarea: !!document.querySelector('textarea'),
  bodyStart: document.body.innerText.slice(0,120),
  hasSendBtn: !![...document.querySelectorAll('button')].find(b=>b.querySelector('svg.lucide-arrow-up')),
}));
console.log('当前:', JSON.stringify(state, null, 1));
b.disconnect();
