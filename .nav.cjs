const puppeteer = require('puppeteer-core');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const tab = list.find(t => t.type === 'page');
  const ws = new (require('ws'))(tab.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});
  let id=0; const pending=new Map();
  ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&pending.has(o.id)){const p=pending.get(o.id);pending.delete(o.id);o.error?p.reject(new Error(JSON.stringify(o.error))):p.resolve(o);}});
  const send=(method,params={})=>new Promise((r,j)=>{id++;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable');
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const btns=[...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.textContent||'').trim().slice(0,12)+'|'+(b.getAttribute('title')||'')); return JSON.stringify(btns); })()`,
    returnByValue: true,
  });
  console.log('FULL:', JSON.stringify(r.result).slice(0,2000));
  await ws.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(3);});
