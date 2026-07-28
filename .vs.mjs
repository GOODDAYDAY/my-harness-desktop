import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,2000));
// 进设置
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='设置'||e.textContent?.trim()==='Settings')?.click(); });
await new Promise(r=>setTimeout(r,1500));
// 看设置页右区:有没有"暂无配置" + 左列表有没有 Pi 项被选中
const r = await page.evaluate(() => ({
  hasNoConfig: document.body.innerText.includes('暂无配置') || document.body.innerText.includes('No config'),
  bodyTail: document.body.innerText.slice(-150),
  // 左列表选中态
  activeItems: [...document.querySelectorAll('*')].filter(e => {
    const s = getComputedStyle(e);
    return s.background?.includes('surface') || s.background?.includes('236');
  }).map(e => e.textContent?.trim().slice(0,12)).slice(0,3),
}));
console.log(JSON.stringify(r, null, 1));
// 看 getSettingsComponent 注册了没(经 React 内部不容易,看 PiManagerPage 内容在不在 DOM)
const hasPiContent = await page.evaluate(() => document.body.innerText.includes('Pi 内核') || document.body.innerText.includes('Pi kernel') || document.body.innerText.includes('已装版本'));
console.log('Pi 设置页内容在:', hasPiContent);
b.disconnect();
