const puppeteer = require('puppeteer-core');
(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const tab = list.find(t => t.type === 'page');
  const ws = new (require('ws'))(tab.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j);});
  let id=0; const pending=new Map();
  ws.on('message',m=>{const o=JSON.parse(m);if(o.id&&pending.has(o.id)){const p=pending.get(o.id);pending.delete(o.id);o.error?p.reject(o.error):p.resolve(o);}});
  const send=(method,params={})=>new Promise((r,j)=>{id++;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable');
  // 找含"返回/对话/back/pi"的按钮 + 当前 mainView
  const {result:{value}} = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns=[...document.querySelectorAll('button')].map((b,i)=>({i,text:(b.textContent||'').trim().slice(0,12),title:b.getAttribute('title'),vis:!!b.offsetParent}));
      const visible=btns.filter(b=>b.vis);
      return JSON.stringify({total:btns.length, visible:visible.slice(0,20)});
    })()`,
    returnByValue: true,
  });
  console.log(value);
  await ws.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(3);});
