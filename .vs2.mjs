import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,500));
// 精确点设置入口:侧栏底部 ChatRow,文本"设置"
const clicked = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(e => { const t=e.textContent?.trim(); return (t==='设置'||t==='Settings') && e.children.length===0; });
  if (el) { el.click(); return el.textContent.trim(); }
  return null;
});
console.log('点设置:', clicked);
await new Promise(r=>setTimeout(r,1500));
const r = await page.evaluate(() => ({
  bodyStart: document.body.innerText.slice(0,200),
  hasNoConfig: document.body.innerText.includes('暂无配置'),
  hasPiSettings: document.body.innerText.includes('Pi 内核') || document.body.innerText.includes('已装版本'),
}));
console.log(JSON.stringify(r, null, 1));
b.disconnect();
