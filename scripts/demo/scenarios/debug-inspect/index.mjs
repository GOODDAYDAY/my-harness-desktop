// 场景剧本:debug 巡检 —— 右上角巡检模式 → 点元素复制其 HTML → 粘贴到输入栏看复制内容 → 退出。
// 种子:主线会话(巡检点会话行复制 HTML,输入栏粘贴需要打开的会话);
// debugMode 由基线 general.json 默认开启。
// 展示:巡检模式下点元素会复制其 outerHTML 到剪贴板(debug-bar 既有行为),
// 随后聚焦输入栏 Ctrl+V 把复制内容贴出来——观众看到"复制出来的东西是啥"。
import * as seed from "../../lib/seed/presets.mjs";

export default {
  name: "debug-inspect",
  seed(ctx) {
    const todo = seed.seedTodoProject(ctx);
    seed.seedMainSession(ctx, todo);
    seed.seedRecentCwds(ctx, [todo]);
    ctx.setPrefs({ lastCwd: todo });
  },
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { titleKey: "debug.inspectTitle" }, hold: 1800 },
    // 巡检模式:点一个元素(侧栏会话标题)触发复制
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    // 聚焦输入栏并粘贴,展示复制出的 HTML
    { do: "click", target: { css: "[data-timeline-composer]" }, hold: 600 },
    { do: "press", key: "Control+v", hold: 2000 },
    { do: "clickRightAt", x: 640, y: 420, hold: 800 },
    { do: "hold", ms: 1000 },
  ],
};
