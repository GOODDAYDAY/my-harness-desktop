import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
// 抓 console + 错误
page.on('console', msg => { if (msg.type()==='error') console.log('CONSOLE-ERR:', msg.text().slice(0,200)); });
page.on('pageerror', e => console.log('PAGE-ERR:', String(e).slice(0,200)));

// 设 context(toy, 新会话 null)+ 发消息
const r = await page.evaluate(async () => {
  try {
    await window.pi.sessions.setContext('/Users/user/toy', null);
    console.log('setContext ok');
    const p = await window.pi.sessions.prompt('说"收到"两个字');
    return { promptResult: 'ok', result: JSON.stringify(p).slice(0,100) };
  } catch (e) {
    return { error: String(e).slice(0,300) };
  }
});
console.log('prompt 结果:', JSON.stringify(r, null, 1));
// 看是否起了 pi 进程
import { execSync } from 'node:child_process';
const cnt = execSync('pgrep -c -P 90680 2>/dev/null || echo 0').toString().trim();
console.log('electron helper 子进程数:', cnt);
b.disconnect();
