import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,2000));
// 选 toy + 新会话
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1500));
// 确认 currentSessionPath 是 null
const beforePath = await page.evaluate(() => window.pi.prefs.get('lastCwd'));
console.log('lastCwd:', beforePath);
// 发消息
const ta = await page.$('textarea');
await ta.type('新会话最终测试');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,15000));
// 看新文件 + cwd + 侧栏
const latest = execSync('ls -t ~/.pi/agent/sessions/--Users-user-toy--/*.jsonl | head -1').toString().trim();
const header = JSON.parse(execSync(`head -1 "${latest}"`).toString());
console.log('最新文件:', latest.split('/').pop());
console.log('header.cwd:', header.cwd, '| 正确:', header.cwd === '/Users/user/toy');
console.log('header.id:', header.id?.slice(0,8));
// 看侧栏有没有新会话(列表刷新后)
const sidebar = await page.evaluate(() => {
  const body = document.body.innerText;
  return { hasNewSession: body.includes('新会话最终测试'), hasToday: body.includes('今天') || body.includes('Today') };
});
console.log('侧栏:', JSON.stringify(sidebar));
b.disconnect();
