// 点击涟漪 —— "看到点了哪里"的可视化:真点击之前,目标处先脉冲一个圆环。
//
// 视觉:白环 + 中心点,mix-blend-mode: difference —— 深浅主题上都是高对比反色,
// 不挑配色。z-index 顶格 + pointer-events:none,纯观察层不挡交互。
// 拍帧:涟漪期间连续截图(帧时长取真实截图间隔,动画节奏不失真),拍完移除再真点击,
// 结果帧里不留残留 overlay。
import { sleep } from "./util.mjs";

const RIPPLE_FRAMES = 8;
const MIN_FRAME_GAP_MS = 90; // 动画 0.72s/圈,≈90ms/帧能拍出完整脉冲

export async function ripple(page, rec, x, y) {
  await page.evaluate(({ x, y }) => {
    document.getElementById("__pi_demo_ripple__")?.remove();
    const host = document.createElement("div");
    host.id = "__pi_demo_ripple__";
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;overflow:visible;";
    host.innerHTML = `
      <style>
        @keyframes __pi_demo_ring__ {
          0%   { transform: translate(-50%,-50%) scale(0.35); opacity: 0.95; }
          70%  { transform: translate(-50%,-50%) scale(1.15); opacity: 0.55; }
          100% { transform: translate(-50%,-50%) scale(1.5);  opacity: 0; }
        }
        @keyframes __pi_demo_dot__ {
          0%, 100% { transform: translate(-50%,-50%) scale(1); }
          50%      { transform: translate(-50%,-50%) scale(1.45); }
        }
      </style>
      <div style="position:fixed;left:${x}px;top:${y}px;">
        <div style="position:absolute;left:0;top:0;width:56px;height:56px;border-radius:50%;
                    border:3px solid #fff;mix-blend-mode:difference;
                    animation:__pi_demo_ring__ 0.72s ease-out infinite;"></div>
        <div style="position:absolute;left:0;top:0;width:12px;height:12px;border-radius:50%;
                    background:#fff;mix-blend-mode:difference;
                    animation:__pi_demo_dot__ 0.72s ease-in-out infinite;"></div>
      </div>`;
    document.body.appendChild(host);
  }, { x, y });

  const files = [];
  const times = [];
  for (let i = 0; i < RIPPLE_FRAMES; i++) {
    const t0 = Date.now();
    files.push(await rec.shoot());
    times.push(Date.now());
    const elapsed = Date.now() - t0;
    if (i < RIPPLE_FRAMES - 1 && elapsed < MIN_FRAME_GAP_MS) {
      await sleep(MIN_FRAME_GAP_MS - elapsed);
    }
  }
  for (let i = 0; i < files.length; i++) {
    const duration = i < files.length - 1 ? times[i + 1] - times[i] : MIN_FRAME_GAP_MS;
    rec.add(files[i], duration);
  }

  await page.evaluate(() => document.getElementById("__pi_demo_ripple__")?.remove());
}
