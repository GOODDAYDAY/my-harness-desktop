import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,2000));
// 先装监听
await page.evaluate(() => {
  window.__evts = [];
  window.pi.sessions.onEvent((e) => {
    if (e.type === 'messageUpdate' || e.type === 'messageStart' || e.type === 'messageEnd') {
      window.__evts.push({ 
        type: e.type, 
        msgId: e.message?.id, 
        msgRole: e.message?.role,
        contentStr: typeof e.message?.content === 'string' ? e.message.content.slice(0,20) : JSON.stringify(e.message?.content).slice(0,30),
      });
    }
  });
});
// 直接调 prompt(不走 UI,避免时序问题)
await page.evaluate(async () => {
  await window.pi.sessions.setContext('/Users/user/toy', null);
  await window.pi.sessions.prompt('说收到');
});
await new Promise(r=>setTimeout(r,12000));
const events = await page.evaluate(() => window.__evts);
console.log('事件流(' + events.length + '条):');
events.slice(0,15).forEach(e => console.log(`  ${e.type} id=${JSON.stringify(e.msgId)} role=${e.msgRole} content="${e.contentStr}"`));
b.disconnect();
