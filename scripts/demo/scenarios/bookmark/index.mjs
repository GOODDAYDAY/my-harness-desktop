// 场景剧本:收藏 —— 悬停消息 → 一击收藏 → 收藏 tab 揭示 → 点击收藏行发起(fork)。
// 种子:见 seed.json(主线会话,剧本演示收藏动作 + 发起)。
// 快照收藏(§bookmark-snapshot-fork-unify):收藏时物化中立流前缀成自包含快照,
// 发起时读快照 seed 投影到内核 fork 新会话,不再走 copySession 路径圈禁,隔离 HOME 可跑。
// 设计文档 §4.8。
export default {
  name: "bookmark",
  steps: [
    { do: "hold", ms: 1400 },
    { do: "click", target: { css: "[data-session-path]", nth: 0 }, hold: 1500 },
    { do: "hover", target: { css: "[data-message-id]:has(p)", widest: true } },
    { do: "click", target: { i18nKey: "shell.bookmark" }, hold: 2500 },
    // 发起:点击收藏行 fork 出全新会话(快照 seed 投影,源会话删/压缩后仍可发起)
    { do: "click", target: { css: "[data-bookmark-id]", nth: 0 }, hold: 3000 },
  ],
};
