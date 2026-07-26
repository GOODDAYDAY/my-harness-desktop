import WebSocket from 'ws';
const target = await (await fetch('http://localhost:9222/json')).json();
const page = target.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(m, p={}) { const i = ++id; return new Promise((res,rej)=>{pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));}); }
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); } });
await new Promise(r => ws.on('open', r));
await send('Runtime.enable');
const evalP = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then(m => m.result?.result?.value);
await evalP(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('设置'))?.click();return true;})()`);
await new Promise(r=>setTimeout(r,400));
await evalP(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='模型')?.click();return true;})()`);
await new Promise(r=>setTimeout(r,500));
// 右键第一个 provider 触发 copyProvider(通过 onContextMenu 模拟)
await evalP(`(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('ds4-flash-sg'));if(!btn)return 'no btn';btn.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:100}));return 'ctx';})()`);
await new Promise(r=>setTimeout(r,300));
// 点"复制供应商"
await evalP(`(()=>{const btn=[...document.querySelectorAll('button')].find(b=>b.textContent==='复制供应商');btn?.click();return 'clicked';})()`);
await new Promise(r=>setTimeout(r,500));
const hasBar = await evalP(`(() => document.body.textContent?.includes('未保存的改动'))()`);
console.log('DIRTY:', JSON.stringify({ hasBar }));
ws.close(); process.exit(0);
