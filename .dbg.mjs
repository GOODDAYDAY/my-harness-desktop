import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,500));
// 看当前 DOM 里所有 markdown-body 的内容(看有没有重复残留)
const mds = await page.evaluate(() => {
  return [...document.querySelectorAll('.markdown-body')].map(m => m.textContent?.slice(0,30));
});
console.log('当前所有 markdown-body:', JSON.stringify(mds, null, 1));
console.log('总数:', mds.length);

// 看 session-store 的 messages（经 React 不行，看 Virtuoso 渲染的 item 数）
const itemCount = await page.evaluate(() => {
  const items = document.querySelectorAll('[data-testid="virtuoso-item-list"] > *');
  return items.length;
});
console.log('Virtuoso item 数:', itemCount);
b.disconnect();
