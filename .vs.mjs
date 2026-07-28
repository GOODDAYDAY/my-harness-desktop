import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
// 新会话 + 发消息(让 AI 回一段稍长的)
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1200));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1200));
const ta = await page.$('textarea');
await ta.type('从1数到10,每行一个');
await page.keyboard.press('Enter');
// 每 500ms 采样 assistant 末条内容,看是否逐步增长(流式)
const samples = [];
for (let i=0; i<16; i++) {
  await new Promise(r=>setTimeout(r,500));
  const s = await page.evaluate(() => {
    const mds = [...document.querySelectorAll('.markdown-body')];
    const last = mds[mds.length-1]?.textContent ?? '';
    return { len: last.length, tail: last.slice(-30) };
  });
  samples.push(s);
}
console.log('流式采样(500ms间隔,len=末条长度):');
samples.forEach((s,i) => console.log(`  ${i*0.5}s: len=${s.len} tail="${s.tail}"`));
b.disconnect();
