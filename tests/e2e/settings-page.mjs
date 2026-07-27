// 机械测试:不靠固定 sleep,轮询断言(条件满足即过、超时明确失败)。
// 覆盖回归:设置页点开右边能渲染。不依赖 HTML 标签类型(找任何元素含文本)。
import WebSocket from 'ws';
const target = await (await fetch('http://localhost:9222/json')).json();
const page = target.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params={}) {
  const i = ++id;
  return new Promise((res, rej) => { pending.set(i, {res, rej}); ws.send(JSON.stringify({id: i, method, params})); });
}
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); } });
await new Promise(r => ws.on('open', r));
await send('Runtime.enable');

async function evalInPage(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = m.result?.result;
  if (res?.exceptionDetails) throw new Error('eval failed: ' + res.exceptionDetails.text);
  return res?.value;
}
async function waitFor(expr, { maxMs = 5000, label = '' } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const v = await evalInPage(`(() => { try { return ${expr}; } catch (e) { return null; } })()`);
    if (v) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`轮询超时(${maxMs}ms):${label}`);
}
/** 等文本出现的元素(不限定标签)并点击。优先找文本精确匹配且可点击的最小元素。 */
async function waitAndClick(text, { maxMs = 3000 } = {}) {
  await waitFor(`[...document.querySelectorAll('*')].some(e => e.textContent?.trim() === ${JSON.stringify(text)} || e.textContent?.includes(${JSON.stringify(text)}))`, { maxMs, label: `元素[${text}]` });
  return evalInPage(`(() => {
    // 优先找文本精确匹配(不含多余文字)且可点击的元素
    const all = [...document.querySelectorAll('*')];
    const exact = all.find(e => e.textContent?.trim() === ${JSON.stringify(text)} && (e.onclick || e.getAttribute('onclick') !== null || e.tagName === 'BUTTON'));
    if (exact) { exact.click(); return true; }
    // 退而求其次:找含文本的可点击元素(有 onClick handler)
    const clickable = all.find(e => e.textContent?.includes(${JSON.stringify(text)}) && e.onclick);
    if (clickable) { clickable.click(); return true; }
    // 最后:任何含文本的元素
    const any = all.find(e => e.textContent?.includes(${JSON.stringify(text)}));
    if (any) { any.click(); return true; }
    return false;
  })()`);
}

let failures = 0;
const check = (cond, msg) => { if (!cond) { console.error('  ✗', msg); failures++; } else console.log('  ✓', msg); };
try {
  // 前置:若在设置页先回对话页
  const onSettings = await evalInPage(`[...document.querySelectorAll('*')].some(e => e.textContent?.includes('返回对话'))`);
  if (onSettings) await waitAndClick('返回对话', { maxMs: 2000 });

  check(await waitAndClick('设置', { maxMs: 8000 }), '点设置');
  await waitFor(`[...document.querySelectorAll('*')].some(e => e.textContent?.includes('返回对话'))`, { label: '设置页' });
  check(true, '进入设置页');
  const listCount = await evalInPage(`[...document.querySelectorAll('div')].filter(e => (e.textContent === 'Pi' || e.textContent === '主题' || e.textContent === '模型') && e.style.borderRadius?.includes('var')).length`);
  check(listCount === 3, `设置页左列表 3 项(Pi、模型、主题),实际:${listCount}`);
  await waitAndClick('Pi', { maxMs: 5000 });
  await waitFor(`[...document.querySelectorAll('h2')].some(h => h.textContent?.includes('Pi 内核版本管理'))`, { label: '右边渲染内核管理' });
  check(true, '点Pi右边渲染(内核+配置上下分区)');
  await waitAndClick('主题', { maxMs: 5000 });
  await waitFor(`[...document.querySelectorAll('h2, h3')].some(h => h.textContent?.includes('主题'))`, { label: '右边渲染主题' });
  check(true, '点主题右边渲染');
  const noConfig = await evalInPage(`document.body.textContent?.includes('暂无配置')`);
  check(noConfig === false, '不显示暂无配置');
} catch (e) {
  console.error('  ✗ 测试中断:', e.message);
  failures++;
}
console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ ' + failures + ' 项失败'}`);
ws.close(); process.exit(failures === 0 ? 0 : 1);
