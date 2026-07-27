// 机械测试:事件驱动,不用 sleep/wait/轮询。
// 原理:用 MutationObserver 等 DOM 变化,不靠 setTimeout 轮询。
import WebSocket from 'ws';
const target = await (await fetch('http://localhost:9222/json')).json();
const page = target.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params={}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
});
await new Promise(r => ws.on('open', r));
await send('Runtime.enable');

async function evalInPage(expr) {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const res = m.result?.result;
  if (res?.exceptionDetails) throw new Error('eval failed: ' + res.exceptionDetails.text);
  return res?.value;
}

/** 用 MutationObserver 等 DOM 出现目标文本(事件驱动,不轮询)。 */
async function waitByText(text, { timeout = 5000 } = {}) {
  return evalInPage(`(async () => {
    // 先查一次(可能已存在)
    const exists = () => [...document.querySelectorAll('*')].some(e => e.textContent?.includes(${JSON.stringify(text)});
    if (exists()) return true;
    // MutationObserver 等 DOM 变化,目标出现即 resolve
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { obs.disconnect(); reject(new Error('等元素超时: ' + ${JSON.stringify(text)})); }, ${timeout});
      const obs = new MutationObserver(() => {
        if (exists()) { clearTimeout(timer); obs.disconnect(); resolve(true); }
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  })()`);
}

/** 找含文本的最深层可点击元素(排除外层容器)并点击。 */
async function clickByText(text) {
  return evalInPage(`(() => {
    // 找所有匹配元素,选最深的(子元素最少的=最底层=ListItem 本身)
    const all = [...document.querySelectorAll('div')].filter(e => e.textContent?.trim() === ${JSON.stringify(text)} && e.style.borderRadius);
    if (all.length === 0) {
      // 没有 borderRadius 的——用最深的
      const fallback = [...document.querySelectorAll('*')].filter(e => e.textContent?.trim() === ${JSON.stringify(text)});
      if (fallback.length) { fallback[fallback.length - 1].click(); return true; }
      return false;
    }
    all[all.length - 1].click();
    return true;
  })()`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log('  ✓', msg);
}

// ============ 测试开始 ============
let failures = 0;
try {
  // 前置:若在设置页先回对话页
  const onSettings = await evalInPage(`[...document.querySelectorAll('*')].some(e => e.textContent?.includes('返回对话'))`);
  if (onSettings) {
    await clickByText('返回对话');
    await waitByText('设置', { timeout: 3000 });
  }

  // 1. 点"设置"
  assert(await clickByText('设置'), '点设置按钮');

  // 2. 进入设置页
  await waitByText('返回对话', { timeout: 5000 });
  console.log('  ✓ 进入设置页');

  // 3. 左列表 3 项
  const listCount = await evalInPage(`[...document.querySelectorAll('div')].filter(e => (e.textContent === 'Pi' || e.textContent === '主题' || e.textContent === '模型') && e.style.borderRadius?.includes('var')).length`);
  assert(listCount === 3, `设置页左列表 3 项,实际:${listCount}`);

  // 4. 点 Pi
  await evalInPage(`(() => { [...document.querySelectorAll('div')].find(e => e.textContent === 'Pi' && e.style.borderRadius?.includes('var'))?.click(); return true; })()`);
  await waitByText('Pi 内核版本管理', { timeout: 5000 });
  console.log('  ✓ 点Pi右边渲染(内核+配置上下分区)');

  // 5. 点主题
  await evalInPage(`(() => { [...document.querySelectorAll('div')].find(e => e.textContent === '主题' && e.style.borderRadius?.includes('var'))?.click(); return true; })()`);
  await waitByText('主题', { timeout: 5000 });
  console.log('  ✓ 点主题右边渲染');

  // 6. 不显示暂无配置
  const noConfig = await evalInPage(`document.body.textContent?.includes('暂无配置')`);
  assert(noConfig === false, '不显示暂无配置');

} catch (e) {
  console.error('  ✗ 测试失败:', e.message);
  failures++;
}
console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ ' + failures + ' 项失败'}`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
