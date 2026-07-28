import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,500));
// 装监听:记所有 event type(不限 message_update)
await page.evaluate(() => {
  window.__allEvents = [];
  window.pi.sessions.onEvent((e) => { window.__allEvents.push(e.type); });
  window.pi.sessions.onSnapshot((s) => { window.__snapshots = (window.__snapshots||0)+1; });
});
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('说收到');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,8000));
const r = await page.evaluate(() => ({ events: window.__allEvents, snapshotCount: window.__snapshots||0 }));
console.log('events:', JSON.stringify(r.events));
console.log('snapshot 次数:', r.snapshotCount);
b.disconnect();
