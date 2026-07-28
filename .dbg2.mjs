import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,500));
// 抓 messageUpdate 事件看 message 有没有 id
await page.evaluate(() => {
  window.__mu = [];
  window.pi.sessions.onEvent((e) => {
    if (e.type === 'messageUpdate' || e.type === 'messageStart' || e.type === 'messageEnd') {
      window.__mu.push({ 
        type: e.type, 
        msgId: e.message?.id, 
        msgRole: e.message?.role,
        contentLen: JSON.stringify(e.message?.content ?? '').length,
      });
    }
  });
});
// 发消息触发流式
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('说收到');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,8000));
const events = await page.evaluate(() => window.__mu);
console.log('事件流:');
events.forEach(e => console.log(`  ${e.type} id=${e.msgId ?? '(无)'} role=${e.msgRole ?? '-'} contentLen=${e.contentLen}`));
b.disconnect();
