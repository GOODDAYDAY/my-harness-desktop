import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('从1数到5');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,15000));
// 看有没有重复残留
const r = await page.evaluate(() => {
  const mds = [...document.querySelectorAll('.markdown-body')];
  return { 
    mdCount: mds.length, 
    allContent: mds.map(m => m.textContent?.slice(0,20)),
  };
});
console.log('markdown 数:', r.mdCount);
console.log('内容:', JSON.stringify(r.allContent));
b.disconnect();
