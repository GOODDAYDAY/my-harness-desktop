import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,500));
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
// 装监听,只记 message_update/messageUpdate 的 type 原样 + content
await page.evaluate(() => {
  window.__muEvents = [];
  window.pi.sessions.onEvent((e) => {
    if (e.type === 'message_update' || e.type === 'messageUpdate') {
      window.__muEvents.push({ type: e.type, content: JSON.stringify(e.message?.content).slice(0,100) });
    }
  });
});
const ta = await page.$('textarea');
await ta.type('说收到');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,6000));
const evs = await page.evaluate(() => window.__muEvents);
console.log('message_update 事件数:', evs.length);
evs.slice(0,5).forEach(e => console.log(`  type=${e.type} content=${e.content}`));
b.disconnect();
