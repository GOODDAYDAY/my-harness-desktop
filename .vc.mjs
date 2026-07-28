import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
// 新会话 + 发消息
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('测试cwd');
await page.keyboard.press('Enter');
await new Promise(r=>setTimeout(r,12000));
// 看最新文件头行 cwd
const latest = execSync('ls -t ~/.pi/agent/sessions/--Users-user-toy--/*.jsonl | head -1').toString().trim();
const header = execSync(`head -1 "${latest}"`).toString();
const cwd = JSON.parse(header).cwd;
console.log('最新文件:', latest.split('/').pop());
console.log('header.cwd:', cwd);
console.log('cwd 正确(=toy):', cwd === '/Users/user/toy');
b.disconnect();
