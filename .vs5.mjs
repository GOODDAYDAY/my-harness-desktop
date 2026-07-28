import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1000));
page.on('console', msg => { if (msg.type()==='error') console.log('RENDER-ERR:', msg.text().slice(0,200)); });

// 真 type 文字进 textarea
const ta = await page.$('textarea');
await ta.type('测试发送');
await new Promise(r=>setTimeout(r,300));
const val = await page.evaluate(() => document.querySelector('textarea')?.value);
console.log('输入后:', JSON.stringify(val));

// 看发送按钮 disabled?
const btnState = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-arrow-up'));
  return { disabled: btn?.disabled, bg: btn ? getComputedStyle(btn).background.slice(0,40) : null };
});
console.log('发送按钮:', JSON.stringify(btnState));

// 按 Enter 发送(textarea 的 Enter 触发 onSubmit)
await page.focus('textarea');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,3000));
const after = await page.evaluate(() => document.querySelector('textarea')?.value);
console.log('Enter 后 textarea(应清空=发出去了):', JSON.stringify(after));

// 看有没有新消息出现(乐观回显 user 消息)
const bodyHas = await page.evaluate(() => document.body.innerText.includes('测试发送'));
console.log('消息上屏:', bodyHas);
b.disconnect();
