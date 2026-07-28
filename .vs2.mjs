import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
page.on('console', msg => { if (msg.type()==='error') console.log('RENDER-ERR:', msg.text().slice(0,250)); });

// prompt 超时控制(它可能挂起)
const r = await Promise.race([
  page.evaluate(async () => {
    try {
      await window.pi.sessions.setContext('/Users/user/toy', null);
      await window.pi.sessions.prompt('说收到');
      return { ok: true };
    } catch (e) { return { error: String(e).slice(0,300) }; }
  }),
  new Promise(res => setTimeout(() => res({ timeout: 'prompt 10s 没返回' }), 10000)),
]);
console.log('prompt:', JSON.stringify(r));
b.disconnect();
