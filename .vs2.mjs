import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1000));
// 在页面里装事件监听,记录所有 event type + messageUpdate 的 content 片段
await page.evaluate(() => {
  window.__events = [];
  window.pi.sessions.onEvent((e) => {
    window.__events.push({ type: e.type, role: e.message?.role, contentLen: JSON.stringify(e.message?.content ?? '').length, ts: Date.now() });
  });
});
// 发消息
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('从1数到5');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,8000));
// 看记录的事件
const events = await page.evaluate(() => window.__events);
console.log('事件流:');
events.slice(0,40).forEach(e => console.log(`  ${e.type} role=${e.role||'-'} contentLen=${e.contentLen}`));
console.log('总事件数:', events.length);
b.disconnect();
