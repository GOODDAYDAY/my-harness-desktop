import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1000));

// 进 toy 会话(点项目区 toy)+ 等
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,2500));

// 找 textarea + 发送按钮
const info = await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  const sendBtn = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')==='发送' || b.getAttribute('aria-label')==='Send' || b.querySelector('svg.lucide-arrow-up'));
  return { hasTextarea: !!ta, hasSendBtn: !!sendBtn, sendDisabled: sendBtn?.disabled, sendBg: sendBtn ? getComputedStyle(sendBtn).background.slice(0,30) : null };
});
console.log('UI:', JSON.stringify(info));

// 输入文字 + 点发送
await page.evaluate(() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '测试消息');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await new Promise(r=>setTimeout(r,300));
const beforeSend = await page.evaluate(() => document.querySelector('textarea')?.value);
console.log('输入后 textarea:', JSON.stringify(beforeSend));
// 点发送
const clicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-arrow-up'));
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
});
console.log('点发送:', clicked);
await new Promise(r=>setTimeout(r,2000));
const after = await page.evaluate(() => document.querySelector('textarea')?.value);
console.log('发送后 textarea(应清空):', JSON.stringify(after));
b.disconnect();
