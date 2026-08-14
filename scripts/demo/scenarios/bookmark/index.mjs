// 场景剧本:收藏 —— 悬停消息 → 一击收藏 → 收藏 tab 揭示展示。
// 种子:主线会话(剧本演示收藏动作 + tab 揭示)。
// 注:收藏动作在隔离录制环境可创建(右面板 tab 揭示、config 落盘),但从收藏展开
// (fork 会话)走 copySession 的路径圈禁——校验用真实 ~/.pi/agent,隔离 HOME 的
// 会话路径越界,机制上不可用(环境限制,非剧本问题)。故本版展示收藏动作 + tab 揭示,
// 不演示 fork。
// 设计文档 §4.8。
import * as seed from "../../lib/seed/presets.mjs";

export default {
  name: "bookmark",
  seed(ctx) {
    const todo = seed.seedTodoProject(ctx);
    seed.seedMainSession(ctx, todo);
    seed.seedRecentCwds(ctx, [todo]);
    ctx.setPrefs({ lastCwd: todo });
  },
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    { do: "hover", target: { css: "[data-message-id]:has(p)", widest: true } },
    { do: "click", target: { i18nKey: "shell.bookmark" }, hold: 2500 },
  ],
};
