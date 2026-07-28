// CDP 直连 Electron page,用 Runtime.evaluate 抓左栏 DOM 结构
const puppeteer = require('puppeteer-core');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const tab = list.find(t => t.type === 'page');
  if (!tab) { console.error('no page tab'); process.exit(2); }
  // 用 CDP 直连 page-level ws(不走 browser.pages,避免 Target 调用)
  const client = await (async () => {
    const ws = new (require('ws'))(tab.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    let id = 0; const pending = new Map();
    ws.on('message', m => { const o = JSON.parse(m); if (o.id && pending.has(o.id)) { const p = pending.get(o.id); pending.delete(o.id); if (o.error) p.reject(new Error(o.error.message)); else p.resolve(o); } });
    const send = (method, params={}) => new Promise((r,j) => { id++; pending.set(id, {resolve:r, reject:j}); ws.send(JSON.stringify({id, method, params})); });
    return { send, ws };
  })();
  await client.send('Runtime.enable');
  const { result } = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const root = document.getElementById('root');
      if (!root) return JSON.stringify({err:'no root'});
      const btns = [...root.querySelectorAll('button')].map(b => { const r=b.getBoundingClientRect(); return {title:b.getAttribute('title'), text:(b.textContent||'').trim().slice(0,16), x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),vis:!!b.offsetParent}; });
      const inputs = [...root.querySelectorAll('input')].map(i => { const r=i.getBoundingClientRect(); return {ph:i.placeholder,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; });
      const handles = [...root.querySelectorAll('*')].filter(el => /row-resize/.test(el.getAttribute('style')||'')).map(el => { const r=el.getBoundingClientRect(); const cs=getComputedStyle(el); return {h:Math.round(r.height),w:Math.round(r.width),bg:cs.backgroundColor}; });
      // 左栏整体宽
      const sb = root.querySelector('[class*="border-r"]') || root.querySelector('aside') || root.querySelector('.flex.flex-col.h-full');
      const sidebarRect = sb ? (() => { const r=sb.getBoundingClientRect(); return {w:Math.round(r.width),h:Math.round(r.height)}; })() : null;
      return JSON.stringify({btns, inputs, handles, sidebarRect});
    })()`,
    returnByValue: true,
  });
  const inner = (result && result.result) || {};
  const val = inner.value;
  if (!val) { console.log('no value, exceptionDetails:', JSON.stringify(inner.exceptionDetails||'none').slice(0,400)); }
  const data = val ? JSON.parse(val) : {btns:[],inputs:[],handles:[],sidebarRect:null, view:'?'};
  console.log('=== INPUTS(搜索框) ===');
  console.log(JSON.stringify(data.inputs, null, 2));
  console.log('=== HANDLES(分割线) ===');
  console.log(JSON.stringify(data.handles, null, 2));
  console.log('=== SIDEBAR ===');
  console.log(JSON.stringify(data.sidebarRect, null, 2));
  console.log('=== 会话区按钮 ===');
  console.log(JSON.stringify(data.btns.filter(b => b.title && /会话|新会话/.test(b.title)), null, 2));
  console.log('=== 全部 btn title ===');
  console.log(JSON.stringify(data.btns.map(b=>b.title).filter(Boolean), null, 1));
  // 截图
  await client.send('Page.enable');
  const { data: shot } = await client.send('Page.captureScreenshot');
  require('fs').writeFileSync('/tmp/pi-cdp.png', Buffer.from(shot, 'base64'));
  console.log('shot saved');
  await client.ws.close();
})().catch(e => { console.error('ERR', e.message); process.exit(3); });
