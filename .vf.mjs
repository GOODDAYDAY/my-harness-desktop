import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1000));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1000));
const ta = await page.$('textarea');
await ta.type('从1数到5,每行一个');
await page.keyboard.press('Enter');
// 采样流式
const samples = [];
for (let i=0; i<12; i++) {
  await new Promise(r=>setTimeout(r,600));
  const s = await page.evaluate(() => {
    const mds = [...document.querySelectorAll('.markdown-body')];
    const last = mds[mds.length-1]?.textContent ?? '';
    return { len: last.length, tail: last.slice(-25) };
  });
  samples.push(s);
}
console.log('流式采样:');
samples.forEach((s,i) => s.len > 0 && console.log(`  ${i*0.6}s: len=${s.len} tail="${s.tail}"`));
b.disconnect();
