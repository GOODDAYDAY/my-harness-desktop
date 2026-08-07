// 场景剧本:收藏 —— 悬停消息 → 一击收藏 → 揭示收藏页签。
// 种子:主线会话(留 1 条已收藏,演示"继续加")。
// 设计文档 §4.8。
export default {
  name: "bookmark",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    { do: "hover", target: { css: "[data-message-id]:has(p)", widest: true } },
    { do: "click", target: { i18nKey: "shell.bookmark" }, hold: 1600 },
  ],
};
