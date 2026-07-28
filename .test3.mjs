import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const ps = await b.pages();
const page = ps[ps.length-1];
await new Promise(r=>setTimeout(r,2000));

// 1. 选 toy + 新会话 + 发消息
await page.evaluate(() => { [...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='toy'&&e.children.length===0)?.click(); });
await new Promise(r=>setTimeout(r,1500));
await page.evaluate(() => { [...document.querySelectorAll('button')].find(b=>b.title?.includes('新会话'))?.click(); });
await new Promise(r=>setTimeout(r,1500));

// 2. 先看回到底按钮(空态时不该有)
const beforeSend = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find(b => 
    b.textContent?.includes('回到底部') || b.textContent?.includes('Scroll to bottom') || b.textContent?.includes('↓')
  );
  return { hasScrollBtn: !!btn };
});
console.log('发消息前 回到底按钮:', JSON.stringify(beforeSend));

// 3. 发消息 + 流式采样
const ta = await page.$('textarea');
await ta.type('从1数到10,每行一个');
await page.keyboard.press('Enter');

const samples = [];
for (let i=0; i<20; i++) {
  await new Promise(r=>setTimeout(r,800));
  const s = await page.evaluate(() => {
    // assistant 消息(Virtuoso 渲染的)
    const allDivs = [...document.querySelectorAll('div')];
    // markdown-body 是 assistant 的内容
    const mds = [...document.querySelectorAll('.markdown-body')];
    const lastMd = mds[mds.length-1]?.textContent ?? '';
    // 回到底按钮
    const scrollBtn = [...document.querySelectorAll('button')].find(b => 
      b.textContent?.includes('回到底部') || b.textContent?.includes('Scroll')
    );
    // 模型按钮(composer 中段)
    const modelBtn = [...document.querySelectorAll('button')].find(b => 
      b.querySelector('svg.lucide-chevron-down') && b.textContent?.length > 0 && b.textContent?.length < 30
    );
    return { 
      mdCount: mds.length, 
      lastLen: lastMd.length, 
      lastTail: lastMd.slice(-25), 
      scrollBtn: !!scrollBtn,
      modelBtnFound: !!modelBtn,
      modelBtnDisabled: modelBtn?.disabled,
    };
  });
  samples.push({...s, t: i*0.8});
}
console.log('流式采样(每0.8s):');
samples.filter(s => s.lastLen > 0 || s.scrollBtn || s.t === 0).forEach(s => 
  console.log(`  ${s.t}s: md=${s.mdCount} len=${s.lastLen} tail="${s.lastTail}" scrollBtn=${s.scrollBtn} model=${s.modelBtnFound}/${s.modelBtnDisabled}`)
);

// 4. 最终状态
const final = await page.evaluate(() => {
  const mds = [...document.querySelectorAll('.markdown-body')];
  return { mdCount: mds.length, lastMd: mds[mds.length-1]?.textContent?.slice(0,60) };
});
console.log('最终:', JSON.stringify(final));

b.disconnect();
