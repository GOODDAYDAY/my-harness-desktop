// 交互原语 —— 点击之外的动作:键入、拖选、右键、等 agent 往返。
import { sleep, waitForDomIdle } from "./util.mjs";

/** 点进 target 元素并键入文本;submit 则敲 Enter(composer/review 编辑器都是 Enter 语义)。 */
export async function typeText(page, loc, text, { submit = false } = {}) {
  await page.mouse.click(loc.x, loc.y);
  await sleep(120);
  await page.keyboard.type(text, { delay: 18 });
  if (submit) {
    await sleep(120);
    await page.keyboard.press("Enter");
  }
}

/** 在 target 元素矩形内水平拖选(fromFx/toFx 为宽度比例)——触发 review 的 selectionchange 浮钮。 */
export async function selectAcross(page, loc, { fromFx = 0.08, toFx = 0.72 } = {}) {
  const w = loc.width || 200;
  const x0 = loc.x - w / 2 + w * fromFx;
  const x1 = loc.x - w / 2 + w * toFx;
  await page.mouse.move(x0, loc.y);
  await page.mouse.down();
  await page.mouse.move(x1, loc.y, { steps: 12 });
  await page.mouse.up();
  await sleep(250);
}

export async function rightClick(page, x, y) {
  await page.mouse.click(x, y, { button: "right" });
  await sleep(200);
}

/** 等一次 agent 往返:stop 按钮(仅 streaming 存在)出现 → 消失。
 *  事件驱动替代固定 sleep:模型快慢都精确落定。appearMs 含 spawn 冷启动余量。 */
export async function waitAgent(page, stopTitle, { appearMs = 45000, doneMs = 180000 } = {}) {
  const sel = `[title="${stopTitle.replace(/"/g, '\\"')}"]`;
  await page.waitForSelector(sel, { timeout: appearMs });
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: doneMs }, sel);
  await waitForDomIdle(page);
}

/** 可信点击:按**文本**找元素并算中心点,再用 `page.mouse.click` 真点(而非合成 dispatchEvent)。
 *  为什么必须有它:合成 `MouseEvent` 对 Radix/React 的行点击**不可靠**——本仓实测两次翻车
 *  (`session-single-source` 的会话行、`fork-cross-kernel` 的会话行),而同一写法在普通按钮上又
 *  经常没事,于是它成了"潜在风险"而非"必然缺陷"(全仓 19 个 e2e / ~60 处用了合成点击)。
 *  收敛成一个助手,才能**按需增量迁移并逐个验证**,而不是批量替换 60 处、每处都要重新验证。
 *  @returns 是否找到并点了(找不到返回 false,调用方据此判失败,不静默吞) */
export async function clickByText(page, text, { exact = true, nth = -1, timeoutMs = 6000, settle = null, scope = "body *" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // `scope` 必须可指定:会话行有专属锚点(`[data-session-path]`),而 `body *` 会匹配到**消息气泡**
    // 等同样含该文本的元素——实测漏改一处差点点错(原代码就是限定在行锚点内找的)。
    const pt = await page.evaluate(({ t, ex, n, sel }) => {
      const hit = [...document.querySelectorAll(sel)].filter((e) => {
        const s = (e.textContent || "").trim();
        const okText = ex ? s === t : s.includes(t);
        return okText && e.children.length < 6 && e.getBoundingClientRect().width > 0;
      });
      const el = n < 0 ? hit[hit.length - 1] : hit[n];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { t: text, ex: exact, n: nth, sel: scope }).catch(() => null);
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      if (settle) await settle();
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/** 可信点击:按**选择器**取第一个可见元素再真点(行/项点击的通用形态)。 */
export async function clickBySelector(page, selector, { timeoutMs = 6000, settle = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pt = await page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector).catch(() => null);
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      if (settle) await settle();
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/** 反复点一个**算出来的点**，直到 predicate 成立（有界重试）。
 *
 *  为什么需要它（实测）：菜单/弹层刚打开时元素还在动画，`getBoundingClientRect()` 取到的
 *  位置与最终位置不一致 → 可信点击会**打偏**，表现为"点了没反应"。典型现场：
 *  模型下拉的**内核 TAB** 偶发点不中 → 期望的模型项一直不出现 → 断言报"模型没合流"
 *  （看着像内核插件坏了，其实是点击打偏）。全量广扫里这类偶发失败会污染对代码的判断。
 *
 *  做法：算点 → 点 → 每次都重新算（动画结束后位置才稳定）→ 直到 predicate 成立或次数用尽。
 *  最后一次仍不成立时返回 false，让调用方给出**说人话**的失败信息（不吞、不伪造通过）。
 */
export async function clickPointUntil(page, locate, predicate, { tries = 6, settleMs = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    const pt = await page.evaluate(locate).catch(() => null);
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      await sleep(settleMs);
    }
    if (await page.evaluate(predicate).catch(() => false)) return true;
  }
  return false;
}
