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
