import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,2000));
// 新会话 + 发消息
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('最终验证新会话');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,15000));
// 看最新文件
const latest = execSync('ls -t ~/.pi/agent/sessions/--Users-user-toy--/*.jsonl | head -1').toString().trim();
const header = JSON.parse(execSync(`head -1 "${latest}"`).toString());
console.log('最新文件:', latest.split('/').pop());
console.log('header.cwd:', header.cwd, '| 正确:', header.cwd === '/Users/user/toy');
console.log('header.id:', header.id?.slice(0,8), '| 新 id:', header.id !== '019e4d83-f1c2-7241-8fe0-e776ade65103');
console.log('文件名含今天:', latest.includes('2026-07-28'));
// 侧栏
const sidebar = await page.evaluate(() => ({
  hasNew: document.body.innerText.includes('最终验证新会话'),
  hasToday: document.body.innerText.includes('今天') || document.body.innerText.includes('Today'),
}));
console.log('侧栏:', JSON.stringify(sidebar));
b.disconnect();
