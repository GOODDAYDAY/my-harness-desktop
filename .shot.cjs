const puppeteer = require('puppeteer-core');
const fs = require('fs');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const tab = list.find(t => t.type === 'page');
  if (!tab) { console.error('no page'); process.exit(2); }
  const browser = await puppeteer.connect({ browserWSEndpoint: tab.webSocketDebuggerUrl, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  await new Promise(r => setTimeout(r, 500));
  // 抓左栏标题行(对话 Section 的 actions 区)的 DOM 结构 + 计算样式
  const report = await page.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) return { err: 'no root' };
    // 找所有 button(含 + 新会话)和 input(搜索框)
    const btns = [...root.querySelectorAll('button')].map(b => ({
      title: b.getAttribute('title'),
      text: (b.textContent||'').trim().slice(0,20),
      rect: (() => { const r = b.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })(),
      visible: !!(b.offsetParent),
    }));
    const inputs = [...root.querySelectorAll('input')].map(i => ({
      ph: i.placeholder, value: i.value,
      rect: (() => { const r = i.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; })(),
    }));
    // 找含"会话/对话/Sessions"标题的 Section 头行
    const headers = [...root.querySelectorAll('[class*="flex"][class*="items-center"]')].filter(el => /会话|对话|Sessions/.test(el.textContent||'')).slice(0,3).map(el => {
      const r = el.getBoundingClientRect();
      return { text:(el.textContent||'').trim().slice(0,30), x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), scrollW: el.scrollWidth, clientW: el.clientWidth, overflow: el.scrollWidth > el.clientWidth ? 'OVERFLOW' : 'fit' };
    });
    // 分割线 handle
    const handles = [...root.querySelectorAll('[style*="row-resize"],[style*="cursor: row-resize"]'].length ? root.querySelectorAll('[style*="row-resize"]') : []).length;
    return { btns, inputs, headers, handles };
  });
  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: '/tmp/pi-cdp.png' });
  console.log('shot saved');
  await browser.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(3); });
