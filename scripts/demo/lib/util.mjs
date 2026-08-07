// 小工具 —— sleep 与 DOM 静默探测。
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 DOM 安静:无 mutation 持续 quietMs 即视为稳定(渲染/动画落定),timeoutMs 兜底放行。
 *  事件驱动替代固定 sleep:React 异步渲染 + framer-motion 入场动画何时结束不靠猜。 */
export async function waitForDomIdle(page, { quietMs = 600, timeoutMs = 15000 } = {}) {
  await page.evaluate(({ quietMs, timeoutMs }) => new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const done = () => {
      if (settled) return;
      settled = true;
      obs.disconnect();
      resolve();
    };
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    timer = setTimeout(done, quietMs);
    setTimeout(done, timeoutMs);
  }), { quietMs, timeoutMs });
}
